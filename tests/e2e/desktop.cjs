const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quotecompare-e2e-'));
  const shots = path.join(root, 'artifacts/e2e');
  await fs.mkdir(shots, { recursive: true });
  const env = { ...process.env, QUOTECOMPARE_E2E: '1', QUOTECOMPARE_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  try {
    const page = await desktop.firstWindow();
    page.on('console', (message) => { if (message.type() === 'error') console.log('UI:', message.text()); });
    page.on('pageerror', (error) => console.log('PAGE ERROR:', error.message));
    const click = (text) => page.getByRole('button', { name: text, exact: true }).click();
    async function noError() { await expect(page.getByRole('alert')).toHaveCount(0); }
    async function waitJob() {
      await expect(page.locator('.job')).toHaveAttribute('data-state', 'succeeded', { timeout: 45000 });
      await noError();
    }
    async function screen(name) { await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: false }); }
    await expect(page.getByRole('heading', { name: '项目与报价资料' })).toBeVisible();
    await click('⚙ 模型设置');
    await page.getByLabel('API Key', { exact: true }).fill('test-only-key-1234');
    await click('保存设置');
    await expect(page.getByText('模型设置已保存。')).toBeVisible();
    await click('测试连接'); await waitJob(); await screen('06-settings');
    await click('Quote Compare');
    await click('＋ 新建项目');
    await page.getByLabel('项目名称', { exact: true }).fill('厨房维修');
    await page.getByLabel('房产', { exact: true }).fill('12 King Street');
    await page.getByLabel('施工需求', { exact: true }).fill('更换橱柜和台面，保留地板，包含垃圾清运');
    await click('保存项目');
    await expect(page.getByRole('heading', { name: '厨房维修', exact: true })).toBeVisible();
    await click('编辑项目');
    await page.getByLabel('项目名称', { exact: true }).fill('厨房翻新');
    await click('保存项目');
    await expect(page.getByRole('heading', { name: '厨房翻新', exact: true })).toBeVisible();
    for (const [filename, name] of [['Contractor-A.pdf', 'A Builders'], ['Contractor-B.png', 'B Repairs']]) {
      await click('＋ 导入报价');
      await page.getByLabel('导入承包商').fill(name);
      await page.getByLabel('导入文件', { exact: true }).setInputFiles(path.join(root, 'artifacts/e2e-fixtures', filename));
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 }); await noError();
    }
    await click('＋ 导入报价');
    await page.getByLabel('导入承包商').fill('C Renovation');
    await page.getByLabel('报价文字').fill(await fs.readFile(path.join(root, 'artifacts/e2e-fixtures/Contractor-C.txt'), 'utf8'));
    await click('导入文字报价');
    await expect(page.locator('.quote-card')).toHaveCount(3);
    await screen('01-materials');
    await click('AI 提取全部报价'); await waitJob();
    await click('核对');
    const quotes = await page.evaluate(() => [...document.querySelector('[aria-label="核对报价"]').options].map((option) => option.value));
    for (const quote of quotes) {
      await page.getByLabel('核对报价').selectOption(quote);
      await expect(page.locator('.fields-panel')).toHaveAttribute('data-quote-id', quote);
      await expect(page.getByLabel('规范值 0', { exact: true })).toBeEnabled();
      await click('全部确认'); await click('保存核对');
      await expect(page.getByText('核对结果已保存；报价发生变化后需重新保存字段归并。')).toBeVisible();
      await noError();
    }
    await screen('02-review');
    await click('AI 汇总字段'); await waitJob();
    await click('全部确认归并'); await click('保存统一字段');
    await expect(page.getByText('统一字段已保存。')).toBeVisible();
    await click('对比'); await click('确认并保存对比');
    await noError();
    await expect(page.locator('table tbody tr')).not.toHaveCount(0);
    await expect(page.getByText('— 未提供').first()).toBeVisible();
    await expect(page.getByText('目前无法直接比较最终总成本，请先确认缺失项和价格口径。', { exact: true })).toBeVisible();
    await noError(); await screen('03-comparison');
    await page.locator('.cell-value').filter({ hasText: '1200' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Total GBP 1200');
    await page.locator('.modal .close').click();
    await click('追问');
    await click('生成邮件草稿'); await waitJob();
    await expect(page.getByLabel('邮件正文')).not.toHaveValue('');
    await page.getByLabel('邮件主题').fill('Questions about your quote');
    await click('保存草稿'); await expect(page.getByText('草稿已保存。')).toBeVisible();
    await click('复制邮件');
    const clipboard = await desktop.evaluate(({ clipboard }) => clipboard.readText());
    expect(clipboard).toContain('Questions about your quote');
    await screen('04-questions');
    await click('导出报告 ↗');
    await page.getByLabel('隐藏房产名称 / 地址').check();
    await click('生成报告预览'); await waitJob();
    await expect(page.getByTitle('报告预览')).toBeVisible();
    const previewText = await page.frameLocator('iframe').locator('body').innerText();
    expect(previewText).toContain('报价对比报告'); expect(previewText).not.toContain('12 King Street');
    await screen('05-report');
    // Exercise the real save-file IPC, substituting only the OS dialog selection in this test.
    const savedPdf = path.join(directory, 'export.pdf');
    await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, savedPdf);
    await click('保存文件到 Mac'); await expect(page.getByText('报告已保存。')).toBeVisible();
    expect((await fs.readFile(savedPdf)).subarray(0, 4).toString()).toBe('%PDF');
    await page.getByLabel('报告格式').selectOption('csv');
    await click('生成报告预览'); await waitJob();
    const savedCsv = path.join(directory, 'export.csv');
    await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, savedCsv);
    await click('保存文件到 Mac'); await expect(page.getByText('报告已保存。')).toBeVisible();
    expect(await fs.readFile(savedCsv, 'utf8')).toContain('A Builders');
    await click('◷ 用量与费用');
    await expect(page.locator('.metrics').first()).toContainText('6');
    await screen('07-usage');
    // Both remaining providers use their actual client request/response formats through HTTP.
    for (const provider of ['claude', 'deepseek']) {
      await click('⚙ 模型设置');
      await page.getByLabel('模型服务商').selectOption(provider);
      await page.getByLabel('API Key', { exact: true }).fill('test-only-key-' + provider);
      await click('保存设置'); await expect(page.getByText('模型设置已保存。')).toBeVisible();
      await click('测试连接'); await waitJob();
    }
    await click('◷ 用量与费用');
    await expect(page.locator('.balance-card')).toContainText('38.40 CNY');
    await screen('07-usage');
    await click('Quote Compare'); await click('追问');
    await expect(page.getByLabel('邮件主题')).toHaveValue('Questions about your quote');
    // Renderer reload verifies persistence and draft restoration without a new model call.
    await page.reload();
    await expect(page.getByRole('heading', { name: '项目与报价资料' })).toBeVisible();
    await click('追问'); await expect(page.getByLabel('邮件主题')).toHaveValue('Questions about your quote');
    await noError();
    console.log('PASS: seven screens, real PDF/image OCR/text import, review, union comparison, evidence, draft edit/copy/restore, PDF/CSV save, provider switch, usage/balance.');
    console.log('Temporary test data:', directory);
  } catch (error) { const page = await desktop.firstWindow(); await page.screenshot({ path: path.join(shots, 'failure.png') }); console.log((await page.locator('body').innerText()).slice(-7000)); throw error; } finally { await desktop.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
