// Downloads one file in several parts at the same time (HTTP Range).
// Each part keeps its own position, so pause, resume and restart keep working.
const fs = require('fs');
const { pipeline } = require('stream/promises'), { Readable } = require('stream');
const { throttle } = require('./util');
const MB = 1048576;
const writers = new WeakMap();
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    const ws = fs.createWriteStream(o.part, { flags: 'r+', start: from, highWaterMark: 262144 });
    writers.set(s, { ws, from });
    try {
      const r = await fetch(o.url, { headers: { ...o.headers, 'Accept-Encoding': 'identity', Range: `bytes=${from}-${s.e}` }, signal: o.signal });
      if (r.status !== 206) {
        r.body?.cancel().catch(() => {});
        const e = new Error(r.ok ? 'Server ignored range' : 'HTTP ' + r.status); e.code = r.ok ? 'NORANGE' : 'HTTP' + r.status; throw e;
      }
      await pipeline(Readable.fromWeb(r.body), throttle(o.onBytes, o.buckets), ws, { signal: o.signal });
      sync(s); return;
    } catch (e) {
      sync(s);
      if (o.signal.aborted || e.code === 'NORANGE' || attempt >= 3) throw e;
      o.onRetry && o.onRetry();
      await sleep(600 * (attempt + 1));
    }
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
module.exports = { plan, run, sync, done };
