const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http'), fs = require('fs'), path = require('path');
const { Readable } = require('stream'), { pipeline } = require('stream/promises');

const PORT = 48721;
const ICON = path.join(__dirname, 'assets', 'icon.png');
const DEF = { downloadDir: '', maxConcurrent: 3, askNewType: true, askDefault: true, notify: true,
  startWithWindows: false, toTray: true, intercept: true, excludedSites: [] };
let win, tray, S, saveT, pushT, quitting = false, upd = { state: 'idle' }, nid = 1;
let pq = Promise.resolve();
const dls = new Map();

// ---------- storage ----------
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function load() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch {}
  S = { settings: { ...DEF, downloadDir: app.getPath('downloads'), ...j.settings }, rules: j.rules || {}, ignored: j.ignored || [] };
  for (const d of j.downloads || []) {
    if (['active', 'queued', 'preparing'].includes(d.status)) d.status = 'paused';
    dls.set(d.id, d); nid = Math.max(nid, d.id + 1);
  }
}
function writeNow() {
  const downloads = [...dls.values()].slice(-300).map(({ ctl, ...d }) => d);
  try { fs.writeFileSync(cfgFile(), JSON.stringify({ settings: S.settings, rules: S.rules, ignored: S.ignored, downloads })); } catch {}
}
const save = () => { clearTimeout(saveT); saveT = setTimeout(writeNow, 400); };
const pub = d => ({ id: d.id, url: d.url, name: d.name, path: d.path, dir: d.dir, size: d.size, got: d.got,
  speed: d.speed || 0, status: d.status, error: d.error, added: d.added });
const snap = () => ({ settings: S.settings, rules: S.rules, downloads: [...dls.values()].map(pub).reverse(),
  version: app.getVersion(), update: upd });
const push = () => {
  if (pushT) return;
  pushT = setTimeout(() => { pushT = null; if (win && !win.isDestroyed()) win.webContents.send('state', snap()); }, 150);
};

// ---------- helpers ----------
const clean = s => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
function nameFromUrl(url) { try { return clean(decodeURIComponent(new URL(url).pathname.split('/').pop())); } catch { return 'download'; } }
function nameFrom(r, url) {
  const cd = r.headers.get('content-disposition') || '';
  let n = null;
  try {
    let m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
    if (m) n = decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''));
    else if ((m = /filename="?([^";]+)"?/i.exec(cd))) n = m[1];
  } catch {}
  return clean(n || nameFromUrl(r.url || url));
}
function uniq(dir, name, self) {
  const p = path.parse(name); let n = name, i = 1;
  const taken = f => fs.existsSync(f) || fs.existsSync(f + '.part') || [...dls.values()].some(x => x !== self && x.path === f);
  while (taken(path.join(dir, n))) n = `${p.name} (${i++})${p.ext}`;
  return path.join(dir, n);
}
const box = o => dialog.showMessageBox(win && win.isVisible() ? win : undefined, o);
const queue = fn => { const p = pq.then(fn, fn); pq = p.catch(() => {}); return p; };

// ---------- folder choice for new file types ----------
async function pickDir(ext, name) {
  const s = S.settings;
  if (S.rules[ext]) return S.rules[ext];
  if (!ext || !s.askNewType || S.ignored.includes(ext)) return s.downloadDir;
  const r = await box({ type: 'question', title: 'New file type', message: `Where do you want to save .${ext} files?`,
    detail: name, buttons: ['Choose folder…', 'Use default folder'], defaultId: 0, cancelId: 1,
    checkboxLabel: `Don't ask again for .${ext}` });
  if (r.checkboxChecked) { S.ignored.push(ext); save(); }
  if (r.response !== 0) return s.downloadDir;
  const f = await dialog.showOpenDialog(win && win.isVisible() ? win : undefined,
    { properties: ['openDirectory', 'createDirectory'], defaultPath: s.downloadDir });
  if (f.canceled || !f.filePaths[0]) return s.downloadDir;
  const dir = f.filePaths[0];
  if (s.askDefault) {
    const q = await box({ type: 'question', title: 'Default folder', message: `Use this folder as the default for .${ext} files?`,
      detail: dir, buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, checkboxLabel: "Don't show this question again" });
    if (q.checkboxChecked) s.askDefault = false;
    if (q.response === 0) S.rules[ext] = dir;
    save();
  }
  return dir;
}

