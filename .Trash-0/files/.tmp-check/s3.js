/* audio.js — 环境声层（v0.39）。
 *
 * 为什么有这一层，以及它为什么长这样：
 * - 作者原话「只有文字有些单调」。诊断后确认单调的真因不是缺装饰，而是**全作
 *   最独特的动词（折角）在画面上没有痕迹**（已由 .card.folded 补上），以及
 *   房间里没有声音。所以这一层补的是"房间"，不是"配乐"。
 * - 硬约束（story-decisions 第 13 题）：**永不给他/它声音**（009「我不知道他的
 *   声音是什么样的。我想过很多次，每次都停住了」）。所以这里没有语音、没有旋律、
 *   没有任何会"评论情绪"的东西——只有房间本身：电流底噪般的低频、纸声、以及
 *   记忆池变空时一层层退掉的环境层。
 * - 与预告片分镜（marketing.md §2.1）对齐：电流底噪 / 翻页声 / 一声很轻的错位音。
 *   分镜里本来就写了环境声，只是游戏里一直没有。
 *
 * 纪律：
 * - 零素材、零网络：全部 WebAudio 现场合成（单文件 HTML 分发不受影响）。
 * - 零哈希：只读宿主持有的画面事实（池里几张、翻没翻页），不碰 sim。
 * - 可静音、可永久关：偏好写 localStorage；prefers-reduced-motion 默认关。
 * - 无 WebAudio 的环境（node/smoke/jsdom/老浏览器）全套静默无害——所有导出
 *   函数在检测失败时变成 no-op，调用方不需要 try/catch。
 */
