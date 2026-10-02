// Test harness: loads the <script data-section="..."> blocks of the DELIVERED file (../electricity-retail-prototype.html)
// into a Node vm context, one vm script per block (like separate <script> tags), with a localStorage shim.
// Pure sections (util, storage-rawstore, repo, nem12, nem12-sample, seed, engine, svc) need no DOM.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const HTML = process.env.APP_HTML || path.join(__dirname, '..', 'electricity-retail-prototype.html');
const SECTION_OF = { '10-util.js': 'util', '20-storage-rawstore.js': 'storage-rawstore', '30-repo.js': 'repo', '40-nem12.js': 'nem12', '41-nem12-sample.js': 'nem12-sample', '50-seed.js': 'seed', '60-engine.js': 'engine', '70-svc.js': 'svc' };
const blocks = Object.fromEntries([...fs.readFileSync(HTML, 'utf8').matchAll(/<script data-section="([^"]+)">\n([\s\S]*?)\n<\/script>/g)].map(m => [m[1], m[2]]));

function makeLocalStorage(store, quotaChars) {
  const total = () => { let n = 0; for (const [k, v] of store) n += k.length + v.length; return n; };
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      v = String(v);
      const prev = store.has(k) ? k.length + store.get(k).length : 0;
      if (quotaChars != null && total() - prev + k.length + v.length > quotaChars) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
      store.set(k, v);
    },
    removeItem: k => { store.delete(k); },
    key: i => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
}
function loadFile(ctx, f) {
  const name = SECTION_OF[f] || f;
  if (!blocks[name]) throw new Error(`Section "${name}" not found in ${HTML}`);
  vm.runInContext(blocks[name], ctx, { filename: name + '.js' });
}
function makeContext({ store = new Map(), quotaChars = null, noStorage = false, files = [] } = {}) {
  const sandbox = { console, TextEncoder, TextDecoder, structuredClone, btoa, atob, crypto: globalThis.crypto, setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask, URL, Blob };
  if (!noStorage) sandbox.localStorage = makeLocalStorage(store, quotaChars);
  const ctx = vm.createContext(sandbox);
  for (const f of files) loadFile(ctx, f);
  ctx.__store = store;
  return ctx;
}
const ev = (ctx, expr) => vm.runInContext(expr, ctx);
const CORE = ['10-util.js', '20-storage-rawstore.js', '30-repo.js'];
module.exports = { makeContext, loadFile, ev, CORE, HTML };
