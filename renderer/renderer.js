let S = null, view = 'downloads';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i]; };
const eta = s => { if (!isFinite(s) || s <= 0) return ''; s = Math.round(s); return s > 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min' : s > 60 ? Math.floor(s / 60) + ' min ' + s % 60 + ' s' : s + ' s'; };
const updText = u => ({ idle: '', checking: 'Checking for updates…', none: 'You have the latest version.', available: `Version ${u.version} found. Downloading…`,
  downloading: `Downloading update… ${Math.round(u.percent || 0)}%`, ready: `Version ${u.version} is ready.`, error: 'Update check failed.' }[u.state] || '');
const BTN = { active: ['pause', 'cancel'], queued: ['cancel'], preparing: ['cancel'], paused: ['resume', 'cancel'], error: ['retry', 'remove'], done: ['open', 'folder', 'remove'], canceled: ['remove'] };
const LBL = { pause: 'Pause', cancel: 'Cancel', resume: 'Resume', retry: 'Retry', remove: 'Remove', open: 'Open', folder: 'Show in folder' };
const DL_ACTS = Object.keys(LBL);

function statusText(d) {
  if (d.status === 'active') return `${fmt(d.got)} of ${d.size ? fmt(d.size) : 'unknown size'} · ${fmt(d.speed)}/s ${d.size ? eta((d.size - d.got) / d.speed) : ''}`;
  if (d.status === 'done') return `${fmt(d.size || d.got)} · saved in ${d.dir}`;
  if (d.status === 'error') return 'Failed: ' + d.error;
  if (d.status === 'paused') return `Paused at ${fmt(d.got)}`;
  if (d.status === 'preparing') return 'Waiting for folder…';
  return d.status[0].toUpperCase() + d.status.slice(1);
}
function renderList() {
  const l = $('#list'); if (!l) return;
  l.innerHTML = S.downloads.length ? S.downloads.map(d => {
    const pct = d.status === 'done' ? 100 : d.size ? d.got / d.size * 100 : 0;
    const ind = d.status === 'active' && !d.size;
    return `<div class="card ${d.status === 'done' ? 'done' : d.status === 'error' ? 'err' : ''}"><div class="row"><div style="min-width:0"><div class="nm">${esc(d.name)}</div></div>
      <div class="acts">${(BTN[d.status] || []).map(a => `<button data-act="${a}" data-id="${d.id}">${LBL[a]}</button>`).join('')}</div></div>
      <div class="pb ${ind ? 'ind' : ''}"><i style="width:${pct}%"></i></div><div class="sub">${esc(statusText(d))}</div></div>`;
  }).join('') : '<div class="empty">No downloads yet.<br>Paste a link above, or install the browser extension in Settings.</div>';
}
function toggle(k, title, hint) {
  return `<div class="set"><div>${title}<small>${hint}</small></div><label class="tg"><input type="checkbox" data-set="${k}" ${S.settings[k] ? 'checked' : ''}><span></span></label></div>`;
}
function renderRules(m) {
  const rows = Object.entries(S.rules).sort();
  m.innerHTML = `<h1>Folder rules</h1><table>${rows.map(([e, p]) => `<tr><td class="ex">.${esc(e)}</td><td class="pth">${esc(p)}</td>
    <td class="ac"><button data-act="rule-chg" data-ext="${esc(e)}">Change</button> <button data-act="rule-del" data-ext="${esc(e)}">Remove</button></td></tr>`).join('')}</table>
    ${rows.length ? '' : '<div class="empty">No rules yet. Add one below, or download a file and choose a folder.</div>'}
    <div class="bar"><input type="text" id="rext" placeholder="File type, for example mp4"><button class="pri" data-act="rule-add">Choose folder and add</button></div>
    <div class="sub">Files with no rule go to your default folder.</div>`;
}
function renderSettings(m) {
  const s = S.settings;
  m.innerHTML = `<h1>Settings</h1>
  <h2>Downloads</h2>
  ${toggle('intercept', 'Capture browser downloads', 'Send Chrome downloads to this app.')}
  <div class="set"><div>Default folder<small>${esc(s.downloadDir)}</small></div><button data-act="pickdir">Change</button></div>
  <div class="set"><div>Simultaneous downloads<small>From 1 to 10.</small></div><input type="number" min="1" max="10" data-set="maxConcurrent" value="${s.maxConcurrent}"></div>
  <div class="set" style="display:block"><div>Excluded sites<small>Chrome handles these sites. One per line, for example example.com</small></div><textarea data-set="excludedSites">${esc(s.excludedSites.join('\n'))}</textarea></div>
  <h2>Questions</h2>
  ${toggle('askNewType', 'Ask where to save new file types', 'Shown when a file type has no rule.')}
  ${toggle('askDefault', 'Ask to make the folder the default', 'Shown after you choose a folder.')}
  <div class="set"><div>Reset "Don't ask again"<small>Turn all questions back on.</small></div><button data-act="ignored">Reset</button></div>
  <h2>App</h2>
  ${toggle('notify', 'Notify when a download finishes', 'Windows notification.')}
  ${toggle('startWithWindows', 'Start with Windows', 'Starts hidden in the tray.')}
  ${toggle('toTray', 'Keep running in the tray when closed', 'Downloads continue in the background.')}
  <h2>Browser extension</h2>
  <div class="set"><div>Install in Chrome<small>1. Click Open folder. 2. Open chrome://extensions and turn on Developer mode. 3. Click Load unpacked and choose that folder.</small></div><button class="pri" data-act="ext">Open folder</button></div>
  <h2>Updates</h2>
  <div class="set"><div>Version ${esc(S.version)}<small id="upd">${esc(updText(S.update))}</small></div>
  <div class="acts"><button data-act="upd-check">Check now</button><button class="pri" data-act="upd-install" id="updbtn" ${S.update.state === 'ready' ? '' : 'hidden'}>Restart and update</button></div></div>`;
}
function render() {
  $('#app').innerHTML = `<aside><div class="brand">Download Manager</div>${[['downloads', 'Downloads'], ['rules', 'Folder rules'], ['settings', 'Settings']]
    .map(([k, l]) => `<button class="nav ${k === view ? 'on' : ''}" data-nav="${k}">${l}</button>`).join('')}<div class="ver">v${esc(S.version)}</div></aside><main id="main"></main>`;
  const m = $('#main');
  if (view === 'downloads') { m.innerHTML = '<h1>Downloads</h1><div class="bar"><input type="text" id="url" placeholder="Paste a link to download"><button class="pri" data-act="add">Add download</button></div><div id="list"></div>'; renderList(); }
  else if (view === 'rules') renderRules(m); else renderSettings(m);
}
const refresh = async () => { S = await api.state(); render(); };

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-nav],[data-act]'); if (!t) return;
  if (t.dataset.nav) { view = t.dataset.nav; render(); return; }
  const a = t.dataset.act, id = +t.dataset.id;
  if (a === 'add') { const v = $('#url').value.trim(); if (v) { await api.invoke('add', v); $('#url').value = ''; } }
  else if (DL_ACTS.includes(a)) await api.invoke('dl', id, a);
  else if (a === 'rule-add') { const x = $('#rext').value.trim(); if (!x) return $('#rext').focus(); const dir = await api.invoke('pick'); if (dir) { await api.invoke('rule:set', x, dir); refresh(); } }
  else if (a === 'rule-chg') { const dir = await api.invoke('pick'); if (dir) { await api.invoke('rule:set', t.dataset.ext, dir); refresh(); } }
  else if (a === 'rule-del') { await api.invoke('rule:del', t.dataset.ext); refresh(); }
  else if (a === 'pickdir') { const dir = await api.invoke('pick'); if (dir) { await api.invoke('set', { downloadDir: dir }); refresh(); } }
  else if (a === 'ignored') { await api.invoke('ignored:clear'); refresh(); }
  else if (a === 'ext') api.invoke('ext:open');
  else if (a === 'upd-check') api.invoke('update:check');
  else if (a === 'upd-install') api.invoke('update:install');
});
document.addEventListener('change', async e => {
  const k = e.target.dataset.set; if (!k) return;
  let v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Math.min(10, Math.max(1, +e.target.value || 3)) : e.target.value;
  if (k === 'excludedSites') v = v.split(/[\s,]+/).filter(Boolean).map(x => x.toLowerCase());
  await api.invoke('set', { [k]: v }); S = await api.state();
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'url') document.querySelector('[data-act=add]').click(); });
api.onState(s => {
  S = s;
  if (view === 'downloads') renderList();
  else if (view === 'settings' && $('#upd')) { $('#upd').textContent = updText(S.update); $('#updbtn').hidden = S.update.state !== 'ready'; }
});
refresh();
