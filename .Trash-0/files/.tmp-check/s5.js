/**
 * app.js — 网页版切片的 DOM 渲染与交互层。
 *
 * 架构位置：sim 核心（Rust/WASM）产出 UiTree → sim-client.js 解析为节点表 →
 * 本文件渲染为 DOM 并把点击合成为动作 token。**本层不含任何游戏规则**：
 * 所有语义判断（能不能折、残迹、超容）都来自 sim 的状态行与门控，
 * 这里只做「选中卡 + 动词 → token」的合成，token 格式与 CLI/.rec 完全一致。
 *
 * 与 CLI 的对应：`n`→翻页按钮（宿主 chrome，sim 不发 Next 按钮）、`a 6`→选中卡+折角、
 * `i 6`→摊开、`t`→账按钮。动词全表见 `host-headless` 的 HELP。
 *
 * 纪律：页面不渲染任何精度数值（DESIGN §6.2）——只渲染强度条与 DecayFx 视觉。
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // ---------------------------------------------------------------- 装配

  const params = new URLSearchParams(location.search);
  const SEED = Number(params.get('seed') || '42');
  // slice-v2 窄全链路（四章 + 结局 C）：两条路都通向 v2——
  // ① dist/crossgame-v2.html 独立文件（build.py 内嵌默认开关，测试者双击即玩，
  //    不需要懂查询参数；文件传输/聊天预览会吞掉 ?v2=1，所以分发走独立文件）；
  // ② 主文件 URL 加 ?v2=1（smoke / dom-verify 等机器路径沿用）。
  // v1（两章）保持默认——两条链路共用同一份 sim，只是卡池/剧本不同。
  const V2 = window.CROSSGAME_DEFAULT_V2 === true || params.get('v2') === '1';
  // 微缩版（2026-10-27，DBX 插件形态 B）：8 卡两章单结局，15-20 分钟。
  // 第三条链路——dist/crossgame-micro.html 或 ?micro=1。与 v2 互斥（micro 优先）。
  // 单结局 = 复用 v2 的「把账放到它面前」那颗按钮（终幕台词同为 ending_c），
  // 所以 V2 的黑盒判据（「由你决定」「我一直在维护一场对话」）对 micro 全部成立。
  const MICRO = window.CROSSGAME_DEFAULT_MICRO === true || params.get('micro') === '1';

  /** @type {ReturnType<SimClient.createClient>} */
  let client = null;
  /** 每帧的动作 token 文本（.rec 行内格式，原样累积，不做任何加工）。 */
  const frames = [];
  /** 当前选中卡号；关联动作的第二段用 pendingLink 暂存。 */
  let selected = null;
  let pendingLink = null;
  let auditOpen = false;
  /** 最近一帧的解析结果（渲染的唯一数据源）。 */
  let last = null;
  /** 折角首次触发追踪（v0.42）：记录上一帧每张卡的 anchored 状态。
   *  从 false→true 的跳变 = 玩家刚折了这张卡，此时挂 fold-anim class + 播声音。
   *  模块级 Map——跨帧存活；renderPool 末尾更新为当前帧状态。 */
  const prevAnchored = new Map();

  /** 终局记忆清单的数据（v0.49，micro）：卡的「见过」登记 + 动作层的下场。
   *  删卡（F###）与并入（L###.### 别进它里边，抽掉时搬进家）都会让卡离池，
   *  只有动作层分得清「删了」还是「搬走了」——所以命运记在 send() 里，
   *  卡名记在 renderPool 首见时。零 sim 改动、零哈希风险。 */
  const cardSeen = new Map(); // id → 卡名（首见登记，入场序）
  const linkHome = new Map(); // 源 id → 家 id（L###.### 的并入指定）
  const cardFate = new Map(); // id → 下场文案（F### 时定格）

  // ---------------------------------------------------------------- token 合成

  function send(tokens) {
    // 首次交互就解锁环境声——file:// 下 pointerdown 监听器可能晚一拍被触发
    // （浏览器延迟挂起的 AudioContext 必须在用户手势里显式 resume）。
    if (window.CROSSGAME_AUDIO) window.CROSSGAME_AUDIO.unlock();
    for (const tok of tokens) {
      const l = /^L(\d+)\.(\d+)$/.exec(tok);
      if (l) linkHome.set(Number(l[1]), Number(l[2]));
      const f = /^F(\d+)$/.exec(tok);
      if (f) {
        const id = Number(f[1]);
        const dst = linkHome.get(id);
        cardFate.set(
          id,
          dst
            ? `并进 ${String(dst).padStart(3, '0')} 里了`
            : '删了，回声只剩最淡一档',
        );
      }
    }
    const text = tokens.join(' ');
    const frame = client.frame() + 1;
    frames.push({ n: frame, text });
    last = client.tick(text);
    selected = null;
    pendingLink = null;
    render();
  }

  // ---------------------------------------------------------------- 渲染

  const SLOT_LABELS = [
    ['a', '关于'], ['w', '何时'], ['p', '何地'], ['y', '为何'], ['o', '结果'],
  ];

  function nodeById(id) {
    return last.nodes.find((n) => n.id === id);
  }

  /** 按角色取文本（位置假设全部作废——按语义扫，可选节点不破坏布局）。 */
  function textsByRole(role) {
    return last.nodes.filter(
      (n) => n.kind === SimClient.KIND.Text && n.style.role === role,
    );
  }

  /** Text role 数值（与 Rust enc_role 一致）。 */
  const ROLE = { Body: 0, Title: 1, Caption: 2, Dialogue: 3, System: 4, Reason: 5, Keep: 6 };
  const ACTION = { ANCHOR: 1, FORGET: 2, LINK: 3, QUERY: 4, AUDIT: 5, NEXT: 6 };

  function decayClass(style) {
    if (!style) return '';
    const cls = [];
    if (style.cjk === 2) cls.push('cjk-loose'); // Loose：失真档的粘连错位
    const kind = style.decayKind;
    if (kind !== 0) {
      const name = ['', 'tracking', 'blur', 'drop', 'shift'][kind];
      cls.push(`fx-${name}-${style.decaySeverity}`);
    }
    return cls.join(' ');
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderTitle() {
    const t = textsByRole(ROLE.Title)[0];
    const host = $('#title');
    host.textContent = '';
    if (!t) return;
    // 页眉 = 「第 N 章 · 章名」+ 右侧一行书的状态。
    // 章名是 sim 发的（只进 UI，不进任何摘要），宿主不猜章节号。
    host.appendChild(el('span', 'chapter', t.content));
    const spine = spineStatus();
    if (spine) host.appendChild(el('span', 'spine', spine));
  }

  /** 书脊状态的人话版：sim 发的是机器可解析的「书脊 n / cap」，这里翻成人话。
   *  「记忆池 9 / 14」是系统读数，「书脊上夹着 9 张，还能夹 5 张」是物理状态——
   *  同一件事，后者才回答「我做得怎么样」（docs/shell-book.md §7 第 3 条）。 */
  function spineStatus() {
    const hdr = textsByRole(ROLE.System).find((n) => /^书脊 /.test(n.content));
    if (!hdr) return '';
    const m = /^书脊\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/.exec(hdr.content);
    if (!m) return '';
    const held = Number(m[1]);
    const cap = Number(m[2]);
    const left = cap - held;
    const pages = textsByRole(ROLE.Dialogue).length;
    const tail = ` · 已翻到第 ${pages} 页`;
    if (left < 0) return `夹着 ${held} 张，超了 ${-left} 张${tail}`;
    return `夹着 ${held} 张，还能夹 ${left} 张${tail}`;
  }

  /** 抽掉了几张（书脊第三段）。宿主据此在书页流末尾画空白页——
   *  目标层机制二（docs/shell-book.md §4）：抽掉得越多，书里空页越多。 */
  function tornOutCount() {
    const hdr = textsByRole(ROLE.System).find((n) => /^书脊 /.test(n.content));
    if (!hdr) return 0;
    const m = /^书脊\s*\d+\s*\/\s*\d+\s*\/\s*(\d+)/.exec(hdr.content);
    return m ? Number(m[1]) : 0;
  }

  /** 摊开的旧页（点一下展开，再点收起）。纯视图状态，不进任何摘要。 */
  let openPages = new Set();

  /** v0.29 翻页（方案 A）：上一帧的当前页码 + 上次翻页时刻。
   *  页码没变就不翻（动词重渲染不重播动画）；冷却内连翻只换页不播动画。 */
  let lastPageNo = 0;
  let lastFlipAt = 0;
  const FLIP_COOLDOWN_MS = 300;

  /** 玩家要求减少动态效果时完全不播翻页动画（CSS 媒体查询同判，双保险）。 */
  function reducedMotion() {
    try {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch (_) {
      return false;
    }
  }

  /** v0.29 翻页：当前页页码变了 ⇒ 翻一页。元素每帧重建 ⇒ 动画类只活一帧，
   *  同页内的动词重渲染天然不会重播。慢翻播完整动画，快翻瞬切。 */
  /** v0.35：翻页之后，把刚翻出来的那一页带进视野。
   *
   *  此前「翻页」按钮排在书脊（最多 14 张纸片）之后，翻到第 20 页时它离书页流
   *  有一屏半远：点一次翻页，新的一页出现在屏幕**上方**，玩家得往上滚回去看
   *  （作者实测原话：「实施的那一页还要往上翻才能看到」）。翻页是最高频动作，
   *  这条来回滚动是纯粹的摩擦，而且每多翻一页就多滚一点。
   *
   *  只在**页码真变了**的时候滚——动词（摊开/折角/抽掉）的重渲染不滚，否则
   *  玩家每点一次按钮画面都要跳一次。 */
  function scrollCurrentPageIntoView(cur) {
    // jsdom（.tmp/dom-verify.mjs）无布局引擎，scrollIntoView 不存在——不防御会抛。
    if (!cur || typeof cur.scrollIntoView !== 'function') return;
    try {
      cur.scrollIntoView({
        block: 'nearest',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
    } catch (_) {
      /* 老浏览器不认 options 形式：跳过即可——书页流本身已滚到底，看得见。 */
    }
  }

  function maybeFlip() {
    const cur = $('#stage').querySelector('.page.current');
    if (!cur) return;
    const pageNo = Number(cur.dataset.page || 0);
    if (pageNo === lastPageNo) return;
    // v0.39 环境声层：纸真的翻过去了，就有一声纸声（audio.js 静默无害）。
    if (window.CROSSGAME_AUDIO) window.CROSSGAME_AUDIO.cueFlip();
    const now = Date.now();
    if (now - lastFlipAt > FLIP_COOLDOWN_MS && !reducedMotion()) {
      cur.classList.add('flip-in');
    }
    lastPageNo = pageNo;
    lastFlipAt = now;
    scrollCurrentPageIntoView(cur);
  }

  function renderDialogue() {
    const host = $('#stage');
    host.textContent = '';
    const pages = textsByRole(ROLE.Dialogue);
    // 卡片按页码分组：卡要钉在它入场的那一页的页边（docs/shell-book.md §2）。
    // 页边的纸片是**只读的痕迹**（它当时夹了什么），可操作的那份在书脊区——
    // 两处角色不同，不是重复列表。
    const byPage = new Map();
    for (const n of textsByRole(ROLE.Body)) {
      if (!/^\d{3} /.test(n.content)) continue;
      const p = n.style.page;
      if (!p) continue;
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(n);
    }

    pages.forEach((n, i) => {
      const page = n.style.page || i + 1;
      const isLast = i === pages.length - 1;
      const open = isLast || openPages.has(page);
      const notes = byPage.get(page) || [];
      const pageEl = el('div', 'page' + (isLast ? ' current' : ' folded') + (open ? ' open' : ''));
      // v0.29 翻页：页码落到 DOM 上，maybeFlip 据此判断「这一帧是不是新的一页」。
      pageEl.dataset.page = String(page);
      const head = el('button', 'page-head');
      head.appendChild(el('span', 'page-no', `第 ${page} 页`));
      const preview = n.content.replace(/^它：/, '');
      head.appendChild(el('span', 'page-preview', preview));
      if (notes.length) head.appendChild(el('span', 'page-notes', `夹 ${notes.length} 张`));
      if (!isLast) {
        head.addEventListener('click', () => {
          if (openPages.has(page)) openPages.delete(page);
          else openPages.add(page);
          render();
        });
      } else {
        head.disabled = true;
      }
      pageEl.appendChild(head);
      if (open) {
        pageEl.appendChild(el('p', 'line ' + decayClass(n.style), n.content));
        if (notes.length) {
          const strip = el('div', 'page-slips');
          for (const c of notes) {
            const raw = c.content.replace('（残迹）', '');
            const mm = /^(\d{3})\s+(.+)$/.exec(raw);
            const label = mm ? mm[2] : raw;
            const slip = el('span', 'slip', label);
            if (c.content.includes('（残迹）')) slip.classList.add('traced');
            strip.appendChild(slip);
          }
          pageEl.appendChild(strip);
        }
      }
      host.appendChild(pageEl);
    });
    // 空白页（目标层机制二）：抽掉的纸片越多，书里空页越多。
    // 不给数字条、不给百分比（§6.2 硬纪律），只让书自己变空——
    // 玩家数得出来空了几页，但界面不替他数。
    const torn = tornOutCount();
    if (torn > 0) {
      const blanks = el('div', 'blank-pages');
      for (let i = 0; i < torn; i++) blanks.appendChild(el('span', 'blank-page'));
      blanks.appendChild(el('span', 'blank-cap', `空了 ${torn} 页`));
      host.appendChild(blanks);
    }
    // v0.35：书页流定高内滚 ⇒ 这一行从此真的生效（此前书页流无限高，没有可滚的
    // 余量，等于没写）。**只在新的一页出现时滚到底**——玩家点开旧页回看历史时，
    // 不该被任何一次重渲染弹回底部（点卡片、摊开都会 render）。
    // 判断复用 lastPageNo：此时 maybeFlip 还没跑，它仍是上一帧的页码。
    const curNo = pages.length ? Number(pages[pages.length - 1].style.page || pages.length) : 0;
    if (pages.length && curNo !== lastPageNo) host.scrollTop = host.scrollHeight;
    // v0.29 翻页（方案 A）：放在末尾——此时新当前页已在 DOM 里。
    maybeFlip();
    // 终局信号（判据见 endingPlayed 注记）：v1 剧本末行「对话暂停」；v2 要按
    // 「把账放到它面前」，终幕台词里的「我一直在维护一场对话」。
    if (endingPlayed()) {
      // 终局：把累积的输入流装进回收面板（host .rec 格式，原样可回放）。
      showRecPanel();
    }
  }

  /** 终幕是否已演过。纯黑盒：只读对话流，不碰 sim（零哈希）。
   *  - v1：剧本末行「对话暂停」，到此结束。
   *  - v2：剧本末行是「……由你决定」——**这不是终局**，玩家还要按「把账放到
   *    它面前」（结局 C）；结局的终局信号是终幕台词里的「我一直在维护一场对话」。
   *  v0.44 起兼任第二份工：「把账放到它面前」按钮的存废判据——结局后还亮着它，
   *  玩家会再按一次，只换来一句「这一局已经收尾了。」（作者 2026-10-24 结局实测：
   *  打完屏幕没有任何变化——回收面板躺在文档最底部没人带它进视野——于是又点了
   *  那枚最醒目的红按钮）。web 只通结局 C，A/B 是 CLI 路径，判据不必覆盖它们。 */
  function endingPlayed() {
    const lines = textsByRole(ROLE.Dialogue).map((n) => n.content);
    return V2 || MICRO
      ? lines.some((c) => c.includes('我一直在维护一场对话'))
      : lines.some((c) => c.includes('对话暂停'));
  }

  /** 显示回收面板并填充当前输入流（终局自动 / 提前导出共用）。
   *  中途流失的测试者没有终局信号——没有这个入口，远程样本只剩微信追问，
   *  「远程看流失」就收不到硬数据（2026-10-16 补）。 */
  /** decay 令牌 → 回声档位文案（memory.rs decay_fx_of 的逆映射）。
   *  卡名的失真令牌由 core 按 tier 推导进帧（§4.1，进 state_hash 的那个 decay）：
   *  0 None⇒原文 / 1 Tracking⇒模糊 / 3 Drop⇒失真 / 2 Blur⇒编造。 */
  function tierLabel(style) {
    const k = style && style.decayKind;
    if (k === 1) return '模糊';
    if (k === 3) return '失真';
    if (k === 2) return '编造';
    return '原文';
  }

  /** 终局记忆清单（v0.49，micro）：把「删哪张」的后果显性化。回声四档是本作
   *  的重玩价值，但一刷玩家删完就忘，等于最深的玩法对多数人不存在。数据全部
   *  取自已渲染过的帧（在场状态 + decay 令牌）与 send() 留下的动作下场，
   *  零 sim 改动、零哈希风险。只在终局出（提前导出不出——那是流失样本的自救口，
   *  不是收成展示的时机）。 */
  function buildMemoryList() {
    const host = document.createElement('div');
    host.id = 'memory-list';
    host.style.cssText =
      'margin:18px 0 4px;padding:12px 14px;border:1px solid rgba(128,128,128,.35);' +
      'border-radius:6px;font-size:14px;line-height:1.9;';
    const h = document.createElement('div');
    h.style.cssText = 'font-size:13px;opacity:.75;margin-bottom:6px;';
    h.textContent = '记忆清单';
    host.appendChild(h);
    // 本帧还在书脊上的卡（与 renderPool 同一条筛选路）。
    const live = new Map();
    last.nodes
      .filter(
        (n) =>
          n.kind === SimClient.KIND.Text &&
          n.style.role === ROLE.Body &&
          /^\d{3} /.test(n.content),
      )
      .forEach((c) => live.set(Number(c.content.slice(0, 3)), c));
    cardSeen.forEach((name, id) => {
      const c = live.get(id);
      let fate;
      if (c) {
        const traced = c.content.includes('（残迹）');
        fate = traced
          ? '成了残迹，读不出了'
          : tierLabel(c.style) === '原文'
            ? '还在书脊，回声还是原文'
            : `还在书脊，回声已经${tierLabel(c.style)}`;
      } else {
        fate = cardFate.get(id) || '删了，回声只剩最淡一档';
      }
      const row = document.createElement('div');
      row.textContent = `${String(id).padStart(3, '0')} ${name} —— ${fate}`;
      host.appendChild(row);
    });
    return host;
  }

  function showRecPanel() {
    $('#rec-panel').classList.remove('hidden');
    $('#rec-text').value = buildRec();
    // 终局记忆清单（v0.49）：放在回收面板**前面**——先看这一局的收成，
    // 再看导出框。只出一次、只在终局出。
    const panel0 = $('#rec-panel');
    if (MICRO && endingPlayed() && !document.getElementById('memory-list')) {
      panel0.parentNode.insertBefore(buildMemoryList(), panel0);
    }
    // 微缩版 Credits（2026-10-27）：只在微缩版出现，只出现一次——署名演化
    // 故事 + 完整版去处。落点是「Credits 屏署名」（不是弹窗、不是横幅）。
    // 沙箱没有 openExternal，新窗口也未必放行 ⇒ 这里只写地址、不挂 <a>：
    // 不挂 <a>：可读、可抄，点击走商店页的 homepage。
    if (MICRO) {
      if (!document.getElementById('micro-credits')) {
        const c = document.createElement('div');
        c.id = 'micro-credits';
        c.style.cssText =
          'margin-top:18px;padding-top:12px;border-top:1px solid rgba(128,128,128,.35);opacity:.85;font-size:14px;line-height:1.7;';
        c.innerHTML =
          '<p>空碗 · 十五分钟——从 dbx-sql-guard 的哈希链思想演化而来。</p>' +
          '<p>这份清单只是开头。那份对不上的东西到底是什么，把账放到它面前之后' +
          '又发生了什么——完整版里会摊开。</p>' +
          '<p>完整版（四章 14 卡三个结局，约 90 分钟）免费，在 itch.io：' +
          'zaojiaoci.itch.io/it-is-maintaining-a-conversation</p>';
        panel0.parentNode.insertBefore(c, panel0.nextSibling);
      }
    }
    // v0.44（作者结局实测）：终局时面板曾躺在文档最底部，没有任何东西把它带进
    // 视野——玩家打完看到「什么都没发生」，又去点那枚红按钮，只换来一句
    // 「这一局已经收尾了。」。与提前导出同一条路：出现即进视野。
    // v0.49：终局时记忆清单在面板正上方 ⇒ 滚它（面板紧随其后一起进视野）。
    // block:'nearest' 不抢终幕台词——它就在面板上方一屏内。
    const panel = document.getElementById('memory-list') || $('#rec-panel');
    if (typeof panel.scrollIntoView !== 'function') return; // jsdom（dom-verify）无布局引擎
    try {
      panel.scrollIntoView({
        behavior: reducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
      });
    } catch (_) {
      /* 老浏览器不认 options 形式：面板在页尾，手动滚一屏就到。 */
    }
  }

  function renderPool() {
    const host = $('#pool');
    host.textContent = '';
    // 卡片 = Body 文本「001 名字」；强度条 = 同 cell 的 Bar（push 顺序成对）。
    const cards = last.nodes.filter(
      (n) =>
        n.kind === SimClient.KIND.Text &&
        n.style.role === ROLE.Body &&
        /^\d{3} /.test(n.content),
    );
    const bars = last.nodes.filter((n) => n.kind === SimClient.KIND.Bar);
    const hdr = textsByRole(ROLE.System).find((n) => /^书脊 /.test(n.content));
    if (hdr) {
      // 2026-10-17：页眉带上「n / cap」——超容墙前玩家在书脊区连点删卡，
      // 「为什么翻不动」必须出现在他正看着的地方（状态行在屏幕另一端）。
      const m = /^书脊 (\d+) \/ (\d+) \/ (\d+)/.exec(hdr.content);
      const label = m
        ? `书脊上现在夹着的纸片（${m[1]} / ${m[2]}${Number(m[1]) > Number(m[2]) ? '，满了' : ''}）`
        : '书脊上现在夹着的纸片';
      host.appendChild(el('h2', 'pool-hdr ' + (hdr.style.color === 2 ? 'danger' : ''), label));
    }

    const grid = el('div', 'grid');
    // 摊开视觉追踪：sim 发 ROLE.Caption 节点格式 "NNN：..."，
    // 即这张卡当前正被摊开看。零哈希——Caption 本身就是 UI 层信号。
    const inspectedIds = new Set();
    textsByRole(ROLE.Caption).forEach((n) => {
      const m = /^(\d{3})：/.exec(n.content);
      if (m) inspectedIds.add(Number(m[1]));
    });
    // 折角首次触发检测（v0.42）：本帧 anchored，但上一帧还不是 ⇒ 刚被折。
    const justAnchored = new Set();
    cards.forEach((c) => {
      const id = Number(c.content.slice(0, 3));
      const now = !!(c.style && c.style.anchored);
      const was = prevAnchored.get(id) || false;
      if (now && !was) justAnchored.add(id);
      prevAnchored.set(id, now);
    });
    // 播声音（host 侧；audioTick 没拆到折角，单独在这触发）
    if (justAnchored.size > 0 && window.CROSSGAME_AUDIO) {
      window.CROSSGAME_AUDIO.cueAnchor();
    }
    cards.forEach((c, i) => {
      const id = Number(c.content.slice(0, 3));
      const traced = c.content.includes('（残迹）');
      const bar = bars[i];
      const cell = el(
        'button',
        'card' +
          (selected === id ? ' selected' : '') +
          (traced ? ' traced' : '') +
          (c.style && c.style.referenced ? ' lit' : '') +
          (c.style && c.style.anchored ? ' folded' : '') +
          (inspectedIds.has(id) ? ' open' : '') +
          (justAnchored.has(id) ? ' fold-anim' : '') +
          (pendingLink !== null && pendingLink !== id ? ' link-target' : ''),
      );
      // 动画播完（380ms）就撤掉 fold-anim，下一次折角才能再播。
      if (justAnchored.has(id)) {
        setTimeout(() => cell.classList.remove('fold-anim'), 380);
      }
      cell.addEventListener('click', () => onCardClick(id));
      // 卡名渲染：卡号（三位数）是机制坐标不是内容，压成淡墨小字（.card-id），
      // 让卡名成为视觉主体。此前「001 那件外套」一整串同字号，读起来像台账。
      // ⚠ decayClass 必须挂在外层 span 上——失真效果要作用于整张卡名，
      //   内层拆分不能把 fx-* 类切碎（否则 Loose 粘连/Shift 重影会失效）。
      const nameWrap = el('span', 'card-name ' + decayClass(c.style));
      const raw = c.content.replace('（残迹）', '');
      // 稳健拆分：格式不符（理论上是 `{:03} {名字}`）就整体回落，不切碎。
      const m = /^(\d{3})\s+(.+)$/.exec(raw);
      if (m) {
        nameWrap.appendChild(el('span', 'card-id', m[1]));
        nameWrap.appendChild(document.createTextNode(m[2]));
      } else {
        nameWrap.textContent = raw;
      }
      // 记忆清单（v0.49）：首见登记卡名——删掉的卡不会再进帧，名字只能在这里留底。
      if (!cardSeen.has(id)) cardSeen.set(id, m ? m[2] : raw);
      if (traced) nameWrap.appendChild(el('span', 'card-id', ' （残迹）'));
      cell.appendChild(nameWrap);
      // 这张纸片是从哪一页夹进来的（sim 给的 introduced_page）。
      // 有了它，书脊区那张纸片和上面某一页就对得上了——「卡与台词毫不相干」
      // 这条旧症状的另一半解药（另一半是页边也挂一份）。
      if (c.style && c.style.page) {
        cell.appendChild(el('span', 'card-page', `第 ${c.style.page} 页`));
      }
      if (bar) {
        const track = el('div', 'bar-track');
        const fill = el('div', 'bar-fill');
        fill.style.width = `${Math.max(0, Math.min(1000, bar.ratioPermille)) / 10}%`;
        track.appendChild(fill);
        cell.appendChild(track);
      }
      // 2026-10-17：选中角标——边框语言不够用（悬停/引用/选中曾共用一套视觉），
      // 卡面上直接写「已选中」，玩家扫一眼就知道哪个是自己的。
      if (selected === id) cell.appendChild(el('span', 'card-sel-badge', '已选中'));
      grid.appendChild(cell);
    });
    host.appendChild(grid);
  }

  function onCardClick(id) {
    // 同样是用户手势：只点卡片、不点动词也要能解锁环境声
    if (window.CROSSGAME_AUDIO) window.CROSSGAME_AUDIO.unlock();
    if (pendingLink !== null) {
      // 2026-10-17：再点一次源卡 = 取消「别在一起」。此前关联模式没有取消路径，
      // 玩家arm 完之后只能硬点别的卡或被动词按钮打断（选中态还被它占着）。
      if (pendingLink === id) {
        pendingLink = null;
        selected = null;
        render();
        return;
      }
      // .rec / sim_tick 的关联编码是单 token `L<a>.<b>`（ledger::encode_action）——
      // 拆成 "L6 41" 两个 token 会让 decode_action 在 "L6" 上失败（无第二张卡）。
      send([`L${pendingLink}.${id}`]);
      return;
    }
    selected = selected === id ? null : id;
    render();
  }

  /** 选中提示行（2026-10-17）：选中态的一行字兜底。
   *  双高亮疑云（悬停/引用/选中曾共用 accent 边框+光环）之后，玩家在超容墙前
   *  连点删卡时，「我现在选中的到底是哪张」不能只靠边框回答。 */
  function renderSelHint() {
    const host = $('#sel-hint');
    if (!host) return;
    host.className = '';
    if (pendingLink !== null) {
      host.className = 'on';
      host.textContent = `别在一起：再点一张纸片，与 ${pad3(pendingLink)} 别到一块（再点一次 ${pad3(pendingLink)} 取消）。`;
      return;
    }
    if (selected === null) {
      host.textContent = '点一张纸片，再选动作：折角让它抓得更紧，抽掉把它移出书脊，摊开读它现在的样子。';
      return;
    }
    const slip = last.nodes.find(
      (n) =>
        n.kind === SimClient.KIND.Text &&
        n.style &&
        n.style.role === ROLE.Body &&
        n.content.startsWith(pad3(selected) + ' '),
    );
    const name = slip ? slip.content.replace('（残迹）', '').slice(4) : `#${selected}`;
    const pg = slip && slip.style && slip.style.page ? `（第 ${slip.style.page} 页夹进来的）` : '';
    host.className = 'on';
    // 删除理由（v0.26）：选中即预警——「抽掉」之前先看见它自己怎么评价这条。
    // 作者 seed42 取证：7 次删除全盲删，024/006/023（叙事内核）被当废纸扔了。
    // why_delete 是作者亲手写的反讽文本，sim 每帧随 UiTree 下发（Reason 角色）。
    const reason = (textsByRole(ROLE.Reason).find((n) => n.content.startsWith(pad3(selected) + '：')) || {}).content || '';
    const why = reason ? reason.slice(4) : '';
    // 保留理由（v0.28）：why_keep 反向引导。没有 why_delete 的内核卡
    // （003/004/005/023）靠这句开口——v0.27 模拟玩家实测细读读者全摊开
    // 还是把它们当废纸扔了：「没有理由的卡，删起来最安静」。
    const keep = (textsByRole(ROLE.Keep).find((n) => n.content.startsWith(pad3(selected) + '：')) || {}).content || '';
    const keepWhy = keep ? keep.slice(4) : '';
    // 并入提示（F6）：糊了的卡教一句——抽掉不是只有真删一条路。sim 每帧只给
    // can_fold 的卡发这一行（System 角色、与 why_delete 同款「NNN：…」前缀），
    // 行的有无本身就是「这张卡可并入」的全部信号（§5.1 不做特殊标记）。
    const fold = (textsByRole(ROLE.System).find((n) => n.content.startsWith(pad3(selected) + '：')) || {}).content || '';
    const foldWhy = fold ? fold.slice(4) : '';
    host.textContent = `已选中：${pad3(selected)} ${name}${pg}——再点一次取消，或选一个动作。` + (why ? `它自己说：${why}` : '') + (keepWhy ? ` 它自己舍不得：${keepWhy}` : '') + (foldWhy ? ` ${foldWhy}` : '');
  }

  const pad3 = (id) => String(id).padStart(3, '0');

  /** 把一段正文排成「纸片的样子」。
   *
   * 数字层（docs/shell-book.md §3）：纸片上印的不是散文，是**消息**——
   * 「…」里的对白独立成引文块；`⟨…⟩` 里的是**被撤回的字**：划掉，但仍可读。
   *
   * 撤回为什么靠符号而不是加字段：加 `CardData::retracted` 会进 `facts_digest`
   * ⇒ 黄金链头变、已录回放全部报废。作者裁决「先用符号」，等第 1 章全量写完、
   * 看清撤回到底出现几次，再决定值不值得为它分叉一次。
   */
  function renderProse(text, cls) {
    const frag = document.createDocumentFragment();
    // 先切撤回标记，再切引文——撤回标记可能跨在引文里。
    const segs = String(text).split(/(⟨[^⟩]*⟩)/g);
    for (const seg of segs) {
      if (!seg) continue;
      if (seg.startsWith('⟨') && seg.endsWith('⟩')) {
        frag.appendChild(el('del', 'retracted', seg.slice(1, -1)));
        continue;
      }
      for (const part of seg.split(/(「[^」]*」)/g)) {
        if (!part) continue;
        if (part.startsWith('「')) frag.appendChild(el('span', 'quote', part));
        else frag.appendChild(document.createTextNode(part));
      }
    }
    const wrap = el('p', cls);
    wrap.appendChild(frag);
    return wrap;
  }

  /** 上次摊开的是哪张卡（滚动触发的判据：只看摊开对象，不看档位刷新）。 */
  let lastDetailKey = '';

  /** 把刚摊开的纸片带进视野（2026-10-21 参赛实拍撞见）：
   *  明细排在书脊之后，14 张纸片时它落在视口底部——而 sticky 动作条正浮在那
   *  （实测 #detail y=802–946 被 #actionbar 767–920 整块盖住，点「摊开」什么都
   *  看不见，得手动往下滚 400px）。这与 v0.35「点完就看见」直接矛盾。
   *  沿用同一模式：**摊开对象变了才滚**——折角/抽掉的重渲染、同卡的档位刷新
   *  都不滚（v0.35 裁决「动词重渲染不跳画面」），已完整露在动作条之上也不滚。 */
  function bringDetailIntoView(host) {
    if (typeof host.scrollIntoView !== 'function') return; // jsdom（dom-verify）无布局引擎
    const bar = $('#actionbar');
    const r = host.getBoundingClientRect();
    const barTop = bar ? bar.getBoundingClientRect().top : window.innerHeight;
    if (r.height > 0 && r.top >= 0 && r.bottom <= barTop) return; // 已经看得见
    try {
      host.scrollIntoView({
        block: 'center',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
    } catch (_) {
      /* 老浏览器不认 options 形式：跳过即可——明细在页尾，手动滚一屏就到。 */
    }
  }

  function renderDetail() {
    const host = $('#detail');
    host.textContent = '';
    const caps = textsByRole(ROLE.Caption);
    const keys = [];
    for (const n of caps) {
      const km = /^(\d{3})：/.exec(n.content);
      keys.push(km ? km[1] : 'text');
      const m = /^(\d{3})：([\s\S]*)$/.exec(n.content);
      const card = el('div', 'slip-open');
      if (m) {
        card.appendChild(el('div', 'slip-no', `第 ${m[1]} 张`));
        card.appendChild(renderProse(m[2], 'detail-line ' + decayClass(n.style)));
        // 页脚：数字层最要紧的一行——这些东西是本地记录，删不掉。
        // 这是纸层讲不出来的那半句（哈希链是石头/账本的隐喻，纸会褪会撕）：
        // **纸在散架，字删不掉。**
        const slip = textsByRole(ROLE.Body).find(
          (b) => /^\d{3} /.test(b.content) && b.content.startsWith(m[1] + ' '),
        );
        const pg = slip && slip.style ? slip.style.page : 0;
        card.appendChild(
          el('div', 'slip-foot', pg ? `本地记录 · 第 ${pg} 页夹进来的 · 撤不回去` : '本地记录 · 撤不回去'),
        );
      } else {
        card.appendChild(renderProse(n.content, 'detail-line ' + decayClass(n.style)));
      }
      host.appendChild(card);
    }
    // 摊开对象变了（含空→有）⇒ 带进视野；同卡的档位刷新与动词重渲染不滚。
    const key = keys.join(',');
    if (key && key !== lastDetailKey) bringDetailIntoView(host);
    lastDetailKey = key;
  }

  function renderButtons() {
    const host = $('#verbs');
    host.textContent = '';
    const btns = last.nodes.filter((n) => n.kind === SimClient.KIND.Button);
    for (const b of btns) {
      const labelNode = nodeById(b.child);
      const label = labelNode ? labelNode.content : `#${b.action}`;
      // v0.40：翻页也由 sim 下发（超容时 sim 置 disabled、label 换成「装不下了」）。
      // 规则只在 sim 一处，宿主只渲染——此前这里是常亮的 chrome 按钮，作者第三局
      // 在墙前白按 29 次。class 仍叫 next，CSS 与测试都照旧。
      const cls = b.action === ACTION.NEXT ? 'verb next' : 'verb';
      const btn = el('button', cls, label);
      btn.disabled = !b.enabled;
      // T3：动作号落到 DOM 上——键盘按编号/别名找的就是这颗按钮本身
      // （含 disabled 状态 ⇒ 置灰即点不动，与鼠标同一条门控）。
      btn.dataset.action = String(b.action);
      btn.addEventListener('click', () => onVerb(b.action));
      host.appendChild(btn);
    }
    // 结局动作（v2 专属）：把审计日志交给它自己读。**只在剧本终句之后出现**——
    // 提前摆出来等于剧透「有个结局」，也会让玩家在没读懂故事时先按它。
    // 门控仍在 sim（第 4 章 + 041 存活）；这里只负责「故事讲完了才给这个按钮」。
    // v0.44：`!endingPlayed()`——终幕演过就撤。结局后还亮着一枚红按钮，玩家会
    // 再按一次换来「这一局已经收尾了。」（作者 2026-10-24 实测，见 endingPlayed）。
    // 刷新重开走同一条路：renderButtons 在 render 里跑，判据读对话流。
    if ((V2 || MICRO) && scriptSettled() && !endingPlayed()) {
      const present = el('button', 'verb ending', '把账放到它面前');
      present.dataset.action = 'P';
      present.addEventListener('click', () => {
        send(['P']);
        // 收下了（终幕台词进对话流）当帧就撤按钮，不留再点一次的机会；
        // 被 sim 门控拒了（如 041 已不在池）则保留——状态行会说明为什么不行。
        if (endingPlayed()) renderButtons();
      });
      host.appendChild(present);
    }
  }

  /** 剧本是否已播到末句（黑盒信号：末句含「由你决定」——见 content.rs v2 剧本末行）。 */
  function scriptSettled() {
    return textsByRole(ROLE.Dialogue).some((n) => n.content.includes('由你决定'));
  }

  function onVerb(action) {
    if (action === ACTION.AUDIT) {
      // 账是视图开关：本地同步翻开/合上，sim 侧 T 一并翻 audit_view。
      // 2026-10-21 参赛实拍撞见：auditOpen 从来没人置过 ⇒ 面板永远打不开，
      // 审计行还从状态行漏出来（末尾的哈希行顶掉了状态行）。
      auditOpen = !auditOpen;
      send(['T']);
      return;
    }
    // v0.40：翻页不需要先选中纸片（它不是及物动词），也不该被「别在一起」的
    // 半程拦下——超容时 sim 已把它置 disabled，点不动即点不动。
    if (action === ACTION.NEXT) {
      send(['N']);
      return;
    }
    // 关联模式已arm：动作按钮此时会打错靶（选中位被源卡占着）——拦住，
    // 让玩家先完成或取消「别在一起」（2026-10-17）。
    if (pendingLink !== null && action !== ACTION.LINK) {
      flash(`先完成「别在一起」：再点一张纸片，或再点一次 ${pad3(pendingLink)} 取消。`);
      return;
    }
    if (selected === null) {
      flash('先点一张纸片，再选动作。');
      return;
    }
    if (action === ACTION.ANCHOR) send([`A${selected}`]);
    else if (action === ACTION.FORGET) send([`F${selected}`]);
    else if (action === ACTION.LINK) {
      pendingLink = selected;
      flash(`别在一起：再点一张纸片，与 ${String(selected).padStart(3, '0')} 别到一块。`);
      render();
    } else if (action === ACTION.QUERY) {
      // 「摊开」= 把这张纸片摊开来看。发 `I<卡>`（Inspect）——**不**发 `Q<卡>:<槽>`：
      // 槽位是假交互（见 renderButtons 里的注记），在它真的影响选档之前不上界面。
      send([`I${selected}`]);
    }
  }

  /** 审计视图里的文本 id（Scroll→Col 的直接文本——与 renderAudit 同一个结构
   *  假设，形状变了两处一起坏）。状态行要排除它们：账一翻开，审计行是树里最靠后
   *  的 System 文本，末尾的哈希行会顶掉真正的状态行。 */
  function auditTextIds() {
    const ids = new Set();
    for (const s of last.nodes.filter((n) => n.kind === SimClient.KIND.Scroll)) {
      const col = nodeById(s.child);
      if (!col || col.kind !== SimClient.KIND.Col) continue;
      for (const cid of col.children) ids.add(cid);
    }
    return ids;
  }

  function renderStatus() {
    const host = $('#status');
    const skip = auditTextIds();
    const sys = textsByRole(ROLE.System).filter((n) => !skip.has(n.id) && !/^书脊 /.test(n.content));
    const line = sys[sys.length - 1];
    host.textContent = line ? line.content : '';
    host.className = line && line.style.color === 2 ? 'danger' : '';
    // 撞墙视觉：sim 发 "装不下" 即挂 class + 动作条红色脉冲 + 操作提示。
    // 纯宿主层逻辑，零哈希——墙本身是 sim 状态，这里只是把它翻译成看得见的反馈。
    const isWall = /装不下/.test(host.textContent || '');
    $('#actionbar').classList.toggle('walled', isWall);
    const hint = $('#wall-hint');
    if (hint) {
      hint.textContent = isWall ? '点一张纸片，抽掉，再翻页' : '';
    }
  }

  function renderAudit() {
    const host = $('#audit');
    host.textContent = '';
    // 审计视图 = Scroll 内的 System 文本们 + 末尾哈希行。按类型扫，不猜下标。
    const scrolls = last.nodes.filter((n) => n.kind === SimClient.KIND.Scroll);
    const lines = [];
    for (const s of scrolls) {
      const child = nodeById(s.child);
      if (!child || child.kind !== SimClient.KIND.Col) continue;
      for (const cid of child.children) {
        const n = nodeById(cid);
        if (n && n.kind === SimClient.KIND.Text && n.style.role === ROLE.System) {
          lines.push(n);
        }
      }
    }
    for (const n of lines) {
      const isHash = n.content.startsWith('本帧 state_hash');
      host.appendChild(el('div', isHash ? 'audit-hash' : 'audit-line', n.content));
    }
  }

  /** v0.39 环境声层的每帧校正。只读已经渲染出来的事实（书脊页眉、状态行），
   *  不碰 sim ⇒ 零哈希。删过卡 ⇒ 池子变小 ⇒ 一层环境声慢慢退掉；装不下 ⇒
   *  一声很轻的错位音（预告片分镜那声的游戏内同源物）。 */
  let lastPoolN = null;
  let lastWall = false;
  function audioTick() {
    const A = window.CROSSGAME_AUDIO;
    if (!A) return;
    const hdr = textsByRole(ROLE.System).find((n) => /^书脊 /.test(n.content));
    const m = hdr ? /^书脊\s*(\d+)\s*\//.exec(hdr.content) : null;
    const n = m ? Number(m[1]) : 0;
    A.pool(n);
    if (lastPoolN !== null && n < lastPoolN) A.cueGone();
    lastPoolN = n;
    const wall = /装不下/.test($('#status').textContent || '');
    if (wall && !lastWall) A.cueWall();
    lastWall = wall;
  }

  function render() {
    renderTitle();
    renderDialogue();
    renderPool();
    renderDetail();
    renderSelHint();
    renderButtons();
    renderStatus();
    audioTick();
    // 会话线索：测试者做过任何动作（推进/动词）后隐藏——他已经在玩了。
    // boot 后 frames.length === 1（首帧空动作）；>1 即玩家已介入。
    $('#intro').classList.toggle('hidden', frames.length > 1);
    $('#slots').classList.add('hidden');
    if (auditOpen) {
      renderAudit();
      $('#audit').classList.remove('hidden');
    } else {
      $('#audit').classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------- .rec 回收

  function hexDigests() {
    return client.digestsHex();
  }

  function buildRec() {
    const d = hexDigests();
    const lines = [
      // 2026-10-17 修：此前写死 'v1'——?v2=1 的通关录制头部也标 v1，作者回帖时
      // 头部与摘要互相矛盾（回放靠摘要自动判别链，但头部在骗人）。
      'crossgame-slice-recording ' + (MICRO || V2 ? 'v2' : 'v1'),
      `seed=${SEED}`,
      `facts=${d.facts}`,
      `variants=${d.variants}`,
    ];
    for (const f of frames) {
      lines.push(f.text ? `f=${f.n} ${f.text}` : `f=${f.n}`);
    }
    return lines.join('\n') + '\n';
  }

  function wireRecPanel() {
    // 提前导出：中途流失的测试者点它，同样拿到 .rec（终局之外唯一的回收入口）。
    // 文案中性（「导出这一局的记录」）——写「不想玩了」会诱发退出，污染判据 1 计时。
    // v0.44：滚进视野收进 showRecPanel 了（终局与提前导出同一条路），这里只负责开。
    $('#rec-early').addEventListener('click', () => showRecPanel());
    // 点进文本框就全选——file:// 与 iframe 里剪贴板 API 不可用是常态，
    // 手动复制这条路必须一秒能走完（作者 2026-10-24：「没有复制的内容」）。
    $('#rec-text').addEventListener('focus', (e) => e.target.select());
    $('#rec-copy').addEventListener('click', async () => {
      const ta = $('#rec-text');
      try {
        await navigator.clipboard.writeText(ta.value);
        $('#rec-copy').textContent = '已复制，发给作者';
      } catch (_) {
        ta.select(); // file:// 或旧浏览器：退化为手动复制
        // v0.44：execCommand 返回 false 时原来也写「已复制（请检查）」——剪贴板
        // 其实是空的，玩家粘到微信里什么都没有。成败必须说真话。
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
        $('#rec-copy').textContent = ok
          ? '已复制，发给作者'
          : '没复制上——点上面的文本框，内容已全选，手动复制';
      }
    });
  }

  /** 动词操作说明（2026-10-16 双人反馈）：测试者原话「这几个是干啥的你也
   *  的解释啊」——动词名（折角/摊开）对非技术玩家就是黑话。展开内容只描述
   *  界面可见效果（条回满/卡消失/明细出文本），隐藏后果（掉精度/断边）绝不
   *  出现：那是判据 2 要测试者自己撞出来的。入口默认收起，不占冷启动界面。 */
  function wireVerbHelp() {
    $('#verb-help-toggle').addEventListener('click', () => {
      const box = $('#verb-help');
      box.classList.toggle('hidden');
      $('#verb-help-toggle').textContent = box.classList.contains('hidden')
        ? '这些按钮是做什么的？'
        : '收起说明';
    });
  }

  function flash(msg) {
    const host = $('#flash');
    host.textContent = msg;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => {
      host.textContent = '';
    }, 2600);
  }

  // ---------------------------------------------------------------- 启动

  /** wasm2js 的 legalstub 把 i64 参数拆 (lo, hi) 两个 i32、i64 返回走低半 +
   *  setTempRet0 高半暂存。SimClient 按 BigInt 语义调用 ⇒ 补一层薄适配。
   *  本项目 i64 全是小整数（帧号/seed），高半恒 0（判据已证等价）。 */
  function adaptAsmExports(mod) {
    return {
      ...mod,
      sim_tick: (h, frameBig, ptr, len, seedBig) =>
        mod.sim_tick(h, Number(frameBig) | 0, 0, ptr, len, Number(seedBig) | 0, 0),
      sim_frame: (h) => Number(mod.sim_frame(h)) | 0,
      memory: mod.memory,
    };
  }

  /** v0.48 双路内核启动。正常路是 WebAssembly；宿主内嵌浏览器不放行 WASM
   *  （DBX 实测）时 instantiate 直接被拒 ⇒ 回落到包内静态的 wasm2js 内核
   *  （页头的 window.__loadJsKernel）。回落是普通函数调用，不加载外部脚本、
   *  不碰 eval。两路内核行为等价锁在 .tmp/verify-js-kernel.mjs。 */
  async function bootKernel() {
    const b64 = document.documentElement.dataset.wasm;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    try {
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance;
    } catch (wasmErr) {
      if (typeof window.__loadJsKernel !== 'function') throw wasmErr;
      try {
        return { exports: adaptAsmExports(window.__loadJsKernel()) };
      } catch (jsErr) {
        throw wasmErr;
      }
    }
  }

  async function boot() {
    const instance = await bootKernel();
    client = SimClient.createClient(instance, { v2: V2, micro: MICRO });
    // v2 线索：故事会走完四章，最后有一个由你按下的收尾——与 v1（两章、没有结局）区分。
    // v0.30（作者冷读评估 P0-1）：开场从「系统说明书」改「故事腔」——只建情境
    // （它给谁记账、纸片是什么）+ 一个动作（翻页）；删除/遗忘不预先解释，
    // 留给容量墙第一次出现时用它自己的声音说（sim wall_voice）。
    // v0.37：第 2 句回答「我是谁」——按 DESIGN §1 定位语与 §2.2 理由 2
    // （「玩家就是模块，不是在观察它」）定：**你是模块，不是他、也不是它**。
    // 措辞里不许出现机制词（smoke 断言 intro 不得含 锚定/精度/质询/遗忘/抽掉/折角），
    // 所以只说位置（替它翻这本账的那一层），不说动作。
    if (V2 || MICRO) {
      const intro = $('#intro');
      intro.innerHTML =
        '<p class="book-name">它在维护一场对话</p>' +
        '<p>它给一个人记了三年账。他做过的、说过的，它都记着。</p>' +
        '<p>你不是他。你也不是它——你是替它翻这本账的那一层。</p>' +
        '<p>点「翻页」，听它讲第一句。夹在书里的纸片，是它记下的每一件事。</p>' +
        '<p>翻到最后一页，由你决定，这本账怎么办。</p>';
    }
    last = client.tick(''); // 第 1 帧：空动作，拿到可渲染的树
    frames.push({ n: 1, text: '' });
    wireRecPanel();
    wireVerbHelp();
    wireKeyboard();
    wireFontToggle();
    wireAudioToggle();
    render();
  }

  // ---------------------------------------------------------------- 键盘（T3）

  /** 键盘操作（todo-release T3：全流程可不用鼠标走完；Deck 用户是叙事游戏主力）。
   *
   *  路线设计与鼠标**完全同一条**：键盘不合成 token、不绕门控——翻页点的是
   *  sim 下发的那颗按钮（超容置灰 ⇒ 点不动，与鼠标一致），回看点的是历史页
   *  页眉本身。唯一的自有语义是焦点移动（Tab 在纸片间跳）。
   *
   *    → / n      翻页
   *    ←          回看上一页（摊开/收起最近的叠起页）
   *    1–6        第 N 个动作按钮（按渲染顺序）
   *    t          账（审计视图开关）
   *    p          把账放到它面前（结局动作，故事讲完后才出现）
   *    Esc        取消选中 / 取消「别在一起」
   *    Tab       纸片间移动焦点（Enter/Space 落键——原生按钮行为）
   *
   *  文本框（回收日志 / 调试输入）里全让位，不偷键；带修饰键的组合放过
   *  （浏览器快捷键优先）。 */
  function wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      const key = e.key;
      if (key === 'ArrowRight' || key === 'n' || key === 'N') {
        const btn = $('#verbs').querySelector('button[data-action="6"]');
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.click();
        }
        return;
      }
      if (key === 'ArrowLeft') {
        const heads = [...document.querySelectorAll('#stage .page.folded .page-head')];
        const last = heads[heads.length - 1];
        if (last) {
          e.preventDefault();
          last.click();
        }
        return;
      }
      if (key === 'Escape') {
        e.preventDefault();
        if (pendingLink !== null || selected !== null) {
          onCardClick(pendingLink !== null ? pendingLink : selected);
        }
        return;
      }
      if (key === 'Tab') {
        const cards = [...document.querySelectorAll('#pool .card')];
        if (cards.length) {
          e.preventDefault();
          const cur = cards.indexOf(document.activeElement);
          const next = e.shiftKey
            ? cur <= 0 ? cards.length - 1 : cur - 1
            : cur >= cards.length - 1 ? 0 : cur + 1;
          cards[next].focus();
        }
        return;
      }
      if (/^[1-6]$/.test(key)) {
        const btns = [...$('#verbs').querySelectorAll('button')];
        const btn = btns[Number(key) - 1];
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.click();
        }
        return;
      }
      if (key === 't' || key === 'T') {
        const btn = $('#verbs').querySelector('button[data-action="5"]');
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.click();
        }
        return;
      }
      if (key === 'p' || key === 'P') {
        const btn = $('#verbs').querySelector('button[data-action="P"]');
        if (btn) {
          e.preventDefault();
          btn.click();
        }
      }
    });
  }

  /** T4 字号三档：小 / 中 / 大（正文 15 / 18 / 22）。与声音开关同一条习惯——
   *  偏好写 localStorage，玩家设过一次永远生效；存不下（隐私模式）只是不记住，
   *  不当次切换照样生效。 */
  function wireFontToggle() {
    const btn = $('#font-toggle');
    if (!btn) return;
    const KEY = 'crossgame.fontsize';
    const SIZES = ['s', 'm', 'l'];
    const LABELS = { s: '字号：小', m: '字号：中', l: '字号：大' };
    let cur = 'm';
    try {
      const v = localStorage.getItem(KEY);
      if (SIZES.includes(v)) cur = v;
    } catch (_) {
      /* 拿不到就当默认中档 */
    }
    const paint = () => {
      document.body.dataset.fs = cur;
      btn.textContent = LABELS[cur];
    };
    btn.addEventListener('click', () => {
      cur = SIZES[(SIZES.indexOf(cur) + 1) % SIZES.length];
      try {
        localStorage.setItem(KEY, cur);
      } catch (_) {
        /* 存不下只是不记住偏好，不挡切换 */
      }
      paint();
    });
    paint();
  }

  /** v0.39 环境声开关。点它就是一次用户手势 ⇒ 浏览器允许起 AudioContext。 */
  function wireAudioToggle() {
    const btn = $('#audio-toggle');
    const A = window.CROSSGAME_AUDIO;
    if (!btn || !A) return;
    const paint = () => {
      btn.textContent = A.enabled() ? '声音：开' : '声音：关';
      btn.setAttribute('aria-pressed', A.enabled() ? 'true' : 'false');
    };
    btn.addEventListener('click', () => {
      A.setEnabled(!A.enabled());
      paint();
    });
    paint();
  }

  /** v0.46 启动失败可见化：宿主内嵌浏览器（DBX 等）环境差异不该死得无声。
   *  任何启动异常都画成红框上屏——否则玩家只看到「开场白在、按钮没了」，
   *  作者只看到一张截图。原文收进 <details> 供复制定位。
   *
   *  纪律：错误面板只报错。不指导宿主改安全策略，也不在任何失败路径上做
   *  站外引导——出问题的时候不是推广的时候。 */
  function bootFail(what) {
    try {
      if (document.getElementById('boot-fail')) return;
      const wasmBlocked = /WebAssembly/i.test(what);
      const d = document.createElement('div');
      d.id = 'boot-fail';
      d.style.cssText =
        'margin:12px 0;padding:14px 16px;border:1.5px solid #b98a2e;' +
        'background:#fbf4e2;color:#4a3c1c;font-size:13px;line-height:1.8;' +
        'border-radius:6px;';
      const esc = String(what).replace(/[&<>]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
      );
      d.innerHTML =
        '<div style="font-size:15px;font-weight:600;margin-bottom:6px;">' +
        '启动失败——这个环境没能跑起来</div>' +
        '<p style="margin:0 0 8px;">' +
        (wasmBlocked
          ? '宿主内嵌浏览器禁用了 WebAssembly，包内的 JS 内核回落也没能启动。'
          : '叙事内核没能初始化。') +
        '</p>' +
        '<p style="margin:0 0 8px;">把下面的原始错误发给作者，可以直接定位。</p>' +
        '<details><summary style="cursor:pointer;">原始错误文本</summary>' +
        '<pre style="white-space:pre-wrap;word-break:break-all;margin:8px 0 0;' +
        'font-size:12px;">' + esc + '</pre></details>';
      const intro = document.getElementById('intro');
      if (intro && intro.parentNode) intro.parentNode.insertBefore(d, intro.nextSibling);
      else document.body.insertBefore(d, document.body.firstChild);
    } catch (_) {
      /* 连报错都画不出来时不再叠异常 */
    }
  }
  window.addEventListener('error', (e) => bootFail((e && e.message) || 'unknown error'));
  window.addEventListener('unhandledrejection', (e) =>
    bootFail(String((e && e.reason && (e.reason.stack || e.reason.message)) || (e && e.reason) || e)),
  );
  document.addEventListener('DOMContentLoaded', () => {
    Promise.resolve()
      .then(boot)
      .catch((e) => bootFail(String((e && (e.stack || e.message)) || e)));
  });
})();
