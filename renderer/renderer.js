'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MB = 1048576;
const fmt = n => { if (!n || n < 0) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]; };
const spd = n => fmt(n) + '/s';
const mbps = n => Math.round(n * 8 / 1e6) + ' Mbps';
const eta = s => { if (!isFinite(s) || s <= 0) return ''; s = Math.round(s); return (s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min' : s >= 60 ? Math.floor(s / 60) + ' min ' + s % 60 + ' s' : s + ' s') + ' left'; };
const when = d => new Date(d.done || d.added).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const I = {
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>', settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', plus: '<path d="M12 5v14M5 12h14"/>', pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="M7 5l12 7-12 7z"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  retry: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrow: '<path d="M5 12h14m-6-6l6 6-6 6"/>', fast: '<path d="M3 6l6 6-6 6M11 6l6 6-6 6M19 8l3 4-3 4"/>',
  snail: '<circle cx="10" cy="10" r="5"/><circle cx="10" cy="10" r="1.6"/><path d="M2 19h16c2.5 0 4-1.5 4-3.5V12M22 12l1.2-3.5M19.5 12l-1-3.5"/>'
};
const ic = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
const HUES = { Images: 330, Videos: 262, Audio: 172, Archives: 38, Documents: 215, Programs: 145 };
const catColor = c => { if (!c) return 'var(--mu)'; let h = HUES[c]; if (h == null) { h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 360; } return `hsl(${h} 65% 62%)`; };
const COMMON = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'flac', 'zip', 'rar', '7z', 'iso', 'exe', 'msi', 'pdf', 'docx', 'xlsx', 'pptx', 'jpg', 'png', 'gif', 'webp', 'torrent', 'apk'];
const MODES = [
  { k: 'slow', i: 'snail', n: 'Slow', t: s => `Slow: ${s.slowPct}% of your max speed`, d: s => `Everything downloads at ${s.slowPct}% of your maximum speed. File type limits still apply.` },
  { k: 'normal', i: 'arrow', n: 'Normal', t: () => 'Normal: full speed, file type limits apply', d: () => 'Full speed. File types with a speed limit keep running slower.' },
  { k: 'fast', i: 'fast', n: 'Fast', t: () => 'Fast: everything at full speed', d: () => 'Everything runs at full speed. All limits are off.' }
];
const LBL = { pause: 'Pause', resume: 'Resume', retry: 'Retry', cancel: 'Cancel' };

let S, dl = new Map(), speed = 0, hist = new Array(60).fill(0), view = 'downloads', tab = 'general', picked = new Set(), last = null, order = [];
const F = { q: '', status: 'all', cat: 'all', date: 'any', day: '', sort: 'date', dir: 'desc' };
const rows = new Map();

function apply(st) { S = st; dl = new Map(st.downloads.map(d => [d.id, d])); speed = st.speed; theme(); }
const theme = () => { document.documentElement.dataset.theme = S.settings.theme === 'system' ? '' : S.settings.theme; };
const reload = async () => apply(await api.invoke('state'));
const catOfExt = e => Object.keys(S.cats).find(c => S.cats[c].includes(e)) || '';
const capBps = () => S.settings.speedMode === 'slow' && S.settings.maxBps ? S.settings.maxBps * S.settings.slowPct / 100 : 0;

// ---------- shell ----------
function build() {
  const rb = (k, l, i) => `<button class="rb" data-nav="${k}"><i class="ri">${ic(i, 22)}</i><span>${l}</span></button>`;
  $('#app').innerHTML = `<nav class="rail"><div class="logo">${ic('download', 22)}</div>${rb('downloads', 'Downloads', 'download')}${rb('settings', 'Settings', 'settings')}<div class="ver">v${esc(S.version)}</div></nav><main id="view"></main>`;
  show();
}
function show() { $$('.rb').forEach(b => b.classList.toggle('on', b.dataset.nav === view)); view === 'downloads' ? buildDownloads() : buildSettings(); }

// ---------- downloads view ----------
const grp = d => d.status === 'done' ? 'done' : d.status === 'error' || d.status === 'canceled' ? 'fail' : 'run';
function buildDownloads() {
  rows.clear();
  const s = S.settings;
  const cats = ['all', ...Object.keys(S.cats), 'Other'];
  $('#view').innerHTML = `<header class="top"><h1>Downloads</h1><div class="grow"></div>
    <button class="btn ghost" data-a="clear">Clear finished</button><button class="btn" data-a="add">${ic('plus')}Add link</button>
    <div class="seg" role="group" aria-label="Speed mode">${MODES.map(m => `<button data-mode="${m.k}" class="${s.speedMode === m.k ? 'on ' + m.k : ''}" title="${esc(m.t(s))}" aria-label="${esc(m.t(s))}">${ic(m.i, 20)}</button>`).join('')}</div></header>
    <section class="hero"><div class="hl"><div class="big" id="spd"></div><div class="cap" id="cap"></div><div id="sts"></div></div><canvas id="gr"></canvas></section>
    <div class="tools"><div class="search">${ic('search', 16)}<input id="q" type="text" placeholder="Search downloads" aria-label="Search downloads" value="${esc(F.q)}"></div>
      <div class="tabs">${[['all', 'All'], ['run', 'Active'], ['done', 'Done'], ['fail', 'Failed']].map(([k, l]) => `<button data-t="${k}" class="${F.status === k ? 'on' : ''}">${l} <b>0</b></button>`).join('')}</div>
      <select id="fcat" aria-label="Category">${cats.map(c => `<option value="${esc(c)}" ${F.cat === c ? 'selected' : ''}>${c === 'all' ? 'All types' : esc(c)}</option>`).join('')}</select>
      <select id="fdate" aria-label="Date">${[['any', 'Any date'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['pick', 'Pick a day']].map(([v, l]) => `<option value="${v}" ${F.date === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="date" id="fday" value="${esc(F.day)}" ${F.date === 'pick' ? '' : 'hidden'}>
      <select id="fsort" aria-label="Sort by">${[['date', 'Sort: Date'], ['name', 'Sort: Name'], ['size', 'Sort: Size'], ['type', 'Sort: Type']].map(([v, l]) => `<option value="${v}" ${F.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="ib" id="fdir" title="Sort direction" aria-label="Sort direction">${ic('down')}</button></div>
    <div id="list" class="list" role="list"></div><div id="empty" class="empty" hidden></div>`;
  $('#fdir').classList.toggle('asc', F.dir === 'asc');
  const list = $('#list');
  list.addEventListener('click', e => {
    const r = e.target.closest('.row'); if (!r) return; const id = +r.dataset.id;
    const b = e.target.closest('[data-act]'); if (b) return void api.invoke('dl', id, b.dataset.act);
    if (e.target.closest('[data-more]')) { if (!picked.has(id)) { picked = new Set([id]); markSel(); } return void api.invoke('dl:menu', [...picked]); }
    if (e.ctrlKey || e.metaKey) picked.has(id) ? picked.delete(id) : picked.add(id);
    else if (e.shiftKey && last != null) { const a = order.indexOf(last), z = order.indexOf(id); if (a > -1 && z > -1) picked = new Set(order.slice(Math.min(a, z), Math.max(a, z) + 1)); }
    else picked = new Set([id]);
    last = id; markSel();
  });
  list.addEventListener('dblclick', e => { const r = e.target.closest('.row'); const d = r && dl.get(+r.dataset.id); if (d && d.status === 'done' && !e.target.closest('button')) api.invoke('dl', d.id, 'open'); });
  list.addEventListener('contextmenu', e => { const r = e.target.closest('.row'); if (!r) return; e.preventDefault(); const id = +r.dataset.id; if (!picked.has(id)) { picked = new Set([id]); last = id; markSel(); } api.invoke('dl:menu', [...picked]); });
  refreshDownloads(); drawGraph();
}
const markSel = () => $$('.row').forEach(r => r.classList.toggle('sel', picked.has(+r.dataset.id)));
function visible(all) {
  const q = F.q.trim().toLowerCase(), now = Date.now(), d0 = new Date().setHours(0, 0, 0, 0);
  const day = F.day ? new Date(F.day + 'T00:00:00').getTime() : 0;
  const r = all.filter(d => {
    if (F.status !== 'all' && grp(d) !== F.status) return false;
    if (F.cat !== 'all' && (d.cat || 'Other') !== F.cat) return false;
    if (q && !`${d.name} ${d.dir || ''} ${d.url}`.toLowerCase().includes(q)) return false;
    const t = d.added;
    if (F.date === 'today' && t < d0) return false;
    if (F.date === '7d' && t < now - 7 * 864e5) return false;
    if (F.date === '30d' && t < now - 30 * 864e5) return false;
    if (F.date === 'pick' && day && (t < day || t >= day + 864e5)) return false;
    return true;
  });
  const m = F.dir === 'asc' ? 1 : -1;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const cmp = { date: (a, b) => a.added - b.added, name: byName, size: (a, b) => (a.size || a.got) - (b.size || b.got), type: (a, b) => (a.ext || '').localeCompare(b.ext || '') || byName(a, b) }[F.sort];
  return r.sort((a, b) => m * cmp(a, b));
}
function rowHTML(d) {
  const lv = ['active', 'paused', 'preparing'].includes(d.status);
  const pct = d.status === 'done' ? 100 : d.size ? Math.min(99, Math.floor(d.got / d.size * 100)) : 0;
  const ind = d.status === 'active' && !d.size;
  let rt;
  if (d.status === 'active') rt = d.size ? `${pct}% · ${spd(d.speed)} ${d.speed ? '· ' + eta((d.size - d.got) / d.speed) : ''}` : `${fmt(d.got)} · ${spd(d.speed)}`;
  else if (d.status === 'paused') rt = 'Paused · ' + (d.size ? pct + '%' : fmt(d.got));
  else if (d.status === 'done') rt = fmt(d.size || d.got);
  else if (d.status === 'preparing') rt = 'Preparing';
  else rt = d.status === 'error' ? 'Failed' : 'Canceled';
  const meta = d.status === 'error' ? esc(d.error || 'Error') : [d.cat || (d.ext ? d.ext.toUpperCase() : 'File'), d.dir, when(d)].filter(Boolean).map(esc).join(' · ');
  const pi = { active: 'pause', paused: 'play', error: 'retry', canceled: 'retry', preparing: 'x' }[d.status];
  const pa = { active: 'pause', paused: 'resume', error: 'retry', canceled: 'retry', preparing: 'cancel' }[d.status];
  return `<div class="tile" style="--c:${catColor(d.cat)}">${esc((d.ext || 'file').slice(0, 4).toUpperCase())}</div>
    <div class="mid"><div class="nm" title="${esc(d.name)}">${esc(d.name)}</div>${lv ? `<div class="pbar ${d.status} ${ind ? 'ind' : ''}"><i style="width:${pct}%"></i></div>` : ''}<div class="meta ${d.status === 'error' ? 'er' : ''}">${meta}</div></div>
    <div class="rt ${d.status}">${esc(rt)}</div>
    <div class="ra">${pi ? `<button class="ib" data-act="${pa}" title="${LBL[pa]}" aria-label="${LBL[pa]}">${ic(pi)}</button>` : ''}<button class="ib" data-more title="More" aria-label="More actions">${ic('more')}</button></div>`;
}
function refreshDownloads() {
  const list = $('#list'); if (!list) return;
  const all = [...dl.values()], cnt = { all: all.length, run: 0, done: 0, fail: 0 };
  for (const d of all) cnt[grp(d)]++;
  $$('.tabs button').forEach(b => { b.lastElementChild.textContent = cnt[b.dataset.t]; });
  const items = visible(all); order = items.map(d => d.id);
  const keep = new Set(order);
  for (const [id, el] of rows) if (!keep.has(id)) { el.remove(); rows.delete(id); }
  items.forEach((d, i) => {
    let el = rows.get(d.id);
    if (!el) { el = document.createElement('div'); el.className = 'row'; el.dataset.id = d.id; el.setAttribute('role', 'listitem'); rows.set(d.id, el); }
    const sig = [d.status, d.name, d.got, d.size, d.speed, d.dir, d.error].join('|');
    if (el._s !== sig) { el._s = sig; el.innerHTML = rowHTML(d); }
    el.classList.toggle('sel', picked.has(d.id));
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  const em = $('#empty'); em.hidden = items.length > 0; list.hidden = !items.length;
  if (!items.length) em.innerHTML = all.length ? '<b>No matches</b><span>Try a different search or filter.</span>'
    : `<b>No downloads yet</b><span>Download a file in Chrome, or paste a link.</span><button class="btn pri" data-a="add">${ic('plus')}Add link</button>`;
  updHero(all);
}
function modeCaption() {
  const s = S.settings;
  if (s.speedMode === 'fast') return 'Fast mode: all limits are off';
  if (s.speedMode === 'slow') return s.maxBps ? `Slow mode: capped at ${spd(capBps())} (${s.slowPct}% of ${spd(s.maxBps)})` : 'Slow mode needs your max speed. Measure it in Settings, Speed.';
  return S.rules.some(r => r.limit) ? 'Normal mode: full speed, file type limits apply' : 'Normal mode: full speed';
}
function updHero(all = [...dl.values()]) {
  const a = $('#spd'); if (!a) return;
  let act = 0, done = 0, today = 0; const d0 = new Date().setHours(0, 0, 0, 0);
  for (const d of all) { if (d.status === 'active') act++; if (d.status === 'done') { done++; if ((d.done || d.added) >= d0) today += d.size || d.got; } }
  const [n, u] = fmt(speed).split(' '); a.innerHTML = `<b style="font-weight:600">${n}</b><span>${u}/s</span>`;
  $('#cap').textContent = modeCaption(); $('#sts').textContent = `${act} active · ${done} completed · ${fmt(today)} today`;
}
function drawGraph() {
  const c = $('#gr'); if (!c) return;
  const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement), ac = css.getPropertyValue('--ac').trim(), mu = css.getPropertyValue('--mu').trim();
  const cap = capBps(), max = Math.max(...hist, cap, MB) * 1.2;
  const Y = v => h - 8 - v / max * (h - 22), P = hist.map((v, i) => [i / (hist.length - 1) * w, Y(v)]);
  const ln = css.getPropertyValue('--ln').trim();
  x.strokeStyle = ln; x.lineWidth = 1; for (let k = 1; k < 4; k++) { const y = Math.round(h * k / 4) + .5; x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); }
  x.beginPath(); x.moveTo(P[0][0], P[0][1]);
  for (let i = 1; i < P.length - 1; i++) x.quadraticCurveTo(P[i][0], P[i][1], (P[i][0] + P[i + 1][0]) / 2, (P[i][1] + P[i + 1][1]) / 2);
  x.lineTo(P[P.length - 1][0], P[P.length - 1][1]);
  x.strokeStyle = ac; x.lineWidth = 2.5; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke();
  x.lineTo(w, h); x.lineTo(0, h); x.closePath();
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, ac + '55'); g.addColorStop(1, ac + '00'); x.fillStyle = g; x.fill();
  if (cap) { const y = Y(cap); x.setLineDash([5, 5]); x.strokeStyle = mu; x.lineWidth = 1; x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); x.setLineDash([]); x.fillStyle = mu; x.font = '11px sans-serif'; x.fillText('limit', w - 34, y - 4); }
}
function setMode(k) {
  S.settings.speedMode = k; api.invoke('set', { speedMode: k });
  $$('.seg button').forEach(b => { b.className = b.dataset.mode === k ? 'on ' + k : ''; });
  updHero(); drawGraph(); if (view === 'settings' && tab === 'speed') pane();
}

// ---------- settings view ----------
const TABS = [['general', 'General'], ['downloads', 'Downloads'], ['speed', 'Speed'], ['types', 'File types'], ['browser', 'Browser'], ['updates', 'Updates']];
function buildSettings() {
  $('#view').innerHTML = `<header class="top"><h1>Settings</h1></header><div class="sgrid"><div class="stabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</div><div class="spane" id="pane"></div></div>`;
  pane();
}
function pane() { $$('.stabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab)); $('#pane').innerHTML = PANES[tab](); }
const row = (t, h, c) => `<div class="set"><div class="st"><b>${t}</b><small>${h || ''}</small></div><div class="sc">${c}</div></div>`;
const tg = k => `<label class="tg"><input type="checkbox" data-set="${k}" ${S.settings[k] ? 'checked' : ''}><span></span></label>`;
const selc = (k, o) => `<select data-set="${k}">${o.map(([v, l]) => `<option value="${v}" ${String(S.settings[k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const updText = u => ({ idle: '', checking: 'Checking for updates…', none: 'You have the latest version.', available: `Version ${u.version} found. Downloading…`, downloading: `Downloading update… ${Math.round(u.percent || 0)}%`, ready: `Version ${u.version} is ready.`, error: 'Update check failed.' }[u.state] || '');
const PANES = {
  general: () => row('Theme', 'Dark, light, or the same as Windows.', selc('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Follow Windows']])) +
    row('Start with Windows', 'Starts hidden in the tray.', tg('startWithWindows')) +
    row('Keep running in the tray when closed', 'Closing the window frees memory. Downloads continue.', tg('toTray')) +
    row('Notify when a download finishes', 'Click the notification to show the file.', tg('notify')) +
    row('Open the file when finished', 'Opens each file after it downloads.', tg('openWhenDone')) +
    row('Clear finished downloads from the list', 'Files on disk are never deleted.', selc('keepDays', [[0, 'Never'], [1, 'After 1 day'], [7, 'After 7 days'], [30, 'After 30 days']])),
  downloads: () => row('Default folder', esc(S.settings.downloadDir), '<button class="btn" data-a="pickdir">Change</button>') +
    row('Ask before each download', 'Shows a popup where you can rename the file and choose the folder.', tg('askEvery')) +
    row('Ask about new file types', 'Shows the popup only when a file type has no folder rule.', tg('askNewType')) +
    row('Reset "Don\'t ask again"', 'Turns the new file type question back on.', '<button class="btn" data-a="ignored">Reset</button>') +
    row('If the file already exists', 'What to do when the name is taken.', selc('onConflict', [['rename', 'Keep both (add a number)'], ['overwrite', 'Replace the old file']])),
  speed: () => {
    const s = S.settings;
    return `<div class="modes">${MODES.map(m => `<button class="mode ${s.speedMode === m.k ? 'on ' + m.k : ''}" data-mode="${m.k}">${ic(m.i, 26)}<b>${m.n}</b><small>${esc(m.d(s))}</small></button>`).join('')}</div>` +
      row('Maximum speed', s.maxBps ? `Measured one time: ${spd(s.maxBps)} (${mbps(s.maxBps)}). Slow mode uses a share of this value.` : 'Not measured yet. The app measures it one time after the first start.',
        `<input type="number" step="0.1" min="0" style="width:90px" data-set="maxBps" data-mult="${MB}" value="${s.maxBps ? (s.maxBps / MB).toFixed(1) : ''}" placeholder="MB/s" aria-label="Maximum speed in MB/s"><button class="btn" data-a="measure">Measure now</button>`) +
      row('Slow mode share', 'Percent of your maximum speed used in slow mode.', `<input type="range" min="5" max="95" step="5" data-set="slowPct" value="${s.slowPct}" aria-label="Slow mode share"><span id="sp">${s.slowPct}%</span>`);
  },
  types: () => {
    const rules = S.rules.map(r => {
      const c = r.kind === 'cat' ? r.key : catOfExt(r.key);
      return `<tr><td style="width:44px"><div class="tile s" style="--c:${catColor(c)}">${esc(r.kind === 'cat' ? r.key.slice(0, 3).toUpperCase() : r.key.slice(0, 4).toUpperCase())}</div></td>
      <td><b>${r.kind === 'cat' ? esc(r.key) : '.' + esc(r.key)}</b><small>${r.kind === 'cat' ? 'Category, ' + (S.cats[r.key] || []).length + ' file types' : 'File type'}</small></td>
      <td class="pth">${esc(r.dir)}</td><td>${r.limit ? r.limit + ' MB/s' : 'No limit'}</td>
      <td class="ac"><button class="btn" data-a="rule-edit" data-id="${r.id}">Edit</button> <button class="btn" data-a="rule-del" data-id="${r.id}">Delete</button></td></tr>`;
    }).join('');
    return `<div class="top" style="padding:0 0 8px"><div class="st"><b>Folder rules</b><small>Each file type or category saves into its own folder. You can add a speed limit too.</small></div><div class="grow"></div><button class="btn pri" data-a="rule-add">${ic('plus')}Add file type</button></div>
      ${rules ? `<table>${rules}</table>` : '<div class="hint" style="padding:18px 0">No rules yet. Click "Add file type", or download a file and choose a folder.</div>'}
      <h3>Categories</h3><div class="hint">A category is a group of file types. Edit the list of types in each one.</div>
      ${Object.keys(S.cats).map(c => `<div class="catrow"><b>${esc(c)}</b><input type="text" data-cat="${esc(c)}" value="${esc(S.cats[c].join(', '))}" aria-label="File types in ${esc(c)}"><button class="btn" data-a="cat-del" data-id="${esc(c)}">Delete</button></div>`).join('')}
      <div style="margin-top:10px"><button class="btn" data-a="cat-add">${ic('plus')}New category</button></div>`;
  },
  browser: () => row('Capture browser downloads', 'Send Chrome downloads to this app.', tg('intercept')) +
    row('Ignore files smaller than (MB)', 'Chrome keeps small files. Use 0 to capture everything.', `<input type="number" min="0" step="1" style="width:90px" data-set="minSizeMB" value="${S.settings.minSizeMB}">`) +
    `<div class="set" style="display:block"><div class="st"><b>Excluded sites</b><small>Chrome handles downloads from these sites. One per line.</small></div><textarea rows="4" style="margin-top:8px" data-set="excludedSites">${esc(S.settings.excludedSites.join('\n'))}</textarea></div>` +
    row('Install the extension in Chrome', '1. Click Open folder. 2. Open chrome://extensions and turn on Developer mode. 3. Click Load unpacked and choose the folder.', '<button class="btn pri" data-a="ext">Open folder</button>'),
  updates: () => row('Version ' + esc(S.version), `<span id="upd">${esc(updText(S.update))}</span>`, `<button class="btn" data-a="upd-check">Check now</button><button class="btn pri" data-a="upd-install" id="updbtn" ${S.update.state === 'ready' ? '' : 'hidden'}>Restart and update</button>`)
};

// ---------- modals ----------
function modal(title, body, ok, onOk) {
  const m = document.createElement('div'); m.className = 'ov';
  m.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${body}<div class="dbtn"><button class="btn" data-x>Cancel</button><button class="btn pri" data-ok>${esc(ok)}</button></div></div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.addEventListener('mousedown', e => { if (e.target === m) close(); });
  $('[data-x]', m).onclick = close;
  $('[data-ok]', m).onclick = async () => { if ((await onOk(m)) !== false) close(); };
  m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('[data-ok]', m).click(); });
  const f = $('input,textarea', m); if (f) f.focus();
  return m;
}
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2600); }
function addModal(text = '') {
  modal('Add links', `<label for="ul">One link per line</label><textarea id="ul" rows="5" placeholder="https://example.com/file.zip">${esc(text)}</textarea>`, 'Download', async m => {
    const v = $('#ul', m).value; if (!/https?:\/\//i.test(v)) { toast('Paste a link that starts with http'); return false; }
    await api.invoke('add', v);
  });
}
function renameModal(id, name) {
  const m = modal('Rename file', `<label for="rn">File name</label><input type="text" id="rn" value="${esc(name)}">`, 'Rename', async m => {
    const err = await api.invoke('dl:rename', id, $('#rn', m).value); if (err) { toast(err); return false; }
  });
  const i = name.lastIndexOf('.'); $('#rn', m).setSelectionRange(0, i > 0 ? i : name.length);
}
function ruleModal(r) {
  const m = modal(r ? 'Edit file type' : 'Add file type', `
    <label for="rk">File type or category</label>
    <input type="text" id="rk" list="kl" placeholder="Pick one below or type your own" value="${esc(r ? (r.kind === 'ext' ? '.' + r.key : r.key) : '')}" ${r ? 'readonly' : ''}>
    <datalist id="kl">${[...Object.keys(S.cats), ...COMMON].map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    ${r ? '' : `<div class="chips">${Object.keys(S.cats).map(c => `<button class="chip" data-fill="${esc(c)}">${esc(c)}</button>`).join('')}</div><div class="hint">Type your own file types, like mp4 or zip. Separate several with commas.</div>`}
    <label>Save in</label><div class="bar"><input type="text" id="rd" readonly value="${esc(r ? r.dir : S.settings.downloadDir)}"><button class="btn" id="rbr">Browse</button></div>
    <label for="rl">Speed limit (MB/s)</label><input type="number" id="rl" min="0" step="0.1" placeholder="No limit" value="${r && r.limit ? r.limit : ''}">`, 'Save', async m => {
    const text = $('#rk', m).value.trim(), dir = $('#rd', m).value;
    if (!text || !dir) { toast('Choose a file type and a folder'); return false; }
    await api.invoke('rule:save', { id: r && r.id, text, dir, limit: +$('#rl', m).value || 0 });
    await reload(); if (view === 'settings') pane();
  });
  $('#rbr', m).onclick = async () => { const d = await api.invoke('pick', $('#rd', m).value); if (d) $('#rd', m).value = d; };
  m.addEventListener('click', e => { const c = e.target.closest('[data-fill]'); if (c) { $('#rk', m).value = c.dataset.fill; } });
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-nav],[data-a],[data-mode],[data-t],[data-tab]'); if (!t) return;
  const d = t.dataset;
  if (d.nav) { view = d.nav; show(); return; }
  if (d.mode) return setMode(d.mode);
  if (d.t) { F.status = d.t; $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === F.status)); return refreshDownloads(); }
  if (d.tab) { tab = d.tab; return pane(); }
  const a = d.a;
  if (a === 'add') addModal();
  else if (a === 'clear') api.invoke('dl:clear');
  else if (a === 'pickdir') { const p = await api.invoke('pick', S.settings.downloadDir); if (p) { S.settings = await api.invoke('set', { downloadDir: p }); pane(); } }
  else if (a === 'ignored') { await api.invoke('ignored:clear'); await reload(); pane(); toast('Questions are on again'); }
  else if (a === 'ext') api.invoke('ext:open');
  else if (a === 'upd-check') api.invoke('update:check');
  else if (a === 'upd-install') api.invoke('update:install');
  else if (a === 'measure') { t.disabled = true; t.textContent = 'Measuring, about 10 s…'; const v = await api.invoke('speed:test'); await reload(); pane(); toast(v ? `Your maximum speed: ${spd(v)} (${mbps(v)})` : 'Could not measure. Check your internet and try again.'); }
  else if (a === 'rule-add') ruleModal();
  else if (a === 'rule-edit') ruleModal(S.rules.find(r => r.id === d.id));
  else if (a === 'rule-del') { await api.invoke('rule:del', d.id); await reload(); pane(); }
  else if (a === 'cat-del') { await api.invoke('cat:del', d.id); await reload(); pane(); }
  else if (a === 'cat-add') modal('New category', '<label for="cn">Name</label><input type="text" id="cn" placeholder="Example: Games"><label for="ce">File types</label><input type="text" id="ce" placeholder="Example: pak, bsp, vpk">', 'Create', async m => {
    const n = $('#cn', m).value.trim(); if (!n) return false; await api.invoke('cat:save', n, $('#ce', m).value); await reload(); pane();
  });
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.cat) { await api.invoke('cat:save', t.dataset.cat, t.value); await reload(); return pane(); }
  if (t.id === 'fcat') { F.cat = t.value; return refreshDownloads(); }
  if (t.id === 'fdate') { F.date = t.value; $('#fday').hidden = F.date !== 'pick'; return refreshDownloads(); }
  if (t.id === 'fday') { F.day = t.value; return refreshDownloads(); }
  if (t.id === 'fsort') { F.sort = t.value; return refreshDownloads(); }
  const k = t.dataset.set; if (!k) return;
  let v = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? (+t.value || 0) * (+t.dataset.mult || 1) : t.value;
  if (k === 'excludedSites') v = t.value.split(/[\s,]+/).filter(Boolean).map(x => x.toLowerCase());
  S.settings = await api.invoke('set', { [k]: v });
  if (k === 'theme') theme();
  if (k === 'maxBps' || k === 'slowPct') pane();
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'q') { F.q = t.value; refreshDownloads(); }
  if (t.dataset.set === 'slowPct') $('#sp').textContent = t.value + '%';
});
document.addEventListener('click', e => { const b = e.target.closest('#fdir'); if (b) { F.dir = F.dir === 'asc' ? 'desc' : 'asc'; b.classList.toggle('asc', F.dir === 'asc'); refreshDownloads(); } });
document.addEventListener('keydown', async e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if (e.ctrlKey && e.key === 'f' && view === 'downloads') { e.preventDefault(); $('#q').focus(); return; }
  if (typing || view !== 'downloads' || document.querySelector('.ov')) return;
  if (e.ctrlKey && e.key === 'v') { const t = await api.invoke('clip'); if (/https?:\/\//i.test(t)) addModal(t); }
  else if (e.ctrlKey && e.key === 'a') { e.preventDefault(); picked = new Set(order); markSel(); }
  else if (e.key === 'Delete') { for (const id of picked) api.invoke('dl', id, 'remove'); picked.clear(); }
  else if (e.key === 'Enter' && picked.size) api.invoke('dl', [...picked][0], 'open');
  else if (e.key === 'F2' && picked.size === 1) { const d = dl.get([...picked][0]); if (d && d.status !== 'active') renameModal(d.id, d.name); }
  else if (e.key === 'Escape') { picked.clear(); markSel(); }
});
api.on('patch', p => {
  for (const d of p.up) dl.set(d.id, d);
  for (const id of p.rm) { dl.delete(id); picked.delete(id); }
  speed = p.speed; if (view === 'downloads') refreshDownloads();
});
api.on('full', st => {
  apply(st);
  if (view === 'downloads') buildDownloads();
  else if ($('#upd')) { $('#upd').textContent = updText(S.update); $('#updbtn').hidden = S.update.state !== 'ready'; }
});
api.on('rename', renameModal);
document.addEventListener('visibilitychange', async () => { if (!document.hidden && S) { await reload(); if (view === 'downloads') refreshDownloads(); } });
setInterval(() => { if (document.hidden || !S) return; hist.push(speed); hist.shift(); if (view === 'downloads') drawGraph(); }, 1000);
window.addEventListener('resize', () => { if (view === 'downloads') drawGraph(); });
(async () => { await reload(); build(); })();
