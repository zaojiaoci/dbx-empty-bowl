# Empty Bowl / 空碗 · 十五分钟

**English** | [简体中文](#简体中文)

A 15-minute memory narrative that runs inside DBX. You are the memory module of
an AI that is forgetting: you decide which of its memories stay and which go.
Set one card aside, and what it says on the next pages changes — visibly.

- 8 memories, two chapters, one ending. ~15 minutes.
- Pure local: one self-contained HTML file + WASM. No network, no host
  permissions. UI preferences (sound, font size) use browser `localStorage`
  when the host allows it and stay unsaved when it does not.
- Every playthrough exports a replayable `.rec` stream — anyone can re-run
  anyone's session and see exactly which decision landed where.
- Evolved from the hash-chain idea in [dbx-sql-guard](https://github.com/zaojiaoci/dbx-sql-guard):
  the audit trail's tamper-evident chain, turned into a story about forgetting.

The free full version (4 chapters, 14 cards, 3 endings, ~90 min):
https://zaojiaoci.itch.io/it-is-maintaining-a-conversation

## Build

This repository holds the packaged plugin, not the narrative kernel's source:
`ui/index.html` is the final artifact (WASM blob + wasm2js fallback + UI), and
there is no build step in this repo. The Rust kernel source is available to DBX
reviewers on request.

```bash
npx @dbx-app/plugin-cli package .
```

`ui/index.html` is the **only** copy that carries the store-ready trims (no debug
panel, no session save, no external links). Upstream builds of the micro version
are playtest artifacts and still contain those; do not copy one over this file
without re-applying the trims.

The game content inside `ui/index.html` is **not** under the code license —
see [LICENSE-content.md](LICENSE-content.md).

---

## 简体中文

一个跑在 DBX 里的十五分钟记忆叙事。你是那个正在失忆的 AI 的记忆管理模块：
决定它记住什么、忘掉什么。删掉一张纸片，它后面几页说的话就会变——看得见地变。

- 8 条记忆、两章、一个结局。约 15 分钟。
- 纯本地：单文件 HTML + WASM，无网络、无 Host 权限。界面偏好（声音、字号）
  用浏览器 `localStorage`，宿主允许就记住，不允许就不记。
- 每一局都能导出可回放的 `.rec` 输入流——任何人可以重放任何人的一局，
  每个决定落在哪一帧都查得到。
- 从 [dbx-sql-guard](https://github.com/zaojiaoci/dbx-sql-guard) 的哈希链思想
  演化而来：审计留痕那条防篡改的链，被写成了一个关于遗忘的故事。

完整版（四章 14 卡三个结局，约 90 分钟）免费：
https://zaojiaoci.itch.io/it-is-maintaining-a-conversation

代码 Apache-2.0，游戏内容保留所有权利——见 [LICENSE-content.md](LICENSE-content.md)。

`ui/index.html` 是唯一带商店裁剪的副本（无调试面板、无会话存档、无外链）。
上游构建出的微缩版是试玩产物，这些都还在——别直接覆盖本文件，覆盖等于把
审核风险带回来。
