const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixtures = path.join(root, 'artifacts/e2e-fixtures');
const results = [];
let desktop, page, directory;
const click = (name) => page.getByRole('button', { name, exact: true }).click();
const call = (operation, args = {}) => page.evaluate(([name, args]) => window.desktop.api(name, args), [operation, args]);
async function check(name, action) {
  await action();
  results.push({ name, status: 'passed' });
  console.log('PASS:', name);
}
async function waitJob(state = 'succeeded') {
  await expect(page.locator('.job')).toHaveAttribute('data-state', state, { timeout: 45000 });
}
async function closeError() {
  await page.getByRole('alert').getByRole('button').click();
}
async function settings(provider, key) {
  await click('⚙ 模型设置');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await page.getByLabel('模型服务商').selectOption(provider);
  if (key) await page.getByLabel('API Key', { exact: true }).fill(key);
  await click('保存设置');
  await expect(page.getByText('模型设置已保存。')).toBeVisible();
  expect((await call('settings')).provider).toBe(provider);
}
async function createProject(name) {
  await click('Quote Compare'); await click('＋ 新建项目');
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  await page.getByLabel('房产', { exact: true }).fill('12 King Street');
  await page.getByLabel('施工需求', { exact: true }).fill('更换橱柜，包含清运');
  await click('保存项目');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return page.getByLabel('当前项目').inputValue();
}
async function importText(name, text) {
  await click('＋ 导入报价');
  await page.getByLabel('导入承包商').fill(name);
  await page.getByLabel('报价文字').fill(text);
  await click('导入文字报价');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function launch() {
  const env = { ...process.env, QUOTECOMPARE_E2E: '1', QUOTECOMPARE_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  page = await desktop.firstWindow();
  page.on('pageerror', (error) => { results.push({ name: 'renderer exception', status: 'failed', error: error.message }); });
  await expect(page.getByRole('heading', { name: '项目与报价资料' })).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ 新建项目', exact: true })).toBeEnabled();
}

async function main() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quotecompare-coverage-'));
  await fs.mkdir(path.join(root, 'artifacts/e2e'), { recursive: true });
  await launch();
  try {
    await check('Empty workspace, settings without a key, unavailable balance', async () => {
      expect((await call('health')).max_quotes).toBe(5);
      await expect(page.getByText('开始第一次报价比较')).toBeVisible();
      await click('⚙ 模型设置');
      await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
      await click('◷ 用量与费用');
      await expect(page.locator('.balance-card')).toContainText('尚未配置');
      await expect(page.locator('.metrics').first()).toContainText('0');
    });
    let projectId;
    await check('Project create/edit and active/completed/archived status', async () => {
      projectId = await createProject('完整功能验收');
      await click('编辑项目');
      await page.getByLabel('施工需求', { exact: true }).fill('更换橱柜和台面，保留地板');
      await expect(page.getByLabel('比较币种')).toBeDisabled();
      await click('保存项目');
      await expect(page.getByText('更换橱柜和台面，保留地板', { exact: true })).toBeVisible();
      for (const status of ['completed', 'archived', 'active']) {
        await page.getByLabel('项目状态').selectOption(status);
        await expect(page.getByLabel('项目状态')).toHaveValue(status);
        expect((await call('project', { id: projectId })).status).toBe(status);
      }
    });
    await check('Native file picker cancel/import, image file input, text paste', async () => {
      await click('＋ 导入报价');
      await desktop.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      await click('选择 PDF / 图片文件');
      await expect(page.getByRole('dialog')).toBeVisible();
      const filename = path.join(fixtures, 'Contractor-A.pdf');
      await desktop.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename);
      await page.getByLabel('导入承包商').fill('A Builders');
      await click('选择 PDF / 图片文件');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await click('＋ 导入报价');
      await page.getByLabel('导入承包商').fill('B Repairs');
      await page.getByLabel('导入文件', { exact: true }).setInputFiles(path.join(fixtures, 'Contractor-B.png'));
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
      await importText('C Renovation', await fs.readFile(path.join(fixtures, 'Contractor-C.txt'), 'utf8'));
      await expect(page.locator('.quote-card')).toHaveCount(3);
    });
    await check('Duplicate import, malformed PDF, 31-page PDF, 51MB file rejected', async () => {
      await click('＋ 导入报价');
      await page.getByLabel('导入文件', { exact: true }).setInputFiles(path.join(fixtures, 'Contractor-A.pdf'));
      await expect(page.getByRole('alert')).toContainText('已经导入'); await closeError();
      for (const filename of ['Invalid.pdf', 'Too-many-pages.pdf', 'Encrypted.pdf', 'Blank.png']) {
        await page.getByLabel('导入文件', { exact: true }).setInputFiles(path.join(fixtures, filename));
        await expect(page.getByRole('alert')).toBeVisible(); await closeError();
      }
      const largeFile = path.join(directory, 'large.png');
      const handle = await fs.open(largeFile, 'w'); await handle.truncate(51 * 1024 * 1024); await handle.close();
      await page.getByLabel('导入文件', { exact: true }).setInputFiles(largeFile);
      await expect(page.getByRole('alert')).toContainText('50MB'); await closeError();
      await page.locator('.modal .close').click();
      await expect(page.locator('.quote-card')).toHaveCount(3);
    });
    await check('Missing API key surfaces actionable UI error without extraction', async () => {
      await click('AI 提取全部报价');
      await expect(page.getByRole('alert')).toContainText('API Key'); await closeError();
      await expect(page.locator('.quote-card').first()).toContainText('已导入');
    });
    await settings('openai', 'test-valid');
    await click('Quote Compare'); await click('AI 提取全部报价'); await waitJob();
    let quoteIds;
    await check('Review source image/highlight, all fact types, manual add/remove/save', async () => {
      await click('核对');
      quoteIds = await page.getByLabel('核对报价').locator('option').evaluateAll((options) => options.map((option) => option.value));
      await page.getByLabel('核对报价').selectOption(quoteIds[0]);
      await expect(page.locator('.fields-panel')).toHaveAttribute('data-quote-id', quoteIds[0]);
      await expect(page.locator('.source-image img')).toBeVisible();
      await page.getByLabel('规范值 0', { exact: true }).fill('bad amount');
      await click('保存核对'); await expect(page.getByRole('alert')).toContainText('十进制'); await closeError();
      await page.getByLabel('规范值 0', { exact: true }).fill('650');
      await page.getByLabel('承包商名称', { exact: true }).fill('A Builders Edited');
      const field = page.locator('.field-card').first();
      await field.getByLabel('施工工项', { exact: true }).fill('kitchen_cabinets');
      await field.getByLabel('单位', { exact: true }).fill('job');
      await field.getByLabel('币种', { exact: true }).fill('gbp');
      await field.getByLabel('税费').selectOption('included');
      await field.getByLabel('包含口径').selectOption('bundled');
      await field.click();
      await expect(page.locator('.source-text.focus').first()).toBeVisible();
      await click('＋ 新增字段');
      const added = page.locator('.field-card').last();
      await added.locator('input').first().fill('是否包含保护措施');
      await added.getByLabel(/^规范值 /).fill('true');
      await added.getByLabel('值类型').selectOption('boolean');
      await added.getByLabel(/^字段含义 /).selectOption('scope');
      await added.getByLabel('核对状态').selectOption('confirmed');
      await click('＋ 新增字段'); await page.locator('.field-card').last().getByRole('button', { name: '移除字段' }).click();
      for (const [name, value, type, kind] of [['数量', '2', 'decimal', 'quantity'], ['完工日期', '2026-11-01', 'date', 'term'], ['保修时长', '2 years', 'duration', 'term'], ['未注明材料', '', 'text', 'material']]) {
        await click('＋ 新增字段');
        const field = page.locator('.field-card').last();
        await field.locator('input').first().fill(name);
        await field.getByLabel(/^规范值 /).fill(value);
        await field.getByLabel('值类型').selectOption(type);
        await field.getByLabel(/^字段含义 /).selectOption(kind);
      }
      await click('全部确认'); await click('保存核对');
      await expect(page.getByText('核对结果已保存；报价发生变化后需重新保存字段归并。')).toBeVisible();
      const quote = await call('quote', { id: quoteIds[0] });
      expect(quote.facts[0].normalized_value).toBe('650');
      expect(quote.extracted_facts[0].normalized_value).toBe('600');
      expect(quote.facts.find((fact) => fact.raw_label === '是否包含保护措施').normalized_value).toBe('true');
      for (const qid of quoteIds.slice(1)) {
        await page.getByLabel('核对报价').selectOption(qid);
        await expect(page.locator('.fields-panel')).toHaveAttribute('data-quote-id', qid);
        await click('全部确认'); await click('保存核对');
        await expect(page.getByText('核对结果已保存；报价发生变化后需重新保存字段归并。')).toBeVisible();
      }
    });
    await check('Re-extraction requires confirmation and cancel preserves manual edits', async () => {
      await page.getByLabel('核对报价').selectOption(quoteIds[0]);
      await expect(page.locator('.fields-panel')).toHaveAttribute('data-quote-id', quoteIds[0]);
      await click('重新提取');
      await expect(page.getByRole('dialog')).toContainText('替换人工核对');
      await page.locator('.modal .close').click();
      expect((await call('quote', { id: quoteIds[0] })).facts[0].normalized_value).toBe('650');
    });
    await check('Field union, rename, incompatible merge refusal, split and compatible merge', async () => {
      await click('AI 汇总字段'); await waitJob();
      const rows = page.locator('.mapping-row');
      await expect(rows.first()).toBeVisible();
      const count = await rows.count();
      await rows.first().locator('input').fill('自定义施工字段');
      const target = await rows.first().getByLabel('归并到 0').locator('option').nth(1).getAttribute('value');
      await rows.first().getByLabel('归并到 0').selectOption(target);
      await expect(page.getByRole('alert')).toContainText('口径'); await closeError();
      const total = rows.filter({ has: page.locator('input[value="总价"]') }).first();
      await total.getByRole('button', { name: '拆分', exact: true }).click();
      await expect(rows).toHaveCount(count + 1);
      const split = rows.filter({ has: page.locator('input[value="总价"]') });
      const nextId = await split.nth(1).getByRole('combobox').last().getAttribute('aria-label');
      const index = Number(nextId.split(' ').at(-1));
      const mappings = await call('mappings', { id: projectId });
      // Select the sibling's freshly generated ID from the source selector's matching option.
      const options = await split.first().getByRole('combobox').last().locator('option').evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
      const sibling = options.find((option) => option.text === '总价');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(mappings.groups.length).toBe(count);
      await split.first().getByRole('combobox').last().selectOption(sibling.value);
      await expect(rows).toHaveCount(count);
      await click('保存统一字段'); await expect(page.getByText('统一字段已保存。')).toBeVisible();
    });
    let pendingSnapshot, confirmedSnapshot;
    await check('Pending comparison explicit approval, full union and all cell states/filters', async () => {
      await click('对比'); await click('确认并保存对比');
      await expect(page.getByRole('dialog')).toContainText('保留待确认项');
      await click('保留待确认项并保存');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      pendingSnapshot = await page.getByLabel('对比历史').inputValue();
      await expect(page.locator('td.pending').first()).toBeVisible();
      await click('核对'); await click('全部确认归并'); await click('保存统一字段');
      await expect(page.getByText('统一字段已保存。')).toBeVisible();
      await click('对比'); await click('确认并保存对比');
      await expect(page.getByLabel('对比历史')).not.toHaveValue(pendingSnapshot);
      confirmedSnapshot = await page.getByLabel('对比历史').inputValue();
      expect(confirmedSnapshot).not.toBe(pendingSnapshot);
      await expect(page.locator('td.bundled').first()).toBeVisible();
      await expect(page.locator('td.not_comparable').first()).toBeVisible();
      await expect(page.locator('.cell-value').filter({ hasText: /^包含/ }).first()).toBeVisible();
      await expect(page.locator('td.missing').first()).toBeVisible();
      const full = await page.locator('tbody tr').count();
      await click('只看差异');
      expect(await page.locator('tbody tr').count()).toBeLessThanOrEqual(full);
      await click('缺失与待确认');
      expect(await page.locator('tbody tr').count()).toBeGreaterThan(0);
      await click('全部字段');
      await expect(page.locator('tbody tr')).toHaveCount(full);
      await page.getByLabel('对比历史').selectOption(pendingSnapshot);
      await expect(page.locator('td.pending').first()).toBeVisible();
      await page.getByLabel('对比历史').selectOption(confirmedSnapshot);
      await expect(page.locator('td.bundled').first()).toBeVisible();
      await page.locator('.cell-value').filter({ hasText: /^— 未提供/ }).first().click();
      await expect(page.getByRole('dialog')).toContainText('该字段未提供');
      await page.locator('.modal .close').click();
    });
    await check('Question deselection, contractor switch, Chinese draft editing/copy/restore', async () => {
      await click('追问'); await page.getByLabel('追问承包商').selectOption(quoteIds[1]);
      const questions = page.locator('.check-question input');
      const count = await questions.count();
      expect(count).toBeGreaterThan(0);
      for (const question of await questions.all()) await question.uncheck();
      await expect(page.getByRole('button', { name: '生成邮件草稿', exact: true })).toBeDisabled();
      await questions.first().check();
      await page.getByLabel('邮件语言').selectOption('zh-CN');
      await click('生成邮件草稿'); await waitJob();
      await expect(page.getByLabel('邮件正文')).toHaveValue(/你好/);
      await page.getByLabel('邮件正文').fill('请明确 VAT 和施工工期。');
      await page.getByLabel('邮件主题').fill('人工编辑的追问');
      await click('保存草稿'); await expect(page.getByText('草稿已保存。')).toBeVisible();
      await click('复制邮件');
      expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe('人工编辑的追问\n\n请明确 VAT 和施工工期。');
      await page.getByLabel('追问承包商').selectOption(quoteIds[0]);
      await expect(page.getByLabel('邮件正文')).toHaveCount(0);
      await page.getByLabel('追问承包商').selectOption(quoteIds[1]);
      await expect(page.getByLabel('邮件正文')).toHaveValue('请明确 VAT 和施工工期。');
    });
    await check('Report source/question/privacy toggles, PDF/CSV files and save cancellation', async () => {
      await click('导出报告 ↗');
      await page.getByLabel('附带原文依据（文字）').uncheck();
      await page.getByLabel('附带追问清单').uncheck();
      await page.getByLabel('隐藏房产名称 / 地址').check();
      await click('生成报告预览'); await waitJob();
      let text = await page.frameLocator('iframe').locator('body').innerText();
      expect(text).not.toContain('原文依据（文字）'); expect(text).not.toContain('承包商追问'); expect(text).not.toContain('12 King Street');
      const cancelled = path.join(directory, 'must-not-exist.pdf');
      await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: filename }); }, cancelled);
      await click('保存文件到 Mac');
      await expect.poll(() => fs.stat(cancelled).then(() => true, () => false)).toBe(false);
      for (const format of ['pdf', 'csv']) {
        await page.getByLabel('报告格式').selectOption(format);
        await page.getByLabel('附带原文依据（文字）').check();
        await page.getByLabel('附带追问清单').check();
        await page.getByLabel('隐藏房产名称 / 地址').uncheck();
        await click('生成报告预览'); await waitJob();
        text = await page.frameLocator('iframe').locator('body').innerText();
        expect(text).toContain('原文依据（文字）'); expect(text).toContain('承包商追问'); expect(text).toContain('12 King Street');
        const filename = path.join(directory, 'full-report.' + format);
        await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, filename);
        await click('保存文件到 Mac'); await expect(page.getByText('报告已保存。')).toBeVisible();
        const content = await fs.readFile(filename);
        if (format === 'pdf') expect(content.subarray(0, 4).toString()).toBe('%PDF');
        else expect(content.toString('utf8')).toContain('自定义施工字段');
      }
    });
    await check('Usage date/provider/generation filters, balance refresh and official billing IPC', async () => {
      await click('◷ 用量与费用');
      await expect(page.locator('tbody tr').first()).toBeVisible();
      const usage = await call('usage');
      await page.getByLabel('用量服务商').selectOption('claude'); await click('应用筛选');
      await expect(page.locator('tbody tr')).toHaveCount(0);
      await page.getByLabel('用量服务商').selectOption('openai');
      await page.getByLabel('配置代际').fill('99999'); await click('应用筛选');
      await expect(page.locator('tbody tr')).toHaveCount(0);
      await page.getByLabel('配置代际').fill(String(usage.calls[0].connection_generation));
      await page.getByLabel('用量开始日期').fill('2020-01-01'); await page.getByLabel('用量结束日期').fill('2030-01-01');
      await click('应用筛选'); await expect(page.locator('tbody tr').first()).toBeVisible();
      await page.getByLabel('用量开始日期').fill('2030-01-01'); await page.getByLabel('用量结束日期').fill('2020-01-01');
      await click('应用筛选'); await expect(page.getByRole('alert')).toContainText('时间范围'); await closeError();
      await page.getByLabel('用量开始日期').fill(''); await page.getByLabel('用量结束日期').fill(''); await page.getByLabel('配置代际').fill(''); await page.getByLabel('用量服务商').selectOption('');
      await settings('deepseek', 'test-valid'); await click('◷ 用量与费用');
      await expect(page.locator('.balance-card')).toContainText('38.40 CNY');
      await click('查询最新余额'); await expect(page.locator('.balance-card')).toContainText('已查询');
      await desktop.evaluate(({ shell }) => { shell.openExternal = async (url) => { globalThis.openedBilling = url; }; });
      await click('打开官方账单 ↗');
      expect(await desktop.evaluate(() => globalThis.openedBilling)).toBe('https://platform.deepseek.com/usage');
      await settings('deepseek', 'test-balance-error'); await click('◷ 用量与费用');
      await expect(page.locator('.balance-card')).toContainText('查询失败');
    });
    await check('Provider 401, invalid model JSON, unknown usage are visible and never auto-retried', async () => {
      for (const [key, finalState, message] of [['test-denied', 'failed', 'API Key 无效'], ['test-invalid-json', 'failed', 'JSON'], ['test-unknown-usage', 'succeeded', null]]) {
        await settings('openai', key);
        const before = (await call('usage')).summary.call_count;
        await click('测试连接'); await waitJob(finalState);
        if (message) { await expect(page.getByRole('alert')).toContainText(message); await closeError(); }
        const after = await call('usage');
        expect(after.summary.call_count).toBe(before + 1);
        if (!message) expect(after.summary.unknown_usage_calls).toBeGreaterThan(0);
        await page.reload(); await expect(page.getByRole('button', { name: '＋ 新建项目', exact: true })).toBeEnabled();
        expect((await call('usage')).summary.call_count).toBe(before + 1);
      }
    });
    await settings('openai', 'test-valid');
    await check('All three provider clients extract through actual desktop flows', async () => {
      const providerProject = await createProject('Provider protocol checks');
      await importText('Provider quote', 'Total GBP 1200\nVAT included');
      for (const provider of ['openai', 'claude', 'deepseek']) {
        await settings(provider, 'test-valid'); await click('Quote Compare');
        await click('AI 提取全部报价'); await waitJob();
        const project = await call('project', { id: providerProject });
        const quote = await call('quote', { id: project.quotes[0].id });
        expect(quote.facts[0].normalized_value).toBe('1200');
      }
    });
    await check('Confirmed re-extraction replaces saved manual data only after explicit approval', async () => {
      await click('Quote Compare'); await click('核对');
      await expect(page.getByLabel('规范值 0', { exact: true })).toBeEnabled();
      await page.getByLabel('规范值 0', { exact: true }).fill('1350');
      await page.getByLabel('核对状态 0', { exact: true }).selectOption('pending');
      await click('保存核对'); await expect(page.getByText('核对结果已保存；报价发生变化后需重新保存字段归并。')).toBeVisible();
      await click('重新提取'); await expect(page.getByRole('dialog')).toContainText('替换人工核对');
      await click('确认替换并提取'); await waitJob();
      await click('核对'); await expect(page.getByLabel('规范值 0', { exact: true })).toHaveValue('1200');
    });
    await check('Scanned PDF, JPEG/WebP OCR, source highlighting and original download', async () => {
      await createProject('Source formats');
      for (const filename of ['Scanned.pdf', 'Contractor-B.jpg', 'Contractor-B.webp']) {
        await click('＋ 导入报价');
        await page.getByLabel('导入文件', { exact: true }).setInputFiles(path.join(fixtures, filename));
        await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
      }
      await click('AI 提取全部报价'); await waitJob(); await click('核对');
      await page.getByLabel('规范值 0', { exact: true }).click();
      await expect(page.locator('.highlight').first()).toBeVisible();
      await page.locator('.source-text').first().click();
      await expect(page.locator('.field-card.focus')).toBeVisible();
      const filename = path.join(directory, 'original-scanned.pdf');
      await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, filename);
      await click('保存原件');
      await expect.poll(() => fs.readFile(filename).then((data) => data.subarray(0, 4).toString(), () => '')).toBe('%PDF');
    });
    await check('Comparable totals, currency and tax flags, stale mappings and snapshot history', async () => {
      const comparedProject = await createProject('Comparable totals');
      for (const [name, amount] of [['One', 1000], ['Two', 1100]]) await importText(name, 'Total GBP ' + amount + '\nVAT included\nWaste removal: Included\nPayment terms: 30% deposit\nDuration: 2 weeks\nMaterials: Laminate');
      await click('AI 提取全部报价'); await waitJob(); await click('核对');
      const quoteIds = await page.getByLabel('核对报价').locator('option').evaluateAll((options) => options.map((option) => option.value));
      for (const qid of quoteIds) {
        await page.getByLabel('核对报价').selectOption(qid); await expect(page.locator('.fields-panel')).toHaveAttribute('data-quote-id', qid);
        await click('全部确认'); await click('保存核对'); await expect(page.getByText('核对结果已保存；报价发生变化后需重新保存字段归并。')).toBeVisible();
      }
      await click('AI 汇总字段'); await waitJob(); await click('全部确认归并'); await click('保存统一字段');
      await expect(page.getByText('统一字段已保存。')).toBeVisible(); await click('对比'); await click('确认并保存对比');
      await expect(page.getByText('总价口径一致，可结合施工范围比较。', { exact: true })).toBeVisible();
      const old = await page.getByLabel('对比历史').inputValue();
      await click('核对'); await page.getByLabel('核对报价').selectOption(quoteIds[1]); await expect(page.locator('.fields-panel')).toHaveAttribute('data-quote-id', quoteIds[1]);
      await page.locator('.field-card').first().getByLabel('币种', { exact: true }).fill('EUR');
      await page.locator('.field-card').first().getByLabel('税费').selectOption('unknown');
      await click('保存核对'); await expect(page.getByText('核对结果已保存；报价发生变化后需重新保存字段归并。')).toBeVisible();
      await click('对比'); await click('确认并保存对比'); await expect(page.getByRole('alert')).toContainText('归并已过期'); await closeError();
      await click('核对'); await click('AI 汇总字段'); await waitJob(); await click('全部确认归并'); await click('保存统一字段');
      await expect(page.getByText('统一字段已保存。')).toBeVisible(); await click('对比'); await click('确认并保存对比');
      await expect(page.getByLabel('对比历史')).not.toHaveValue(old);
      await expect(page.locator('.flags')).toContainText('报价币种与项目币种不同'); await expect(page.locator('.flags')).toContainText('VAT 未注明');
      await page.getByLabel('对比历史').selectOption(old); await expect(page.getByText('这是一份历史快照；当前报价已更新。重新确认可生成新对比。')).toBeVisible();
      const history = await call('comparisons', { id: comparedProject, query: { limit: 1 } });
      const more = await call('comparisons', { id: comparedProject, query: { limit: 1, cursor: history.next_cursor } });
      expect(more.items[0].id).not.toBe(history.items[0].id);
    });
    await check('Single config key keep/clear/switch, connection button guards', async () => {
      await settings('openai', 'test-valid');
      await settings('openai', '');
      expect((await call('settings')).has_key).toBe(true);
      await settings('claude', '');
      expect((await call('settings')).has_key).toBe(false);
      await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
      await settings('claude', 'test-valid'); await click('删除密钥');
      await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
      expect((await call('settings')).has_key).toBe(false);
      await settings('openai', 'test-valid');
    });
    await check('Five quote cap, quote deletion, project switch, snapshot original retained', async () => {
      const limitProject = await createProject('Five quote limit');
      for (let index = 0; index < 5; index++) await importText('Limit ' + index, 'Total GBP ' + (1000 + index));
      await expect(page.locator('.quote-card')).toHaveCount(5);
      await click('＋ 导入报价'); await page.getByLabel('报价文字').fill('Total GBP 2000');
      await click('导入文字报价'); await expect(page.getByRole('alert')).toContainText('五份'); await closeError(); await page.locator('.modal .close').click();
      await page.locator('.quote-card').first().getByRole('button', { name: '删除', exact: true }).click();
      await click('确认删除'); await expect(page.locator('.quote-card')).toHaveCount(4);
      expect((await call('project', { id: limitProject })).quotes.length).toBe(4);
      await page.getByLabel('当前项目').selectOption(projectId);
      await expect(page.getByRole('heading', { name: '完整功能验收', exact: true })).toBeVisible();
      await page.locator('.quote-card').first().getByRole('button', { name: '删除', exact: true }).click();
      await click('确认删除'); await expect(page.locator('.quote-card')).toHaveCount(2);
      await page.locator('.history-row').first().click();
      await expect(page.getByText('这是一份历史快照；当前报价已更新。重新确认可生成新对比。')).toBeVisible();
      await page.locator('.cell-value').filter({ hasText: '650' }).first().click();
      await expect(page.getByRole('dialog')).toContainText('Kitchen cabinets: 600');
      await expect(page.getByRole('dialog').locator('img')).toBeVisible();
      await page.locator('.modal .close').click();
    });
    let cancelProject;
    await check('Partial extraction failure, manual retry, task cancellation and busy UI', async () => {
      cancelProject = await createProject('Task failures');
      await importText('Good', 'Total GBP 1200\nVAT included');
      await importText('Bad', 'Total GBP 1000\nMODEL_FAIL');
      await click('AI 提取全部报价'); await waitJob('partial_failed');
      await expect(page.getByRole('alert')).toContainText('额度'); await closeError();
      await expect(page.locator('.quote-card').filter({ hasText: 'Good' })).toContainText('等待核对');
      await expect(page.locator('.quote-card').filter({ hasText: 'Bad' })).toContainText('提取失败');
      await page.locator('.quote-card').filter({ hasText: 'Bad' }).getByRole('button', { name: '删除', exact: true }).click();
      await click('确认删除'); await expect(page.locator('.quote-card')).toHaveCount(1);
      await importText('Slow', 'Total GBP 900\nMODEL_DELAY');
      await click('AI 提取全部报价');
      await expect(page.locator('.job')).toHaveAttribute('data-state', 'running');
      await expect(page.getByLabel('当前项目')).toBeDisabled();
      await expect(page.getByRole('button', { name: '编辑项目', exact: true })).toBeDisabled();
      const activeJob = await page.evaluate(() => localStorage.getItem('active-job'));
      await expect.poll(async () => (await call('usage', { query: { limit: 100 } })).calls.some((call) => call.job_id === activeJob && call.outcome === 'unknown')).toBe(true);
      await click('⚙ 模型设置'); await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
      await click('取消任务'); await waitJob('cancelled');
      await expect(page.getByRole('alert')).toContainText('取消'); await closeError();
      await click('Quote Compare');
      const current = await call('project', { id: cancelProject });
      const slow = current.quotes.find((quote) => quote.contractor_name === 'Slow');
      expect((await call('quote', { id: slow.id })).facts).toEqual([]);
    });
    await check('Crash/restart marks interrupted, restores project and never auto-retries', async () => {
      await importText('Restart', 'Total GBP 800\nMODEL_RESTART');
      const current = await call('project', { id: cancelProject });
      const restart = current.quotes.find((quote) => quote.contractor_name === 'Restart');
      const job = await call('createJob', { body: { request_id: 'restart-test', kind: 'extraction', project_id: cancelProject, expected_revision: current.revision, quote_ids: [restart.id] } });
      await expect.poll(async () => (await call('job', { id: job.id })).state).toBe('running');
      await expect.poll(async () => (await call('usage', { query: { limit: 100 } })).calls.some((call) => call.job_id === job.id && call.outcome === 'unknown')).toBe(true);
      const before = (await call('usage')).summary.call_count;
      await page.evaluate((id) => localStorage.setItem('active-job', id), job.id);
      const processes = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' });
      const backend = processes.split('\n').find((line) => line.includes('tests.e2e.server --data-dir ' + directory));
      expect(backend).toBeTruthy();
      process.kill(Number(backend.trim().split(/\s+/)[0]), 'SIGKILL');
      await desktop.close(); desktop = null;
      await launch();
      await expect(page.locator('.job')).toHaveAttribute('data-state', 'interrupted');
      expect((await call('usage')).summary.call_count).toBe(before);
      expect((await call('quote', { id: restart.id })).facts).toEqual([]);
      expect((await call('quote', { id: restart.id })).status).toBe('imported');
      expect((await call('settings')).has_key).toBe(true);
    });
    await check('Project deletion leaves usage ledger and removes project/files/history', async () => {
      await page.getByLabel('当前项目').selectOption(cancelProject);
      await expect(page.getByRole('heading', { name: 'Task failures', exact: true })).toBeVisible();
      const before = (await call('usage')).summary.call_count;
      await click('删除项目'); await expect(page.getByRole('dialog')).toContainText('用量记录仍保留');
      await click('确认删除'); await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(call('project', { id: cancelProject })).rejects.toThrow('不存在');
      expect((await call('usage')).summary.call_count).toBe(before);
      await expect(page.getByLabel('当前项目').locator('option[value="' + cancelProject + '"]')).toHaveCount(0);
    });
    await check('Real HTTP session protection, IPC validation, revisions and request replay conflicts', async () => {
      const origin = await fs.readFile(path.join(directory, 'test-origin.txt'), 'utf8');
      expect((await fetch(origin + '/api/v1/health')).status).toBe(401);
      expect((await fetch(origin + '/api/v1/health', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      await expect(call('unrecognized')).rejects.toThrow('不支持');
      await expect(call('file', { id: '../settings' })).rejects.toThrow('编号');
      await expect(call('file', { id: 'missing-file' })).rejects.toThrow('不存在');
      await expect(page.evaluate(() => window.desktop.copy('x'.repeat(25001)))).rejects.toThrow('复制');
      await expect(page.evaluate(() => window.desktop.billing('unknown'))).rejects.toThrow('服务商');
      const request = { request_id: 'replay-project', name: 'Replay', scope: '', currency: 'GBP' };
      expect((await call('createProject', { body: request })).id).toBe('replay-project');
      expect((await call('createProject', { body: request })).id).toBe('replay-project');
      await expect(call('createProject', { body: { ...request, name: 'Different' } })).rejects.toThrow('不同内容');
      await call('updateProject', { id: 'replay-project', body: { expected_revision: 1, name: 'Changed' } });
      await expect(call('updateProject', { id: 'replay-project', body: { expected_revision: 1, name: 'Stale' } })).rejects.toThrow('更新');
      await expect(call('projects', { query: { limit: 101 } })).rejects.toThrow('1–100');
      const page1 = await call('projects', { query: { limit: 1 } });
      const page2 = await call('projects', { query: { limit: 1, cursor: page1.next_cursor } });
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
    await check('Project, snapshot and usage lists remain complete beyond the 100-item page limit', async () => {
      await call('createProject', { body: { request_id: 'pagination-project', name: 'Pagination', scope: '', currency: 'GBP' } });
      let revision = 1;
      const members = [];
      for (const [id, amount] of [['page-a', '1000'], ['page-b', '1100']]) {
        const imported = await call('importQuote', { id: 'pagination-project', body: { request_id: id, expected_revision: revision, source_type: 'text', text: 'Total GBP ' + amount } });
        const fact = { id, raw_label: 'Total', raw_value: null, normalized_value: amount, value_type: 'decimal', semantic_kind: 'project_total', entity_key: null, unit: null, currency: 'GBP', tax_basis: 'included', coverage: 'separate', source_refs: [], origin: 'manual', review_status: 'confirmed' };
        revision = (await call('updateQuote', { id, body: { expected_revision: imported.project_revision, facts: [fact] } })).project_revision;
        members.push({ quote_id: id, fact_id: id });
      }
      const mapping = await call('saveMappings', { id: 'pagination-project', body: { expected_revision: revision, groups: [{ id: 'page-total', label: '总价', signature: { value_type: 'decimal', semantic_kind: 'project_total', entity_key: null, unit: null, currency: 'GBP', tax_basis: 'included', coverage: 'separate' }, members, status: 'confirmed', reason: 'Human verified', display_order: 0 }] } });
      for (let index = 0; index < 101; index++) await call('createComparison', { id: 'pagination-project', body: { request_id: 'page-comparison-' + index, expected_revision: mapping.project_revision } });
      await page.evaluate(async () => { for (let index = 0; index < 101; index++) await window.desktop.api('createProject', { body: { request_id: 'list-project-' + index, name: 'List ' + index, scope: '', currency: 'GBP' } }); });
      const config = await call('settings');
      const before = (await call('usage')).summary.call_count;
      let lastJob;
      for (let index = 0; index < 105; index++) lastJob = await call('createJob', { body: { request_id: 'page-call-' + index, kind: 'connection_test', expected_connection_revision: config.revision } });
      await expect.poll(async () => (await call('job', { id: lastJob.id })).state, { timeout: 45000 }).toBe('succeeded');
      await page.reload(); await expect.poll(() => page.getByLabel('当前项目').locator('option').count()).toBeGreaterThan(100);
      await page.getByLabel('当前项目').selectOption('pagination-project'); await expect(page.getByRole('heading', { name: 'Pagination', exact: true })).toBeVisible();
      await expect(page.locator('.history-row')).toHaveCount(101);
      await click('对比'); await expect(page.getByLabel('对比历史').locator('option')).toHaveCount(101);
      await click('◷ 用量与费用'); await expect(page.locator('tbody tr')).toHaveCount(before + 105);
      const first = await call('usage', { query: { limit: 1 } });
      const second = await call('usage', { query: { limit: 1, cursor: first.next_cursor } });
      expect(second.calls[0].id).not.toBe(first.calls[0].id);
    });
    await check('All 25 API operations exercised over actual Electron IPC and local HTTP', async () => {
      const log = (await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const contract = JSON.parse(await fs.readFile(path.join(root, 'docs/technical/QuoteCompare-openapi-v2.json'), 'utf8'));
      const missing = [];
      for (const [route, methods] of Object.entries(contract.paths)) {
        const matcher = new RegExp('^' + route.replace(/\{[^}]+\}/g, '[^/]+') + '$');
        for (const method of Object.keys(methods).filter((method) => ['get', 'put', 'post', 'patch', 'delete'].includes(method))) {
          if (!log.some((request) => request.method === method.toUpperCase() && matcher.test(request.path.replace(/^\/api\/v1/, '')))) missing.push(method.toUpperCase() + ' ' + route);
        }
      }
      expect(missing).toEqual([]);
    });
    expect(results.filter((result) => result.status === 'failed')).toEqual([]);
    console.log('PASS:', results.length, 'desktop coverage scenarios');
  } catch (error) {
    results.push({ name: 'run stopped', status: 'failed', error: error.message });
    if (page && !page.isClosed()) { await page.screenshot({ path: path.join(root, 'artifacts/e2e/coverage-failure.png') }); console.log((await page.locator('body').innerText()).slice(-1200)); }
    throw error;
  } finally {
    await fs.writeFile(path.join(root, 'artifacts/e2e/coverage-results.json'), JSON.stringify({ directory, scenarios: results }, null, 2));
    if (desktop) await desktop.close();
    execFileSync(path.join(root, '.venv/bin/python'), ['-c', "import json,sys; from pathlib import Path; from backend.modules.settings import Keychain; folder=Path(sys.argv[1]); config=json.loads((folder/'settings.json').read_text()); Keychain(folder).delete(config['account']) if config['account'] else None", directory], { cwd: root });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
