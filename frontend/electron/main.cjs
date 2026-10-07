const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const requestedData = app.commandLine.getSwitchValue('user-data-dir');
if (requestedData) app.setPath('userData', path.resolve(requestedData));
if (!app.isPackaged && process.env.QUOTECOMPARE_E2E === '1') app.setPath('userData', process.env.QUOTECOMPARE_TEST_DATA);
const token = randomBytes(32).toString('hex');
const root = path.resolve(__dirname, '../..');
let backend;
let origin;
let window;

const routes = {
  health: ['GET', '/health'], projects: ['GET', '/projects'], createProject: ['POST', '/projects'],
  project: ['GET', '/projects/:id'], updateProject: ['PATCH', '/projects/:id'], deleteProject: ['DELETE', '/projects/:id'],
  importQuote: ['POST', '/projects/:id/quotes'], quote: ['GET', '/quotes/:id'], updateQuote: ['PATCH', '/quotes/:id'], deleteQuote: ['DELETE', '/quotes/:id'],
  createJob: ['POST', '/jobs'], job: ['GET', '/jobs/:id'], cancelJob: ['POST', '/jobs/:id/cancel'],
  mappings: ['GET', '/projects/:id/field-mappings'], saveMappings: ['PUT', '/projects/:id/field-mappings'],
  createComparison: ['POST', '/projects/:id/comparisons'], comparisons: ['GET', '/projects/:id/comparisons'], comparison: ['GET', '/comparisons/:id'],
  draft: ['GET', '/drafts/:id'], saveDraft: ['PATCH', '/drafts/:id'], file: ['GET', '/files/:id'],
  settings: ['GET', '/settings'], saveSettings: ['PUT', '/settings'], usage: ['GET', '/usage'], balance: ['GET', '/balance'],
};

async function api(operation, arguments_ = {}) {
  const route = routes[operation];
  if (!route) throw new Error('不支持的操作');
  let url = route[1];
  if (url.includes(':id')) {
    const id = arguments_.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('编号不正确');
    url = url.replace(':id', id);
  }
  const query = new URLSearchParams(arguments_.query || {});
  const options = { method: route[0], headers: { Authorization: 'Bearer ' + token } };
  if (operation === 'importQuote') {
    const form = new FormData();
    for (const [key, value] of Object.entries(arguments_.body || {})) form.set(key, String(value));
    if (arguments_.file) form.set('file', new Blob([arguments_.file.data]), arguments_.file.name);
    options.body = form;
  } else if (arguments_.body) {
    options.body = JSON.stringify(arguments_.body);
    options.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(origin + '/api/v1' + url + '?' + query, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: '本地服务错误' }));
    throw new Error(error.message || '操作失败');
  }
  if (response.status === 204) return null;
  if (operation === 'file') return { data: new Uint8Array(await response.arrayBuffer()), type: response.headers.get('content-type') };
  return response.json();
}

async function startBackend() {
  const testing = !app.isPackaged && process.env.QUOTECOMPARE_E2E === '1';
  const directory = testing ? process.env.QUOTECOMPARE_TEST_DATA : app.getPath('userData');
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'backend/quotecompare-backend') : path.join(root, '.venv/bin/python');
  const args = app.isPackaged ? ['--data-dir', directory] : ['-m', testing ? 'tests.e2e.server' : 'backend.main', '--data-dir', directory];
  backend = spawn(executable, args, { cwd: app.isPackaged ? process.resourcesPath : root,
    env: { ...process.env, QUOTECOMPARE_SESSION_TOKEN: token, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('本地服务启动超时')), 30000);
    backend.stdout.on('data', (data) => {
      output += data.toString();
      const match = output.match(/QUOTECOMPARE_PORT=(\d+)/);
      if (match && !origin) {
        origin = 'http://127.0.0.1:' + match[1];
        clearTimeout(timer);
        resolve();
      }
    });
    backend.once('error', () => { clearTimeout(timer); reject(new Error('本地服务无法启动')); });
    backend.once('exit', () => { clearTimeout(timer); reject(new Error('本地服务已退出')); });
    // Do not print user content, credentials or provider response bodies.
    backend.stderr.on('data', () => {});
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await api('health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('本地服务没有就绪');
}

function registerHandlers() {
  const allowed = (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  ipcMain.handle('api', (event, operation, arguments_) => {
    if (!allowed(event)) throw new Error('会话无效');
    return api(operation, arguments_);
  });
  ipcMain.handle('choose-files', async (event) => {
    if (!allowed(event)) throw new Error('会话无效');
    const choice = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters: [{ name: '报价资料', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'] }] });
    if (choice.canceled) return [];
    if (choice.filePaths.length > 5) throw new Error('最多选择五份报价');
    const files = [];
    for (const filename of choice.filePaths) {
      const stat = await fs.stat(filename);
      if (stat.size > 50 * 1024 * 1024) throw new Error('单个文件最大 50MB');
      files.push({ name: path.basename(filename), data: new Uint8Array(await fs.readFile(filename)) });
    }
    return files;
  });
  ipcMain.handle('save-file', async (event, fileId, filename) => {
    if (!allowed(event)) throw new Error('会话无效');
    const contents = await api('file', { id: fileId });
    const choice = await dialog.showSaveDialog(window, { defaultPath: path.basename(String(filename)) });
    if (choice.canceled) return false;
    await fs.writeFile(choice.filePath, contents.data);
    return true;
  });
  ipcMain.handle('copy', (event, text) => {
    if (!allowed(event) || typeof text !== 'string' || text.length > 25000) throw new Error('复制内容不正确');
    clipboard.writeText(text);
  });
  const billing = { openai: 'https://platform.openai.com/settings/organization/billing/overview', claude: 'https://platform.claude.com/settings/billing', deepseek: 'https://platform.deepseek.com/usage' };
  ipcMain.handle('billing', (event, provider) => {
    if (!allowed(event) || !billing[provider]) throw new Error('服务商不正确');
    return shell.openExternal(billing[provider]);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  try {
    await startBackend();
    window = new BrowserWindow({ width: 1450, height: 950, minWidth: 1050, minHeight: 720, title: 'QuoteCompare', backgroundColor: '#f4f7f6',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    registerHandlers();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadFile(path.join(__dirname, '../dist/index.html'));
  } catch (error) {
    dialog.showErrorBox('QuoteCompare 无法启动', error.message);
    app.quit();
  }
});
app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (backend && !backend.killed) {
    backend.kill('SIGTERM');
    const timer = setTimeout(() => { if (backend.exitCode === null) backend.kill('SIGKILL'); }, 3000);
    timer.unref();
  }
});
