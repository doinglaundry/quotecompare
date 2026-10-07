const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quotecompare-recovery-'));
  const env = { ...process.env, QUOTECOMPARE_E2E: '1', QUOTECOMPARE_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  try {
    const page = await desktop.firstWindow();
    const call = (operation, args = {}) => page.evaluate(([name, args]) => window.desktop.api(name, args), [operation, args]);
    await expect(page.getByRole('button', { name: '＋ 新建项目', exact: true })).toBeEnabled();
    await call('saveSettings', { body: { expected_revision: 1, provider: 'openai', api_key: 'test-valid' } });
    await call('createProject', { body: { request_id: 'p', name: 'Refresh recovery', scope: 'RESULT_REFRESH_FAIL', currency: 'GBP' } });
    await call('importQuote', { id: 'p', body: { request_id: 'q', expected_revision: 1, source_type: 'text', text: 'Total GBP 1200' } });
    await page.reload();
    await page.getByRole('button', { name: 'AI 提取全部报价', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('结果刷新失败');
    await expect(page.getByRole('button', { name: 'AI 提取全部报价', exact: true })).toBeEnabled();
    await expect(page.locator('.job')).toHaveAttribute('data-state', 'succeeded');
    expect((await call('usage')).summary.call_count).toBe(1);
    await page.reload();
    await expect(page.locator('.quote-card')).toContainText('等待核对');
    expect((await call('usage')).summary.call_count).toBe(1);
    console.log('PASS: completed task read failure releases busy UI; reload restores saved results without another model call.');
  } finally {
    await desktop.close();
    execFileSync(path.join(root, '.venv/bin/python'), ['-c', "import json,sys; from pathlib import Path; from backend.modules.settings import Keychain; folder=Path(sys.argv[1]); config=json.loads((folder/'settings.json').read_text()); Keychain(folder).delete(config['account']) if config['account'] else None", directory], { cwd: root });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
