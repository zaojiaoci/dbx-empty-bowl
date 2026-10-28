const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync('ui/index.html', 'utf8');
const b64 = /data-wasm="([^"]+)"/.exec(html)[1];
(async () => {
  const { instance } = await WebAssembly.instantiate(Buffer.from(b64, 'base64'), {});
  const ex = instance.exports;
  const sandbox = { window: {}, console, TextDecoder, TextEncoder, Uint8Array, Int32Array, Float64Array, Math, Date, Error, Proxy, Object };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('.tmp-check/s2.js', 'utf8'), sandbox);
  const k = sandbox.window.__loadJsKernel();
  const ha = ex.sim_new_micro(), hb = k.sim_new_micro();
  const km = k.memory.buffer ? new Uint8Array(k.memory.buffer) : new Uint8Array(k.memory);
  const seq = ['', 'F8', 'I6', 'N', 'T'];
  for (let i = 0; i < seq.length; i++) {
    const buf = Buffer.from(seq[i]);
    const pa = ex.alloc(buf.length); new Uint8Array(ex.memory.buffer).set(buf, pa);
    const rcA = ex.sim_tick(ha, BigInt(i + 1), pa, buf.length, 0n);
    const la = Number(ex.frame_buf_len());
    const pb = k.alloc(buf.length); km.set(buf, pb);
    const rcB = k.sim_tick(hb, i + 1, 0, pb, buf.length, 0, 0);
    const lb = Number(k.frame_buf_len());
    console.log(i, JSON.stringify(seq[i]), 'rc', rcA, rcB, 'len', la, lb);
  }
})();
