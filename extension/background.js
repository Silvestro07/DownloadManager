const BASE = 'http://127.0.0.1:48721';
let cache = { t: 0, v: null }; // the app answer is kept for 5 seconds
async function api(path, opt) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 1500);
  try { return await (await fetch(BASE + path, { ...opt, signal: c.signal })).json(); }
  finally { clearTimeout(t); }
}
async function status() {
  if (cache.v && Date.now() - cache.t < 5000) return cache.v;
  const v = await api('/ping'); // fails if the app is closed: Chrome keeps the download
  cache = { t: Date.now(), v }; return v;
}
chrome.downloads.onCreated.addListener(async item => {
  try {
    const url = item.finalUrl || item.url;
    if (!/^https?:/i.test(url) || item.byExtensionId) return;
    const host = new URL(url).hostname;
    const [st, cookies] = await Promise.all([status(), chrome.cookies.getAll({ url })]);
    if (!st.intercept || (st.exclude || []).some(s => host === s || host.endsWith('.' + s))) return;
    const size = item.totalBytes > 0 ? item.totalBytes : 0;
    if (st.minSize && size > 0 && size < st.minSize) return;
    const headers = { 'User-Agent': navigator.userAgent };
    if (item.referrer) headers.Referer = item.referrer;
    if (cookies.length) headers.Cookie = cookies.map(c => c.name + '=' + c.value).join('; ');
    const r = await api('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, headers, size }) });
    if (r.ok) { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); }
  } catch (e) { cache = { t: 0, v: null }; }
});
