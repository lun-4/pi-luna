# Subagent UI plan

The subagents part ships two UI surfaces: a **custom footer** with one live
line per subagent, and an **`/agents` overlay** with an overview/focus split.

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

Full-screen overlay (`ctx.ui.custom`, `overlay: true`, margins 1). Height is
learned from the `overlayOptions.visible(termWidth, termHeight)` callback —
the only grounded way an overlay component gets its viewport; chrome is laid
out against it.

- **Overview** — header `subagents (N)`; left pane ≈40% width: one row per
  subagent (`glyph type handle preview`), cursor with `selectedBg` highlight;
  right pane: the selection's condensed thread (`user:` / `agent:` / `tool:`
  labels, middle-ellipsis when the thread overflows), plus the hint line
  `↑↓ select • enter focus • esc close`.
- **Enter** → focus view — header `focus: type handle status`, full transcript
  scrolled (`↑↓` line, `pgup/pgdn` page; while the subagent streams, scroll
  auto-follows the newest lines), divider, hint
  `type + enter send • ctrl+c interrupt • esc back • /agents + enter close`,
  and an `Input` row.
- **Focus keys**: `escape` back to overview (editor cleared); `ctrl+c`
  aborts a running subagent (clears the editor when idle); everything else
  goes to the editor. Submit: `"/agents"` closes the overlay; any other text
  is delivered like `subagent_send` (steer while running, prompt when idle —
  fire-and-forget) and the thread refetches on settle.
- **Transcripts**: fetched lazily per handle via `get_messages` and cached;
  while the focused/selected subagent streams, `message_update` `text_delta`
  events append into the last streaming entry (`applyDelta`), `message_end`
  finalizes it, `agent_settled` triggers a full refetch. Unsubscribed on
  overlay close.
- Overview selection change also fetches that subagent's transcript lazily,
  so the condensed pane fills in without entering focus.