// ---------- download engine ----------
function add(url, headers) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) if (typeof v === 'string') h[k] = v;
  const d = { id: nid++, url, headers: h, name: nameFromUrl(url), status: 'preparing', size: 0, got: 0, added: Date.now() };
  dls.set(d.id, d); push(); prepare(d); return d;
}
async function prepare(d) {
  try {
    const r = await fetch(d.url, { headers: d.headers });
    r.body?.cancel().catch(() => {});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    d.name = nameFrom(r, d.url);
    const ext = path.extname(d.name).slice(1).toLowerCase();
    d.dir = await queue(() => pickDir(ext, d.name));
    d.path = uniq(d.dir, d.name, d); d.name = path.basename(d.path);
    d.status = 'queued'; d.error = '';
  } catch (e) { d.status = 'error'; d.error = e.message; }
  push(); save(); pump();
}
function pump() {
  let free = S.settings.maxConcurrent - [...dls.values()].filter(d => d.status === 'active').length;
  for (const d of dls.values()) { if (free <= 0) break; if (d.status === 'queued') { run(d); free--; } }
}
async function run(d) {
  d.status = 'active'; d.error = ''; d.ctl = new AbortController(); push();
  const part = d.path + '.part';
  try {
    let start = 0; try { start = fs.statSync(part).size; } catch {}
    const h = { ...d.headers }; if (start) h.Range = 'bytes=' + start + '-';
    const r = await fetch(d.url, { headers: h, signal: d.ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const resumed = start > 0 && r.status === 206; if (!resumed) start = 0;
    const len = +r.headers.get('content-length') || 0;
    d.size = len ? len + start : 0; d.got = start;
    fs.mkdirSync(d.dir, { recursive: true });
    const src = Readable.fromWeb(r.body); let t = Date.now(), b = 0;
    src.on('data', c => { d.got += c.length; b += c.length; const n = Date.now(); if (n - t > 700) { d.speed = b * 1000 / (n - t); t = n; b = 0; push(); } });
    await pipeline(src, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal: d.ctl.signal });
    fs.renameSync(part, d.path); d.status = 'done'; d.speed = 0;
    if (S.settings.notify) new Notification({ title: 'Download complete', body: d.name }).show();
  } catch (e) { if (d.status === 'active') { d.status = 'error'; d.error = e.message; d.speed = 0; } }
  d.ctl = null; push(); save(); pump();
}

// ---------- local server for the browser extension ----------
function startServer() {
  const srv = http.createServer((req, res) => {
    const o = req.headers.origin || '';
    const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': o || '*',
      'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    const send = (c, b) => { res.writeHead(c, h); res.end(JSON.stringify(b)); };
    if (req.method === 'OPTIONS') return send(200, {});
    if (req.method === 'GET' && req.url === '/ping')
      return send(200, { ok: true, intercept: S.settings.intercept, exclude: S.settings.excludedSites, version: app.getVersion() });
    if (req.method === 'POST' && req.url === '/download') {
      if (!o.startsWith('chrome-extension://')) return send(403, { ok: false });
      let b = ''; req.on('data', c => { b += c; if (b.length > 65536) req.destroy(); });
      req.on('end', () => {
        try { const j = JSON.parse(b); if (!/^https?:\/\//i.test(j.url)) throw 0; add(j.url, j.headers); send(200, { ok: true }); }
        catch { send(400, { ok: false }); }
      });
      return;
    }
    send(404, { ok: false });
  });
  srv.on('error', () => dialog.showErrorBox('Download Manager', `Port ${PORT} is in use. Close the other program and start the app again.`));
  srv.listen(PORT, '127.0.0.1');
}

// ---------- extension files, updates ----------
const extDir = () => path.join(app.getPath('userData'), 'extension');
function syncExt() {
  try { fs.cpSync(app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, 'extension'), extDir(), { recursive: true, force: true }); } catch {}
}
function setupUpdater() {
  if (!app.isPackaged) return;
  const set = o => { upd = o; push(); };
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-available', i => set({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => set({ state: 'none' }));
  autoUpdater.on('download-progress', p => set({ state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', i => set({ state: 'ready', version: i.version }));
  autoUpdater.on('error', () => set({ state: 'error' }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 4 * 3600e3);
}

// ---------- window ----------
function mkWin() {
  win = new BrowserWindow({ width: 980, height: 640, minWidth: 760, minHeight: 500, backgroundColor: '#14161b',
    autoHideMenuBar: true, show: !process.argv.includes('--hidden'), icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => { if (!quitting && S.settings.toTray) { e.preventDefault(); win.hide(); } });
}
const showWin = () => { if (!win || win.isDestroyed()) mkWin(); win.show(); win.focus(); };

// ---------- IPC ----------
const act = {
  pause: d => { if (d.status === 'active') { d.status = 'paused'; d.speed = 0; d.ctl?.abort(); } else if (d.status === 'queued') d.status = 'paused'; },
  resume: d => { if (['paused', 'error'].includes(d.status)) { if (d.path) { d.status = 'queued'; d.error = ''; } else prepare(d); } },
  cancel: d => { d.status = 'canceled'; d.ctl?.abort(); if (d.path) setTimeout(() => fs.rm(d.path + '.part', { force: true }, () => {}), 400); },
  remove: d => dls.delete(d.id),
  open: d => { if (d.status === 'done') shell.openPath(d.path); },
  folder: d => { if (d.path) shell.showItemInFolder(d.path); }
};
act.retry = act.resume;
ipcMain.handle('state', () => snap());
ipcMain.handle('dl', (e, id, a) => { const d = dls.get(id); if (d && act[a]) { act[a](d); push(); save(); pump(); } });
ipcMain.handle('add', (e, url) => { if (/^https?:\/\//i.test(url)) add(url, {}); });
ipcMain.handle('set', (e, p) => {
  for (const k of Object.keys(p)) if (k in DEF) S.settings[k] = p[k];
  S.settings.maxConcurrent = Math.min(10, Math.max(1, +S.settings.maxConcurrent || 3));
  if ('startWithWindows' in p && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!p.startWithWindows, args: ['--hidden'] });
  save(); push(); pump();
});
ipcMain.handle('rule:set', (e, ext, dir) => { ext = String(ext).toLowerCase().replace(/[.\s]/g, ''); if (ext && dir) { S.rules[ext] = dir; S.ignored = S.ignored.filter(x => x !== ext); save(); } });
ipcMain.handle('rule:del', (e, ext) => { delete S.rules[ext]; save(); });
ipcMain.handle('ignored:clear', () => { S.ignored = []; S.settings.askNewType = true; S.settings.askDefault = true; save(); });
ipcMain.handle('pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('ext:open', () => shell.openPath(extDir()));
ipcMain.handle('update:check', () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); else { upd = { state: 'error' }; push(); } });
ipcMain.handle('update:install', () => { quitting = true; autoUpdater.quitAndInstall(); });

// ---------- start ----------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWin);
  app.on('before-quit', () => { quitting = true; for (const d of dls.values()) if (d.status === 'active') { d.status = 'paused'; d.ctl?.abort(); } writeNow(); });
  app.on('window-all-closed', () => { if (!S.settings.toTray) app.quit(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    load(); syncExt(); mkWin(); startServer(); setupUpdater();
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Download Manager');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open', click: showWin }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
    tray.on('click', showWin);
  });
}
