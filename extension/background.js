const BASE = 'http://127.0.0.1:48721';
let cache = { t: 0, v: null }; // the app answer is kept for 5 seconds
async function api(path, opt, timeout = 1500) {
  const c = new AbortController(), t = timeout ? setTimeout(() => c.abort(), timeout) : null;
  try { return await (await fetch(BASE + path, { ...opt, signal: c.signal })).json(); }
  finally { if (t) clearTimeout(t); }
}
async function status() {
  if (cache.v && Date.now() - cache.t < 5000) return cache.v;
  const v = await api('/ping'); // fails if the app is closed: Chrome keeps the download
  cache = { t: Date.now(), v }; return v;
}
chrome.downloads.onCreated.addListener(async item => {
  let paused = false;
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

    // Keep Chrome's download available until the app has successfully prepared its own copy.
    try { await chrome.downloads.pause(item.id); paused = true; } catch {}
    const r = await api('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, headers, size }) }, 600000);
    if (r.ok) {
      await chrome.downloads.cancel(item.id).catch(() => {});
      await chrome.downloads.erase({ id: item.id }).catch(() => {});
    } else if (paused) {
      await chrome.downloads.resume(item.id).catch(() => {});
    }
  } catch (e) {
    if (paused) await chrome.downloads.resume(item.id).catch(() => {});
    cache = { t: 0, v: null };
  }
});
