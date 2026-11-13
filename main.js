const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, nativeImage, nativeTheme, clipboard } = require('electron');
const http = require('http'), fs = require('fs'), path = require('path');
const { Readable } = require('stream'), { pipeline } = require('stream/promises');
const Segs = require('./lib/segments');
const { Bucket, throttle, DEFAULT_CATS, catOf, findRule, migrateRules, parseRuleKey } = require('./lib/util');

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');
const PORT = 48721, MB = 1048576;
const ICON = path.join(__dirname, 'assets', 'icon.png');
const R = f => path.join(__dirname, 'renderer', f);
const DEF = { theme: 'dark', speedMode: 'normal', maxBps: 0, slowPct: 30, downloadDir: '', askNewType: true, askEvery: false,
  onConflict: 'rename', notify: true, openWhenDone: false, startWithWindows: false, toTray: true, keepDays: 0,
  intercept: true, excludedSites: [], minSizeMB: 0 };
let tc = 0, win, tray, S, saveT, flushT, tickT, quitting = false, upd = { state: 'idle' }, nid = 1, totalSpeed = 0, pq = Promise.resolve();
const dls = new Map(), dirty = new Set(), removed = new Set(), prompts = new Map(), G = new Bucket();

// ---------- storage ----------
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function load() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch {}
  S = { settings: { ...DEF, downloadDir: app.getPath('downloads'), ...j.settings }, rules: migrateRules(j.rules),
    cats: j.cats || structuredClone(DEFAULT_CATS), ignored: j.ignored || [] };
  const lim = S.settings.keepDays ? Date.now() - S.settings.keepDays * 864e5 : 0;
  for (const d of j.downloads || []) {
    if (['active', 'queued', 'preparing'].includes(d.status)) d.status = 'paused';
    if (lim && ['done', 'canceled', 'error'].includes(d.status) && (d.done || d.added) < lim) continue;
    dls.set(d.id, d); nid = Math.max(nid, d.id + 1);
  }
}
function writeNow() {
  for (const d of dls.values()) if (d.segs) d.segs.forEach(Segs.sync);
  const downloads = [...dls.values()].slice(-300).map(({ ctl, bucket, _g, speed, ...d }) => (['done', 'canceled'].includes(d.status) ? { ...d, headers: {} } : d));
  try { fs.writeFileSync(cfgFile(), JSON.stringify({ settings: S.settings, rules: S.rules, cats: S.cats, ignored: S.ignored, downloads })); } catch {}
}
const save = () => { clearTimeout(saveT); saveT = setTimeout(writeNow, 1500); };

// ---------- helpers ----------
const clean = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
const extOf = n => path.extname(n || '').slice(1).toLowerCase();
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const rid = () => Math.random().toString(36).slice(2, 9);
const bg = () => nativeTheme.shouldUseDarkColors ? '#0e0f13' : '#f3f4f8';
function nameFromUrl(url) { try { return clean(decodeURIComponent(new URL(url).pathname.split('/').pop())) || 'download'; } catch { return 'download'; } }
function nameFrom(r, url) {
  const cd = r.headers.get('content-disposition') || '';
  let n = null;
  try {
    let m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
    if (m) n = decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''));
    else if ((m = /filename="?([^";]+)"?/i.exec(cd))) n = m[1];
  } catch {}
  return clean(n || nameFromUrl(r.url || url)) || 'download';
}
function uniq(dir, name, self) {
  const p = path.parse(name); let n = name, i = 1;
  const taken = f => fs.existsSync(f) || fs.existsSync(f + '.part') || [...dls.values()].some(x => x !== self && x.path === f);
  while (taken(path.join(dir, n))) n = `${p.name} (${i++})${p.ext}`;
  return path.join(dir, n);
}
const queue = fn => { const p = pq.then(fn, fn); pq = p.catch(() => {}); return p; };

// ---------- UI sync (only changed downloads are sent) ----------
const pub = d => { const ext = extOf(d.name); return { id: d.id, url: d.url, name: d.name, path: d.path, dir: d.dir, size: d.size, got: d.got,
  speed: d.speed || 0, status: d.status, error: d.error, added: d.added, done: d.done, ext, cat: catOf(S.cats, ext) }; };
