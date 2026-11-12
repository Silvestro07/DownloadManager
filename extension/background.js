const BASE = 'http://127.0.0.1:48721';
async function api(path, opt) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 1500);
  try { return await (await fetch(BASE + path, { ...opt, signal: c.signal })).json(); }
  finally { clearTimeout(t); }
}
chrome.downloads.onCreated.addListener(async item => {
  try {
    const url = item.finalUrl || item.url;
    if (!/^https?:/i.test(url) || item.byExtensionId) return;
    const host = new URL(url).hostname;
    const st = await api('/ping'); // fails if the app is closed: Chrome keeps the download
    if (!st.intercept || (st.exclude || []).some(s => host === s || host.endsWith('.' + s))) return;
    const headers = { 'User-Agent': navigator.userAgent };
    if (item.referrer) headers.Referer = item.referrer;
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length) headers.Cookie = cookies.map(c => c.name + '=' + c.value).join('; ');
    const r = await api('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, headers }) });
    if (r.ok) { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); }
  } catch (e) {}
});