(function (global) {
  'use strict';

  var AC = global.AudioContext || global.webkitAudioContext;
  var KEY = 'crossgame-audio';

  function store() {
    try {
      return global.localStorage;
    } catch (e) {
      return null; // file:// 下部分浏览器禁 localStorage；当场退化为不持久化
    }
  }

  function reduced() {
    return !!(
      global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  // 偏好：默认开（环境声不叙述、不抢台词），reduced-motion 默认关。
  function readPref() {
    var s = store();
    if (s) {
      var v = s.getItem(KEY);
      if (v === 'on' || v === 'off') return v === 'on';
    }
    return !reduced();
  }

  var ctx = null;
  var master = null;
  var bed = []; // { osc, gain, lfo } × 4，池子越空剩得越少
  var enabled = readPref();
  var started = false;

  // 四层环境声的基频：低到像房间，不像乐器。层数 = f(池里活着的卡)。
  var BED_FREQS = [46, 61, 92, 123];

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  function ensureCtx() {
    if (ctx || !AC) return false;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? 1 : 0;
      master.connect(ctx.destination);
      return true;
    } catch (e) {
      ctx = null;
      return false;
    }
  }

  function startBed() {
    if (started || !ctx) return;
    started = true;
    for (var i = 0; i < BED_FREQS.length; i++) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = BED_FREQS[i];
      var gain = ctx.createGain();
      gain.gain.value = 0;
      // 每层一个极慢的呼吸（0.03–0.07Hz）：房间的起伏，不是旋律。
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.031 + i * 0.013;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.016;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 320;
      osc.connect(gain);
      gain.connect(lp);
      lp.connect(master);
      osc.start();
      lfo.start();
      bed.push({ osc: osc, gain: gain, lfo: lfo });
    }
    // 初始层数按当前池子给；pool() 之后每帧校正。
    applyLayers(0, 4);
  }

  // 目标层数：池里活着的卡越多，房间越满。删卡 ⇒ 层退掉（可闻的"变空"）。
  function targetLayers(n) {
    if (n >= 12) return 4;
    if (n >= 8) return 3;
    if (n >= 4) return 2;
    return 1;
  }

  function applyLayers(from, to) {
    for (var i = 0; i < bed.length; i++) {
      var want = i < to ? 1 : 0;
      bed[i].gain.gain.cancelScheduledValues(now());
      bed[i].gain.gain.setValueAtTime(bed[i].gain.gain.value, now());
      // 退层慢（8s），进层快（3s）：失去是慢慢的，得到是一下的。
      bed[i].gain.gain.linearRampToValueAtTime(want * 0.05, now() + (want ? 3 : 8));
    }
  }

  var curLayers = 4;

  // ------------------------------------------------------------- 导出 API

  var api = {
    /** 当前是否开着（按钮文字与 aria-pressed 用它）。 */
    enabled: function () {
      return enabled;
    },

    /** 首次用户手势时调用：建上下文、起环境层。浏览器自动播放策略要求先有手势。 */
    unlock: function () {
      if (!ensureCtx()) return;
      if (ctx.state === 'suspended') ctx.resume();
      if (enabled) startBed();
    },

    /** 开/关。关 = 总增益归零并挂起上下文（不是删节点，再开时房间接着呼吸）。 */
    setEnabled: function (on, persist) {
      enabled = !!on;
      if (persist !== false) {
        var s = store();
        if (s) {
          try {
            s.setItem(KEY, enabled ? 'on' : 'off');
          } catch (e) {
            /* 隐私模式：不持久化，本次会话仍生效 */
          }
        }
      }
      if (!AC) return;
      if (enabled) {
        if (ensureCtx()) {
          if (ctx.state === 'suspended') ctx.resume();
          startBed();
        }
      } else if (ctx) {
        master.gain.setTargetAtTime(0, now(), 0.15);
        if (ctx.state === 'running') ctx.suspend();
      }
      if (enabled && ctx) {
        // 再开时把总增益送回去（disable 时归过零，不送就永远哑的）。
        master.gain.setTargetAtTime(1, now(), 0.2);
      }
    },

    /** 池里活着的卡变了：层数跟着变（删除 ⇒ 可闻地变空）。 */
    pool: function (n) {
      if (!ctx || !started) return;
      var t = targetLayers(n);
      if (t !== curLayers) {
        applyLayers(curLayers, t);
        curLayers = t;
      }
    },

    /** 翻页：一声很轻的纸声（带通噪声，0.1s 衰减）。 */
    cueFlip: function () {
      if (!ctx || !enabled || ctx.state !== 'running') return;
      var len = Math.floor(ctx.sampleRate * 0.12);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        // 纸声不是白噪：前 40% 能量集中，尾部指数衰减。
        var t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2) * (t < 0.4 ? 1 : 0.35);
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2100;
      bp.Q.value = 0.6;
      var g = ctx.createGain();
      g.gain.value = 0.15;
      src.connect(bp);
      bp.connect(g);
      g.connect(master);
      src.start();
    },

    /** 抽掉一张：低频轻轻一沉（120→60Hz，0.35s）。不敲丧钟——它自己都不当回事。 */
    cueGone: function () {
      if (!ctx || !enabled || ctx.state !== 'running') return;
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, now());
      osc.frequency.exponentialRampToValueAtTime(60, now() + 0.35);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.08, now());
      g.gain.exponentialRampToValueAtTime(0.0001, now() + 0.4);
      osc.connect(g);
      g.connect(master);
      osc.start();
      osc.stop(now() + 0.42);
    },

    /** 容量墙 / 装不下：一声很轻的错位音（两个差 12Hz 的正弦互相拍）。
     *  预告片分镜里那声"账本对不上"的游戏内同源物。 */
    cueWall: function () {
      if (!ctx || !enabled || ctx.state !== 'running') return;
      [196, 208].forEach(function (f) {
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now());
        g.gain.linearRampToValueAtTime(0.04, now() + 0.08);
        g.gain.exponentialRampToValueAtTime(0.0001, now() + 0.7);
        osc.connect(g);
        g.connect(master);
        osc.start();
        osc.stop(now() + 0.72);
      });
    },

    /** 折角/锚定：一声短促的"啪"——纸被折弯的脆响。
     *  翻页是"纸页在手上过"，折角是"手指捏住纸角翻过去"的主动触感。
     *  比翻页声稍响（0.20 vs 0.15），因为是玩家主动操作的确认。 */
    cueAnchor: function () {
      if (!ctx || !enabled || ctx.state !== 'running') return;
      var len = Math.floor(ctx.sampleRate * 0.08);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        // 前 20% 集中爆发，后 80% 指数衰减——"啪"一下，不是持续的沙沙声。
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 4.5) * (t < 0.2 ? 1 : 0.25);
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1400;
      var g = ctx.createGain();
      g.gain.value = 0.2;
      src.connect(hp);
      hp.connect(g);
      g.connect(master);
      src.start();
    },
  };

  global.CROSSGAME_AUDIO = api;

  // 首次手势才解锁（自动播放策略 + 不擅自开始响）。
  if (AC && enabled) {
    var onGesture = function () {
      api.unlock();
      global.removeEventListener('pointerdown', onGesture);
      global.removeEventListener('keydown', onGesture);
    };
    global.addEventListener('pointerdown', onGesture);
    global.addEventListener('keydown', onGesture);
  }
})(typeof window !== 'undefined' ? window : globalThis);