const snap = () => ({ settings: S.settings, rules: S.rules, cats: S.cats, downloads: [...dls.values()].map(pub),
  version: app.getVersion(), update: upd, speed: totalSpeed });
const live = () => win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
function touch(d, now) { dirty.add(d.id); sched(now ? 80 : 400); }
function sched(ms) { if (!flushT) flushT = setTimeout(flush, ms); }
function flush() {
  flushT = null;
  if (live()) win.webContents.send('patch', { up: [...dirty].map(id => dls.get(id)).filter(Boolean).map(pub), rm: [...removed], speed: totalSpeed });
  dirty.clear(); removed.clear();
}
const sendFull = () => { if (win && !win.isDestroyed()) win.webContents.send('full', snap()); };
function ensureTick() {
  if (tickT) return;
  tickT = setInterval(() => {
    let sum = 0, any = false;
    for (const d of dls.values()) if (d.status === 'active') { any = true; d.speed = Math.max(0, d.got - (d._g ?? d.got)); d._g = d.got; sum += d.speed; dirty.add(d.id); }
    const changed = sum !== totalSpeed; totalSpeed = sum;
    if (any || changed) sched(0);
    if (any && ++tc % 10 === 0) save();
    if (!any) { clearInterval(tickT); tickT = null; }
  }, 1000);
}

// ---------- speed control ----------
function limitFor(d) { const r = findRule(S.rules, S.cats, extOf(d.name)); return r && r.limit > 0 ? r.limit * MB : 0; }
function applyLimits() {
  const s = S.settings;
  G.rate = s.speedMode === 'slow' && s.maxBps ? s.maxBps * s.slowPct / 100 : 0;
  for (const d of dls.values()) if (d.bucket) d.bucket.rate = s.speedMode === 'fast' ? 0 : limitFor(d);
}
async function measure() {
  const ctl = new AbortController(); let bytes = 0, b1 = 0, t1 = 0;
  const t0 = setTimeout(() => ctl.abort(), 6000);
  const t = setTimeout(() => { b1 = bytes; t1 = Date.now(); }, 1000);
  await Promise.all([1, 2, 3, 4].map(async () => {
    try {
      const r = await fetch('https://speed.cloudflare.com/__down?bytes=100000000', { signal: ctl.signal, headers: { 'Accept-Encoding': 'identity' } });
      for await (const c of Readable.fromWeb(r.body)) bytes += c.length;
    } catch {}
  }));
  clearTimeout(t0); clearTimeout(t);
  if (!t1 || bytes - b1 < 500000) return 0;
  return (bytes - b1) / ((Date.now() - t1) / 1000);
}

// ---------- new download: name, folder, popup ----------
function prompt(data) {
  return new Promise(resolve => {
    const w = new BrowserWindow({ width: 480, height: data.ext && !data.hasRule ? 440 : 330, useContentSize: true, resizable: false,
      minimizable: false, maximizable: false, autoHideMenuBar: true, alwaysOnTop: true, title: 'New download', icon: ICON, backgroundColor: bg(),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false } });
    const id = w.webContents.id;
    prompts.set(id, { data: { ...data, theme: S.settings.theme }, resolve });
    w.on('closed', () => { const p = prompts.get(id); if (p) { prompts.delete(id); p.resolve(null); } });
    w.loadFile(R('prompt.html'));
  });
}
function upsertRule(kind, key, dir) {
  const x = S.rules.find(r => r.kind === kind && r.key === key);
  if (x) x.dir = dir; else S.rules.push({ id: rid(), kind, key, dir, limit: 0 });
  save();
}
async function choose(d) {
  const s = S.settings, ext = extOf(d.name), rule = findRule(S.rules, S.cats, ext);
  const base = { name: d.name, dir: rule ? rule.dir : s.downloadDir };
  if (!(s.askEvery || (!rule && ext && s.askNewType && !S.ignored.includes(ext)))) return base;
  const res = await prompt({ name: d.name, size: d.size, host: hostOf(d.url), dir: base.dir, ext, cat: catOf(S.cats, ext), hasRule: !!rule });
  if (!res) return null;
  if (res.never && ext) { S.ignored.push(ext); save(); }
  if (res.remember && ext) { const cat = catOf(S.cats, ext); res.scope === 'cat' && cat ? upsertRule('cat', cat, res.dir) : upsertRule('ext', ext, res.dir); }
  return { name: clean(res.name) || d.name, dir: res.dir };
}

