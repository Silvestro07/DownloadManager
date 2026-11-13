const { Transform } = require('stream');

// Token bucket. rate = bytes per second. rate 0 = no limit.
class Bucket {
  constructor() { this.rate = 0; this.tokens = 0; this.last = Date.now(); this._r = 0; }
  take(n) {
    if (!this.rate) return 0;
    const now = Date.now();
    if (this._r !== this.rate) { this._r = this.rate; this.tokens = this.rate * 0.25; this.last = now; }
    this.tokens = Math.min(this.rate * 0.25, this.tokens + (now - this.last) * this.rate / 1000);
    this.last = now; this.tokens -= n;
    return this.tokens < 0 ? -this.tokens * 1000 / this.rate : 0;
  }
}
// Pass-through stream that counts bytes and waits when a bucket is empty.
function throttle(onBytes, buckets) {
  return new Transform({
    highWaterMark: 262144,
    transform(chunk, enc, cb) {
      onBytes(chunk.length);
      let w = 0;
      for (const b of buckets()) w = Math.max(w, b.take(chunk.length));
      w > 0 ? setTimeout(cb, w, null, chunk) : cb(null, chunk);
    }
  });
}

// Abort a request only after it has stopped making progress for the given interval.
function idleTimeout(parent, ms = 45000) {
  const ctl = new AbortController();
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error('Download stalled: no data received')), ms);
    timer.unref?.();
  };
  const abort = () => { clearTimeout(timer); ctl.abort(parent.reason); };
  if (parent) {
    if (parent.aborted) abort();
    else parent.addEventListener('abort', abort, { once: true });
  }
  if (!ctl.signal.aborted) reset();
  return {
    signal: ctl.signal,
    activity: () => { if (!ctl.signal.aborted) reset(); },
    dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
  };
}

const DEFAULT_CATS = {
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif', 'tiff'],
  Videos: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg'],
  Audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub', 'rtf', 'odt'],
  Programs: ['exe', 'msi', 'apk', 'dmg', 'iso', 'deb', 'appx']
};
const catOf = (cats, ext) => Object.keys(cats).find(c => cats[c].includes(ext)) || '';
// A rule for the exact type wins over a rule for its category.
function findRule(rules, cats, ext) {
  if (!ext) return null;
  return rules.find(r => r.kind === 'ext' && r.key === ext) ||
         rules.find(r => r.kind === 'cat' && (cats[r.key] || []).includes(ext)) || null;
}
function migrateRules(r) {
  if (Array.isArray(r)) return r;
  return Object.entries(r || {}).map(([k, dir]) => ({ id: 'm' + k, kind: 'ext', key: k, dir, limit: 0 }));
}
function parseRuleKey(cats, text) {
  const t = String(text).trim().replace(/^\./, '');
  const c = Object.keys(cats).find(n => n.toLowerCase() === t.toLowerCase());
  return c ? { kind: 'cat', key: c } : { kind: 'ext', key: t.toLowerCase().replace(/[^a-z0-9]/g, '') };
}
module.exports = { Bucket, throttle, idleTimeout, DEFAULT_CATS, catOf, findRule, migrateRules, parseRuleKey };
