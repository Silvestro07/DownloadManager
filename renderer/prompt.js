(async () => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]; };
  const d = await api.invoke('prompt:init'); if (!d) return;
  document.documentElement.dataset.theme = d.theme === 'system' ? '' : d.theme;
  const ask = d.ext && !d.hasRule;
  $('#pw').innerHTML = `<h2>Save file</h2><div class="hint">${esc([fmt(d.size), d.host].filter(Boolean).join(' · '))}</div>
    <label for="n">File name</label><input type="text" id="n" value="${esc(d.name)}">
    <label>Save in</label><div class="bar"><input type="text" id="dir" readonly value="${esc(d.dir)}"><button class="btn" id="br">Browse</button></div>
    ${ask ? `<label class="chk"><input type="checkbox" id="rem" checked><span>Always save</span><select id="sc"><option value="ext">.${esc(d.ext)} files</option>${d.cat ? `<option value="cat">${esc(d.cat)} (all types)</option>` : ''}</select><span>here</span></label>
    <label class="chk"><input type="checkbox" id="nv"><span>Don't ask again for .${esc(d.ext)}</span></label>` : ''}
    <div class="dbtn"><button class="btn" id="cn">Cancel</button><button class="btn pri" id="go">Download</button></div>`;
  const n = $('#n'); n.focus(); const i = d.name.lastIndexOf('.'); n.setSelectionRange(0, i > 0 ? i : d.name.length);
  $('#br').onclick = async () => { const p = await api.invoke('pick', $('#dir').value); if (p) $('#dir').value = p; };
  const go = () => api.invoke('prompt:done', { name: n.value, dir: $('#dir').value, remember: !!($('#rem') && $('#rem').checked), scope: $('#sc') ? $('#sc').value : 'ext', never: !!($('#nv') && $('#nv').checked) });
  $('#go').onclick = go; $('#cn').onclick = () => api.invoke('prompt:done', null);
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') go(); if (e.key === 'Escape') api.invoke('prompt:done', null); });
})();