// ---------- download engine ----------
function add(url, headers, hint) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) if (typeof v === 'string') h[k] = v;
  const d = { id: nid++, url, headers: h, name: nameFromUrl(url), status: 'preparing', size: 0, got: 0, hint: hint || 0, added: Date.now() };
  dls.set(d.id, d); touch(d, 1); prepare(d); return d;
}
async function probe(d) {
  // One tiny request (1 byte) tells us the name, the size and if the server allows parts.
  const h = { ...d.headers, 'Accept-Encoding': 'identity' };
  let r = await fetch(d.url, { headers: { ...h, Range: 'bytes=0-0' } });
  if (!r.ok) { r.body?.cancel().catch(() => {}); r = await fetch(d.url, { headers: h }); }
  r.body?.cancel().catch(() => {});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  let total = 0;
  if (r.status === 206) { const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || ''); total = m ? +m[1] : 0; d.ranged = total > 0; }
  else { total = +r.headers.get('content-length') || 0; d.ranged = false; }
  d.size = total || d.hint || 0;
  return r;
}
async function prepare(d) {
  d.status = 'preparing'; d.error = '';
  try {
    const r = await probe(d);
    d.name = nameFrom(r, d.url);
    touch(d, 1);
    const pick = await queue(() => choose(d));
    if (!pick) { d.status = 'canceled'; touch(d, 1); save(); return; }
    d.dir = pick.dir;
    d.path = S.settings.onConflict === 'overwrite' ? path.join(d.dir, pick.name) : uniq(d.dir, pick.name, d);
    d.name = path.basename(d.path);
    save(); run(d);
  } catch (e) { d.status = 'error'; d.error = e.message; touch(d, 1); save(); }
}
async function moveInto(a, b) { // Windows antivirus can lock a new file for a moment
  for (let i = 0; ; i++) {
    try { fs.renameSync(a, b); return; }
    catch (e) { if (i >= 8 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 150)); }
  }
}
async function run(d) {
  const ctl = new AbortController();
  d.status = 'active'; d.error = ''; d.ctl = ctl; d.bucket = new Bucket();
  d.bucket.rate = S.settings.speedMode === 'fast' ? 0 : limitFor(d);
  touch(d, 1); ensureTick();
  const part = d.path + '.part';
  try {
    if (d.segs || (d.ranged && !d.noRange && d.size >= 4 * MB && !fs.existsSync(part))) {
      if (!d.segs || !fs.existsSync(part)) {
        fs.mkdirSync(d.dir, { recursive: true });
        const fd = fs.openSync(part, 'w'); fs.ftruncateSync(fd, d.size); fs.closeSync(fd);
        const others = [...dls.values()].filter(x => x !== d && x.status === 'active' && x.segs).length;
        d.segs = Segs.plan(d.size, Math.floor(16 / (others + 1)));
      }
      d.got = Segs.done(d.segs); d._g = d.got;
      await Segs.run({ url: d.url, headers: d.headers, part, segs: d.segs, signal: ctl.signal, abort: () => ctl.abort(),
        onBytes: n => { d.got += n; }, buckets: () => [G, d.bucket], onRetry: () => { d.segs.forEach(Segs.sync); d.got = Segs.done(d.segs); } });
      d.segs = null;
    } else {
      let start = 0; try { start = fs.statSync(part).size; } catch {}
      const h = { ...d.headers, 'Accept-Encoding': 'identity' }; if (start) h.Range = 'bytes=' + start + '-';
      const r = await fetch(d.url, { headers: h, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const resumed = start > 0 && r.status === 206; if (!resumed) start = 0;
      const len = +r.headers.get('content-length') || 0;
      d.size = len ? len + start : (d.hint || d.size || 0); d.got = start; d._g = start;
      fs.mkdirSync(d.dir, { recursive: true });
      await pipeline(Readable.fromWeb(r.body), throttle(n => { d.got += n; }, () => [G, d.bucket]),
        fs.createWriteStream(part, { flags: resumed ? 'a' : 'w', highWaterMark: 262144 }), { signal: ctl.signal });
    }
    await moveInto(part, d.path);
    d.status = 'done'; d.speed = 0; d.done = Date.now(); d.size = d.size || d.got;
    if (S.settings.notify) { const n = new Notification({ title: 'Download complete', body: d.name }); n.on('click', () => shell.showItemInFolder(d.path)); n.show(); }
    if (S.settings.openWhenDone) shell.openPath(d.path);
  } catch (e) {
    // The server does not like parts and nothing was saved yet: start again with one connection.
    if (d.segs && d.status === 'active' && !d.noRange && d.segs.every(s => s.pos === s.s) && ['NORANGE', 'HTTP403', 'HTTP429', 'HTTP503'].includes(e.code)) {
      d.noRange = true; d.segs = null; try { fs.rmSync(part, { force: true }); } catch {}
      return run(d);
    }
    if (d.status === 'active') { d.status = 'error'; d.error = e.message; d.speed = 0; }
  }
  if (d.ctl === ctl) { d.ctl = null; d.bucket = null; }
  touch(d, 1); save();
}
const act = {
  pause: d => { if (d.status === 'active') { d.status = 'paused'; d.speed = 0; d.ctl?.abort(); } },
  resume: d => { if (['paused', 'error', 'canceled'].includes(d.status)) { if (d.path) run(d); else prepare(d); } },
  cancel: d => { if (['done', 'canceled'].includes(d.status)) return; d.status = 'canceled'; d.segs = null; d.speed = 0; d.ctl?.abort(); if (d.path) setTimeout(() => fs.rm(d.path + '.part', { force: true }, () => {}), 500); },
  remove: d => { if (d.status === 'active') act.cancel(d); dls.delete(d.id); removed.add(d.id); },
  open: d => { if (d.status === 'done') shell.openPath(d.path); }
};
act.retry = act.resume;
function renameDl(d, name) {
  name = clean(name);
  if (!name || name === d.name || d.status === 'active' || !d.path) return name ? '' : 'Enter a file name.';
  const np = path.join(d.dir, name);
  if (fs.existsSync(np)) return 'A file with this name already exists.';
  try {
    if (d.status === 'done') fs.renameSync(d.path, np);
    else if (fs.existsSync(d.path + '.part')) fs.renameSync(d.path + '.part', np + '.part');
    d.path = np; d.name = name; touch(d, 1); save(); return '';
  } catch (e) { return e.message; }
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
      return send(200, { ok: true, intercept: S.settings.intercept, exclude: S.settings.excludedSites, minSize: S.settings.minSizeMB * 1e6, version: app.getVersion() });
    if (req.method === 'POST' && req.url === '/download') {
      if (!o.startsWith('chrome-extension://')) return send(403, { ok: false });
      let b = ''; req.on('data', c => { b += c; if (b.length > 65536) req.destroy(); });
      req.on('end', () => {
        try { const j = JSON.parse(b); if (!/^https?:\/\//i.test(j.url)) throw 0; add(j.url, j.headers, +j.size || 0); send(200, { ok: true }); }
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
let autoUpdater = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  ({ autoUpdater } = require('electron-updater'));
  let lastPct = -10;
  const set = o => { upd = o; sendFull(); };
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-available', i => set({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => set({ state: 'none' }));
  autoUpdater.on('download-progress', p => { if (p.percent - lastPct >= 10) { lastPct = p.percent; set({ state: 'downloading', percent: p.percent }); } });
  autoUpdater.on('update-downloaded', i => set({ state: 'ready', version: i.version }));
  autoUpdater.on('error', () => set({ state: 'error' }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 4 * 3600e3);
}

// ---------- window, tray ----------
function mkWin() {
  win = new BrowserWindow({ width: 1060, height: 700, minWidth: 820, minHeight: 560, backgroundColor: bg(), autoHideMenuBar: true, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false } });
  win.loadFile(R('index.html'));
  win.on('closed', () => { win = null; });
}
function showWin() { if (!win || win.isDestroyed()) mkWin(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
function trayMenu() {
  if (!tray) return;
  const m = S.settings.speedMode;
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Download Manager', click: showWin }, { type: 'separator' },
    ...[['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([k, l]) => ({ label: 'Speed: ' + l, type: 'radio', checked: m === k, click: () => { setSettings({ speedMode: k }); sendFull(); } })),
    { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
}
function setSettings(p) {
  const s = S.settings;
  for (const k of Object.keys(p)) if (k in DEF) s[k] = p[k];
  s.slowPct = Math.min(95, Math.max(5, +s.slowPct || 30)); s.maxBps = Math.max(0, +s.maxBps || 0);
  s.minSizeMB = Math.max(0, +s.minSizeMB || 0); s.keepDays = Math.max(0, parseInt(s.keepDays) || 0);
  if (!['slow', 'normal', 'fast'].includes(s.speedMode)) s.speedMode = 'normal';
  if (!['dark', 'light', 'system'].includes(s.theme)) s.theme = 'dark';
  if (!['rename', 'overwrite'].includes(s.onConflict)) s.onConflict = 'rename';
  if (!Array.isArray(s.excludedSites)) s.excludedSites = [];
  nativeTheme.themeSource = s.theme;
  if ('startWithWindows' in p && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, args: ['--hidden'] });
  applyLimits(); trayMenu(); save();
  return s;
}

// ---------- IPC ----------
ipcMain.handle('state', () => snap());
ipcMain.handle('set', (e, p) => setSettings(p));
ipcMain.handle('dl', (e, id, a) => { const d = dls.get(id); if (d && act[a]) { act[a](d); touch(d, 1); save(); } });
ipcMain.handle('dl:rename', (e, id, name) => { const d = dls.get(id); return d ? renameDl(d, name) : ''; });
ipcMain.handle('dl:clear', () => { for (const d of [...dls.values()]) if (['done', 'canceled', 'error'].includes(d.status)) act.remove(d); sched(0); save(); });
ipcMain.handle('add', (e, text) => { String(text).split(/\s+/).filter(u => /^https?:\/\//i.test(u)).forEach(u => add(u, {}, 0)); });
ipcMain.handle('clip', () => clipboard.readText());
ipcMain.handle('pick', async (e, def) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'], defaultPath: def || S.settings.downloadDir });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('rule:save', (e, r) => {
  const limit = Math.max(0, +r.limit || 0);
  if (r.id) { const x = S.rules.find(y => y.id === r.id); if (x) { x.dir = r.dir; x.limit = limit; } }
  else for (const tok of String(r.text).split(/[,;\s]+/).filter(Boolean)) {
    const { kind, key } = parseRuleKey(S.cats, tok); if (!key) continue;
    const x = S.rules.find(y => y.kind === kind && y.key === key);
    if (x) { x.dir = r.dir; x.limit = limit; } else S.rules.push({ id: rid(), kind, key, dir: r.dir, limit });
    S.ignored = S.ignored.filter(i => i !== key);
  }
  applyLimits(); save();
});
ipcMain.handle('rule:del', (e, id) => { S.rules = S.rules.filter(r => r.id !== id); applyLimits(); save(); });
ipcMain.handle('cat:save', (e, name, text) => {
  name = String(name).trim(); if (!name) return;
  S.cats[name] = [...new Set(String(text).split(/[,;\s]+/).map(x => x.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean))]; save();
});
ipcMain.handle('cat:del', (e, name) => { delete S.cats[name]; S.rules = S.rules.filter(r => !(r.kind === 'cat' && r.key === name)); applyLimits(); save(); });
ipcMain.handle('ignored:clear', () => { S.ignored = []; S.settings.askNewType = true; save(); });
ipcMain.handle('ext:open', () => shell.openPath(extDir()));
ipcMain.handle('speed:test', async () => { const v = await measure(); if (v > 0) { S.settings.maxBps = Math.round(v); applyLimits(); save(); } return S.settings.maxBps; });
ipcMain.handle('update:check', () => { if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {}); else { upd = { state: 'error' }; sendFull(); } });
ipcMain.handle('update:install', () => { quitting = true; autoUpdater && autoUpdater.quitAndInstall(); });
ipcMain.handle('prompt:init', e => prompts.get(e.sender.id)?.data);
ipcMain.handle('prompt:done', (e, res) => {
  const p = prompts.get(e.sender.id); if (!p) return;
  prompts.delete(e.sender.id); p.resolve(res); BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.handle('dl:menu', (e, ids) => {
  const ds = ids.map(i => dls.get(i)).filter(Boolean); if (!ds.length) return;
  const d = ds[0], one = ds.length === 1, any = (...st) => ds.some(x => st.includes(x.status));
  const apply = a => () => { ds.forEach(x => act[a](x)); ds.forEach(x => touch(x, 1)); save(); };
  const t = [];
  if (one) t.push({ label: 'Open file', enabled: d.status === 'done', click: () => act.open(d) },
    { label: 'Show in Explorer', enabled: !!d.path, click: () => shell.showItemInFolder(d.path) },
    { label: 'Rename…', enabled: d.status !== 'active' && !!d.path, click: () => win?.webContents.send('rename', d.id, d.name) }, { type: 'separator' });
  if (any('active')) t.push({ label: 'Pause', click: apply('pause') });
  if (any('paused')) t.push({ label: 'Resume', click: apply('resume') });
  if (any('error', 'canceled')) t.push({ label: 'Retry', click: apply('retry') });
  if (any('active', 'paused', 'preparing', 'error')) t.push({ label: 'Cancel download', click: apply('cancel') });
  if (one) t.push({ type: 'separator' }, { label: 'Copy download link', click: () => clipboard.writeText(d.url) },
    { label: 'Copy file path', enabled: !!d.path, click: () => clipboard.writeText(d.path) },
    { label: 'Download again', click: () => add(d.url, d.headers, 0) });
  t.push({ type: 'separator' }, { label: ds.length > 1 ? `Remove ${ds.length} from list` : 'Remove from list', click: () => { apply('remove')(); sched(0); } });
  if (one) t.push({ label: 'Delete file…', enabled: d.status === 'done', click: async () => {
    const r = await dialog.showMessageBox(win, { type: 'warning', message: `Move "${d.name}" to the Recycle Bin?`, buttons: ['Move to Recycle Bin', 'Cancel'], defaultId: 1, cancelId: 1 });
    if (r.response === 0) { try { await shell.trashItem(d.path); } catch {} act.remove(d); sched(0); save(); } } });
  Menu.buildFromTemplate(t).popup({ window: BrowserWindow.fromWebContents(e.sender) });
});

// ---------- start ----------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWin);
  app.on('before-quit', () => { quitting = true; for (const d of dls.values()) if (d.status === 'active') { d.status = 'paused'; d.ctl?.abort(); } writeNow(); });
  app.on('window-all-closed', () => { if (!S.settings.toTray && !quitting) app.quit(); });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.darealdante.downloadmanager');
    Menu.setApplicationMenu(null);
    load(); nativeTheme.themeSource = S.settings.theme; applyLimits(); setTimeout(syncExt, 3000);
    if (!process.argv.includes('--hidden')) mkWin();
    startServer(); setupUpdater();
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Download Manager'); tray.on('click', showWin); trayMenu();
    // Max speed is measured one time, 8 seconds after the first start. Never in a loop.
    setTimeout(async () => {
      if (S.settings.maxBps || [...dls.values()].some(d => d.status === 'active')) return;
      const v = await measure(); if (v > 0) { S.settings.maxBps = Math.round(v); applyLimits(); save(); sendFull(); }
    }, 8000);
  });
}
