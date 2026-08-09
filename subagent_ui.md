# Subagent UI plan

The subagents part ships two UI surfaces: a **custom footer** with one live
line per subagent, and an **`/agents` overlay**: a single two-pane view that
updates live.

## Footer

The built-in footer's three lines are replicated 1:1 (from
`dist/modes/interactive/components/footer.js`), then subagent lines are
appended:

1. pwd (with `~`-shortening) + `(branch)` + `• sessionName`, dim, truncated.
2. token stats (`↑↓RWCH$` + context %) left, model right-aligned, provider
   prefix when >1 provider, dim.
3. extension statuses sorted by key (the `mode: build`, `sandbox:on` chips).
4. + one line per subagent, **newest first**:
   `<bold type> <handle> <glyph> <preview> (↑in/↓out)` — glyphs `…` spawning /
   `▸` running / `·` idle / `■` stopped / `✗` error; preview = most recent of
   the **last tool call** (`tool: <name> <json args>`, args omitted when
   empty) and the **last assistant text** (streamed live, finalized at
   message_end), else `spawning…`; first 30 chars (unicode-safe). The suffix
   is the worker's rolling token usage (`↑`/`↓` arrows + `k`/`M` formatting,
   same as built-in line 2): folded in on every committed message (each
   assistant/toolResult message bills its own usage), then overwritten with
   the authoritative `get_session_stats` RPC totals at each `agent_settled`
   (those also cover compaction); absent until the first committed message.
   The preview is sanitized to a single line first (streamed markdown and
   JSON tool args contain newlines, which would shatter the footer cell).

Live updates: the footer subscribes to the registry and calls
`tui.requestRender()` on every change (text deltas, settle, spawn, delete).
`session_shutdown` restores the built-in footer.

## /agents overlay

Full-screen overlay (`ctx.ui.custom`, `overlay: true`, margins 1). One stable
two-pane screen — list on the left, live state of the selection on the right,
input row at the bottom. Height is learned from the
`overlayOptions.visible(termWidth, termHeight)` callback — the only grounded
way an overlay component gets its viewport; chrome is laid out against it.

- **Left pane** (≈40% width): header `subagents (N)`; one row per subagent
  (`glyph type handle preview`), cursor with `selectedBg` highlight; spawns
  and deletes update the list live without moving the selection.
- **Right pane**: status line (`glyph type handle status`), divider, then the
  selection's wrapped transcript (`user:` / `agent:` / `tool:` labels; rows
  filled to the pane bottom). While the subagent **runs**, the window
  auto-follows the newest lines as text streams in; when idle, the scroll
  position is kept.
- **Keys**: `↑`/`↓` move the selection (wrap-around); `pgup`/`pgdn` scroll
  the right-pane transcript; `enter` submits the input; `ctrl+c` aborts the
  running selection (clears the input when idle); `esc` clears the input
  first, then closes the overlay. Everything else goes to the input.
- **Submit**: `"/agents"` closes the overlay; any other text is delivered
  like `subagent_send` (steer while running, prompt when idle —
  fire-and-forget) and the thread refetches on settle.
- **Selection**: stable by handle — a spawned/deleted subagent never yanks
  the right pane to a different subagent; deleting the selection falls back
  to the clamped cursor position (nearest row). On open the first subagent
  is selected immediately, so the right pane populates without a keypress.
- **Transcripts**: fetched lazily per handle via `get_messages` and cached
  at selection time; while the selected subagent streams, `message_update`
  `text_delta` events append into the last streaming entry (`applyDelta`),
  and the thread refetches on every commit — `message_end`, each
  `tool_execution_end` (so tool calls and results stream into the pane
  mid-run, not just at settle), and `agent_settled` for the final state.
  Unsubscribed on overlay close. The wrap/window math lives in the pure
  `windowTranscript` helper (unit-tested in test/subagents.test.ts).