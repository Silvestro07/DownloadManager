const BASE = 'http://127.0.0.1:48721';
const seen = new Set(); // download ids that were already handled
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
    if (item.byExtensionId || seen.has(item.id)) return;
    seen.add(item.id); if (seen.size > 500) seen.delete(seen.values().next().value);
    // Only a brand-new, running download is taken. Chrome can also report old downloads from its history.
    // Taking those would download old files again.
    if (item.state !== 'in_progress') return;
    const age = Date.now() - Date.parse(item.startTime);
    if (!(age > -5000 && age < 15000)) return;
    const url = item.finalUrl || item.url;
    if (!/^https?:/i.test(url)) return;
    const host = new URL(url).hostname;
    const [st, cookies] = await Promise.all([status(), chrome.cookies.getAll({ url })]);
    if (!st.intercept || (st.exclude || []).some(s => host === s || host.endsWith('.' + s))) return;
    const size = item.totalBytes > 0 ? item.totalBytes : 0;
    if (st.minSize && size > 0 && size < st.minSize) return;
    const headers = { 'User-Agent': navigator.userAgent };
    if (item.referrer) headers.Referer = item.referrer;
    if (cookies.length) headers.Cookie = cookies.map(c => c.name + '=' + c.value).join('; ');
    // A very small file may already be finished. Then Chrome keeps it and the app does not download it again.
    const [cur] = await chrome.downloads.search({ id: item.id });
    if (!cur || cur.state !== 'in_progress') return;
    try { await chrome.downloads.cancel(item.id); } catch (e) { return; }
    let ok = false;
    try { ok = (await api('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 2, url, headers, size }) })).ok; } catch (e) {}
    if (ok) await chrome.downloads.erase({ id: item.id });
    else chrome.downloads.download({ url }); // the app did not take it: Chrome downloads it (this one is skipped by the check above)
  } catch (e) { cache = { t: 0, v: null }; }
});
