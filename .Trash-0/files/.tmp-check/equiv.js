const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('ui/index.html', 'utf8');
const b64 = /data-wasm="([^"]+)"/.exec(html)[1];
const wasmBytes = Buffer.from(b64, 'base64');

(async () => {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const ex = instance.exports;

  const kernel = fs.readFileSync('.tmp-check/s2.js', 'utf8');
  const sandbox = { window: {}, console, TextDecoder, TextEncoder, Uint8Array, Int32Array, Float64Array, Math, Date, Error, Proxy, Object };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(kernel, sandbox);
  const k = sandbox.window.__loadJsKernel();

  const TOKENS = ['N', 'T', 'P', 'I6', 'F1', 'F8', 'F22', 'A6', 'L6.41'];
  function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x; }; }

  let bad = 0, frames = 0;
  for (let s = 1; s <= 12; s++) {
    const ha = ex.sim_new_micro(), hb = k.sim_new_micro();
    let fa = 0, fb = 0;
    const r = rng(s);
    for (let f = 0; f < 25; f++) {
      const toks = [];
      for (let i = 0; i < 1 + (r() % 3); i++) toks.push(TOKENS[r() % TOKENS.length]);
      const t = toks.join(' ');
      const buf = Buffer.from(t, 'utf8');
      const ptr = ex.alloc(buf.length);
      new Uint8Array(ex.memory.buffer).set(buf, ptr);
      const rcA = ex.sim_tick(ha, BigInt(++fa), ptr, buf.length, 0n);
      const la = ex.frame_buf_len();
      const A = Buffer.from(new Uint8Array(ex.memory.buffer).slice(ex.frame_buf_ptr(), ex.frame_buf_ptr() + la));

      const ptr2 = k.alloc(buf.length);
      const km = k.memory.buffer ? new Uint8Array(k.memory.buffer) : new Uint8Array(k.memory);
      km.set(buf, ptr2);
      const rcB = k.sim_tick(hb, ++fb, 0, ptr2, buf.length, 0, 0);
      const lb = k.frame_buf_len();
      const B = Buffer.from(km.slice(k.frame_buf_ptr(), k.frame_buf_ptr() + lb));

      frames++;
      if (rcA !== rcB || !A.equals(B)) { bad++;
        if (bad === 1) console.log('DIAG tok', JSON.stringify(t), 'len', A.length, B.length,
          'A', A.slice(0,12).toString('hex'), 'B', B.slice(0,12).toString('hex'));
        break; }
    }
  }
  console.log(`frames ${frames}, mismatches ${bad}`);
  process.exit(bad ? 1 : 0);
})();
