// Downloads one file in several parts at the same time (HTTP Range).
// Each part keeps its own position, so pause, resume and restart keep working.
const fs = require('fs');
const { pipeline } = require('stream/promises'), { Readable } = require('stream');
const { throttle, idleTimeout } = require('./util');
const MB = 1048576;
const writers = new WeakMap();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCK = ['EPERM', 'EBUSY', 'EACCES'];

// Windows antivirus can lock a new file for a moment. Try again before giving up.
async function openRetry(file, flags) {
  for (let i = 0; ; i++) {
    try { return await fs.promises.open(file, flags); }
    catch (e) { if (i >= 10 || !LOCK.includes(e.code)) throw e; await sleep(250); }
  }
}
async function prealloc(file, size) {
  const fh = await openRetry(file, 'w');
  try { await fh.truncate(size); } finally { await fh.close(); }
}
// Position = first byte not yet written. Read from the real bytes written to disk.
const sync = s => { const w = writers.get(s); if (w) s.pos = w.from + w.ws.bytesWritten; };
const done = segs => segs.reduce((a, s) => a + (s.pos - s.s), 0);
function plan(size, conns) {
  const n = Math.max(2, Math.min(8, conns, Math.floor(size / (2 * MB))));
  const sz = Math.ceil(size / n);
  return Array.from({ length: n }, (_, i) => ({ s: i * sz, e: Math.min(size, (i + 1) * sz) - 1, pos: i * sz }));
}
async function worker(o, s) {
  for (let attempt = 0; ; attempt++) {
    if (s.pos > s.e) return;
    const from = s.pos;
    const idle = idleTimeout(o.signal, 45000);
    let r;
    try {
      r = await fetch(o.url, { headers: { ...o.headers, 'Accept-Encoding': 'identity', Range: `bytes=${from}-${s.e}` }, signal: idle.signal });
      if (r.status !== 206) { const e = new Error(r.ok ? 'Server ignored range' : 'HTTP ' + r.status); e.code = r.ok ? 'NORANGE' : 'HTTP' + r.status; throw e; }
      // The file is opened only now, and the stream goes straight into the pipeline, so an error can never be left unhandled.
      const fh = await openRetry(o.part, 'r+');
      const ws = fh.createWriteStream({ start: from, highWaterMark: 262144 });
      writers.set(s, { ws, from });
      await pipeline(Readable.fromWeb(r.body), throttle(n => { idle.activity(); o.onBytes(n); }, o.buckets), ws, { signal: idle.signal });
      sync(s); return;
    } catch (e) {
      r?.body?.cancel().catch(() => {});
      sync(s);
      if (o.signal.aborted || e.code === 'NORANGE' || /^HTTP\d+$/.test(e.code || '') || LOCK.includes(e.code) || e.code === 'ENOENT' || attempt >= 3) throw e;
      o.onRetry && o.onRetry();
      await sleep(600 * (attempt + 1));
    } finally { idle.dispose(); }
  }
}
// o: { url, headers, part, segs, signal, abort, onBytes, buckets, onRetry }
async function run(o) {
  const res = await Promise.allSettled(o.segs.map(s => worker(o, s).catch(e => { o.abort(); throw e; })));
  o.segs.forEach(sync);
  if (o.segs.every(s => s.pos > s.e)) return;
  const bad = res.find(x => x.status === 'rejected' && x.reason?.name !== 'AbortError') || res.find(x => x.status === 'rejected');
  throw bad ? bad.reason : new Error('Download incomplete');
}
module.exports = { plan, run, sync, done, prealloc };
