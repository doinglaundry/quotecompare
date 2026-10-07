const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quotecompare-reads-'));
  const env = { ...process.env, QUOTECOMPARE_E2E: '1', QUOTECOMPARE_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  try {
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const call = (operation, args = {}) => page.evaluate(([name, args]) => window.desktop.api(name, args), [operation, args]);
    const requests = async () => (await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const click = (name) => page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('button', { name: '＋ 新建项目', exact: true })).toBeEnabled();
    await call('createProject', { body: { request_id: 'p', name: 'Read regression', scope: 'Repair kitchen', currency: 'GBP' } });
    const imported = await call('importQuote', { id: 'p', body: { request_id: 'q', expected_revision: 1, source_type: 'text', text: 'Total GBP 1200', contractor_name: 'A' } });
    const fact = { id: 'total', raw_label: 'Total', raw_value: null, normalized_value: '1200', value_type: 'decimal', semantic_kind: 'project_total',
      entity_key: null, unit: null, currency: 'GBP', tax_basis: 'included', coverage: 'separate', origin: 'manual', review_status: 'confirmed',
      source_refs: [{ quote_id: 'q', block_id: imported.source_blocks[0].id }] };
    await call('updateQuote', { id: 'q', body: { expected_revision: 2, facts: [fact] } });
    let offset = (await requests()).length;
    await page.reload();
    await expect(page.locator('.quote-card')).toContainText('A');
    await expect(page.getByRole('button', { name: '＋ 新建项目', exact: true })).toBeEnabled();
    const loaded = (await requests()).slice(offset);
    expect(loaded.filter((request) => request.path.endsWith('/field-mappings'))).toHaveLength(0);
    await click('核对');
    await page.getByLabel('规范值 0', { exact: true }).fill('1350');
    offset = (await requests()).length;
    await click('保存核对');
    await expect(page.getByRole('status')).toContainText('核对结果已保存');
    const saved = (await requests()).slice(offset);
    expect(saved.filter((request) => request.method === 'PATCH' && request.path === '/api/v1/quotes/q')).toHaveLength(1);
    expect(saved.filter((request) => request.method === 'GET' && request.path === '/api/v1/quotes/q')).toHaveLength(0);
    expect(saved.filter((request) => request.path.endsWith('/field-mappings'))).toHaveLength(0);
    expect(await page.getByLabel('规范值 0', { exact: true }).inputValue()).toBe('1350');
    await expect(page.locator('.source-blocks')).toContainText('Total GBP 1200');
    const updated = await call('quote', { id: 'q' });
    expect(updated.facts[0].normalized_value).toBe('1350');
    expect(updated.source_blocks).toEqual(imported.source_blocks);
    await page.reload();
    await expect(page.getByRole('button', { name: '＋ 新建项目', exact: true })).toBeEnabled();
    await click('核对');
    await expect(page.getByLabel('规范值 0', { exact: true })).toHaveValue('1350');
    expect(errors).toEqual([]);
    console.log('PASS: project/mapping response reuse and quote save without redundant reads; edited value and source survive reload.');
  } finally { await desktop.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
