const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quotecompare-packaged-'));
  const executable = process.argv[2] || path.join(root, 'release/mac-arm64/QuoteCompare.app/Contents/MacOS/QuoteCompare');
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PYTHONPATH;
  delete env.VIRTUAL_ENV;
  const desktop = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + directory], env, timeout: 60000 });
  try {
    const page = await desktop.firstWindow();
    const call = (operation, arguments_ = {}) => page.evaluate(([op, args]) => window.desktop.api(op, args), [operation, arguments_]);
    await expect(page.getByRole('heading', { name: '项目与报价资料' })).toBeVisible();
    expect((await call('health')).status).toBe('ready');
    const saved = await call('saveSettings', { body: { provider: 'openai', expected_revision: 1, api_key: 'packaged-fake-key-1234' } });
    expect(saved.has_key).toBe(true);
    expect(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).not.toContain('packaged-fake-key');
    await call('saveSettings', { body: { provider: 'openai', expected_revision: 2, api_key: null } });
    await call('createProject', { body: { request_id: 'p', name: 'Packaged smoke', property: '12 King Street', scope: 'Kitchen repair', currency: 'GBP' } });
    let revision = 1;
    const facts = [];
    for (const [qid, filename] of [['a', 'Contractor-A.pdf'], ['b', 'Contractor-B.png']]) {
      const data = new Uint8Array(await fs.readFile(path.join(root, 'artifacts/e2e-fixtures', filename)));
      const quote = await call('importQuote', { id: 'p', body: { request_id: qid, expected_revision: revision, source_type: filename.endsWith('.pdf') ? 'pdf' : 'image', contractor_name: qid }, file: { name: filename, data } });
      revision = quote.project_revision;
      expect(quote.source_blocks.length).toBeGreaterThan(0);
      if (qid === 'b') expect(quote.source_blocks.some((block) => block.bbox)).toBe(true);
      const fact = { id: qid, raw_label: 'Total', raw_value: null, normalized_value: qid === 'a' ? '1200' : '1100', value_type: 'decimal', semantic_kind: 'project_total', entity_key: null, unit: null, currency: 'GBP', tax_basis: 'included', coverage: 'separate', source_refs: [{ quote_id: qid, block_id: quote.source_blocks[0].id }], origin: 'manual', review_status: 'confirmed' };
      facts.push(fact);
      const edited = await call('updateQuote', { id: qid, body: { expected_revision: revision, facts: [fact] } });
      revision = edited.project_revision;
    }
    const signature = Object.fromEntries(['semantic_kind', 'entity_key', 'value_type', 'unit', 'currency', 'tax_basis', 'coverage'].map((key) => [key, facts[0][key]]));
    const mapping = await call('saveMappings', { id: 'p', body: { expected_revision: revision, groups: [{ id: 'g', label: '总价', signature, members: [{ quote_id: 'a', fact_id: 'a' }, { quote_id: 'b', fact_id: 'b' }], status: 'confirmed', reason: 'Manually checked', display_order: 0 }] } });
    const comparison = await call('createComparison', { id: 'p', body: { request_id: 'compare', expected_revision: mapping.project_revision } });
    const report = await call('createJob', { body: { request_id: 'report', kind: 'report', project_id: 'p', comparison_id: comparison.comparison.id, report_options: { format: 'pdf', hide_property: true, include_sources: true } } });
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = await call('job', { id: report.id });
      if (result.state === 'succeeded' || result.state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(result.state).toBe('succeeded');
    const file = await call('file', { id: result.result.report_file_id });
    expect(Buffer.from(file.data).subarray(0, 4).toString()).toBe('%PDF');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Packaged smoke', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '对比', exact: true }).click();
    await expect(page.locator('table')).toContainText('1200');
    await fs.mkdir(path.join(root, 'artifacts/e2e'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/e2e/08-packaged.png') });
    console.log('PASS: packaged app launched with system-only PATH and no Python environment; real Keychain, PDF/image OCR, SQLite persistence, comparison and PDF export.');
    console.log('Temporary test data:', directory);
  } finally { await desktop.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
