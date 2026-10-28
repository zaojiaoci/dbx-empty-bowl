/**
 * sim-client.js — 网页版切片的 WASM 客户端核心。
 *
 * 两层：
 *   1. C ABI 封装（sim_new/sim_tick/缓冲区读取）——见 crates/sim/src/ffi.rs 的格式说明；
 *   2. 帧二进制解析（Encoder 小端流 → 节点表）。
 *
 * 本文件**不碰 DOM**：Node 冒烟测试（smoke.mjs）直接 require 它跑脚本化会话，
 * 浏览器里由 app.js 消费。UMD 尾巴让两种环境都能加载。
 *
 * 确定性边界：seed 只从 URL 参数来（缺省固定值），禁 Date.now/Math.random——
 * 与 sim 的 ARCH §7 纪律同源。输入流每帧累积成 `.rec` 文本（host 格式，可直接回放）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SimClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TEXT_DECODER = new TextDecoder();

  // ---------------------------------------------------------------- 帧解析

  class Reader {
    constructor(buf) {
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.pos = 0;
    }
    u8() {
      return this.view.getUint8(this.pos++);
    }
    u64() {
      const v = this.view.getBigUint64(this.pos, true);
      this.pos += 8;
      return Number(v);
    }
    i64() {
      const v = this.view.getBigInt64(this.pos, true);
      this.pos += 8;
      return Number(v);
    }
    str() {
      const len = this.u64();
      const bytes = new Uint8Array(
        this.view.buffer,
        this.view.byteOffset + this.pos,
        len,
      );
      this.pos += len;
      return TEXT_DECODER.decode(bytes);
    }
    /** Encoder::bytes 的线上形：u64 长度前缀 + 原始字节。 */
    bytes() {
      const len = this.u64();
      const out = new Uint8Array(
        this.view.buffer,
        this.view.byteOffset + this.pos,
        len,
      );
      this.pos += len;
      return out;
    }
  }

  // 节点 kind 与 Rust 侧 encode_node 的编码一一对应。
  const KIND = { Col: 0, Row: 1, Stack: 2, Scroll: 3, Text: 4, Button: 5, Bar: 6 };

  function parseStyle(r) {
    const style = {
      role: r.u8(),
      color: r.u8(),
      align: r.u8(),
      weight: r.u8(),
      scalePermille: r.i64(),
      cjk: r.u8(),
      decayKind: r.u8(), // 0 None / 1 Tracking / 2 Blur / 3 Drop / 4 Shift
      decaySeverity: r.u8(), // 0 Slight / 1 Moderate / 2 Severe
      referenced: r.u8() !== 0, // 本帧被台词引用的卡（sim 标记，无机制语义）
      anchored: r.u8() !== 0, // 折过角 ⇒ 纸片留一个翘起的角（v0.39，只标痕迹不报次数）
      // 页码（书的外壳）。0 = 不属于任何页；台词 = 那一页，卡片 = 它入场的那页。
      page: r.u64(),
    };
    return style;
  }

  /**
   * 解析一帧。返回 { frame, stateHash(hex), nodes: [{kind, id, ...}] }。
   * nodes 保持 Rust 侧的顺序（tree[0] 是 root，ARCH §4.1 扁平表约定）。
   */
  function parseFrame(bytes) {
    const r = new Reader(bytes);
    const frame = r.u64();
    const hashBytes = r.bytes(); // Encoder::bytes = u64 len + data（len 恒为 32）
    if (hashBytes.length !== 32) {
      throw new Error(`state_hash 长度 ${hashBytes.length} ≠ 32——流错位`);
    }
    const stateHash = Array.from(hashBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const nodeCount = r.u64();
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      const kind = r.u8();
      const id = r.u64();
      switch (kind) {
        case KIND.Col:
        case KIND.Row:
        case KIND.Stack: {
          const gapPermille = r.i64();
          const n = r.u64();
          const children = [];
          for (let c = 0; c < n; c++) children.push(r.u64());
          nodes.push({ kind, id, gapPermille, children });
          break;
        }
        case KIND.Scroll: {
          const child = r.u64();
          nodes.push({ kind, id, child });
          break;
        }
        case KIND.Text: {
          const style = parseStyle(r);
          const content = r.str();
          nodes.push({ kind, id, style, content });
          break;
        }
        case KIND.Button: {
          const action = r.u64();
          const child = r.u64();
          const enabled = r.u8() !== 0;
          nodes.push({ kind, id, action, child, enabled });
          break;
        }
        case KIND.Bar: {
          const ratioPermille = r.i64();
          const barRole = r.u8();
          const fill = r.u8();
          nodes.push({ kind, id, ratioPermille, barRole, fill });
          break;
        }
        default:
          throw new Error(`未知节点 kind=${kind}（id=${id}）`);
      }
    }
    if (r.pos !== bytes.byteLength) {
      throw new Error(`帧有 ${bytes.byteLength - r.pos} 字节未消费——解析与编码不同步`);
    }
    return { frame, stateHash, nodes };
  }

  // ---------------------------------------------------------------- 客户端

  /**
   * 包装一个 WASM 实例为切片客户端。
   * @param {WebAssembly.Instance} instance
   * @param {{v2?: boolean, micro?: boolean}} [opts] micro=true 走微缩版（形态 B：
   *   8 卡两章单结局，2026-10-27）；v2=true 走 slice-v2 窄全链路（四章 + 结局 C）；
   *   否则 v1（两章）。三者共用同一份 sim，只是卡池/剧本/容量表不同。
   */
  function createClient(instance, opts) {
    const ex = instance.exports;
    const v2 = !!(opts && opts.v2);
    const micro = !!(opts && opts.micro);
    const mem = () => new Uint8Array(ex.memory.buffer);
    const copyBuf = (ptrFn, lenFn) => {
      const ptr = ptrFn();
      const len = lenFn();
      return mem().slice(ptr, ptr + len); // 立刻拷走：指针不能跨调用持有
    };
    const writeText = (text) => {
      const bytes = new TextEncoder().encode(text);
      // 借用 sim_tick 的动作参数通道不行——它自己读。改为直接传 JS 字符串由
      // 调用方编码进 wasm 内存太绕；sim_tick 的 actions_ptr 由 allocate 提供。
      const ptr = ex.alloc(bytes.length);
      mem().set(bytes, ptr);
      return { ptr, len: bytes.length };
    };

    let handle = micro ? ex.sim_new_micro() : v2 ? ex.sim_new_v2() : ex.sim_new();
    ex.sim_digests(handle);
    const digests = copyBuf(ex.digest_buf_ptr, ex.digest_buf_len); // 64B: facts++variants

    const hex = (bytes) =>
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    return {
      /** 当前帧号（sim 侧权威值，避免 JS 计数器漂移）。 */
      frame: () => Number(ex.sim_frame(handle)),
      /** 推进一步。actionsText 是 token 串（"A6 N"），与 .rec 行内格式一致。 */
      tick(actionsText) {
        const { ptr, len } = writeText(actionsText || '');
        const frame = Number(ex.sim_frame(handle)) + 1;
        const rc = ex.sim_tick(handle, BigInt(frame), ptr, len, 0n);
        if (rc !== 0) {
          const err = TEXT_DECODER.decode(
            copyBuf(ex.err_buf_ptr, ex.err_buf_len),
          );
          throw new Error(`sim_tick 失败（rc=${rc}）：${err}`);
        }
        return parseFrame(copyBuf(ex.frame_buf_ptr, ex.frame_buf_len));
      },
      digestsHex() {
        return { facts: hex(digests.slice(0, 32)), variants: hex(digests.slice(32)) };
      },
      digests,
    };
  }

  return { createClient, parseFrame, KIND };
});
