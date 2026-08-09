# Process-backed subagents plan

Goal: let the primary agent spawn real, separate pi sessions — child processes
speaking pi's JSONL RPC protocol over stdio — each with a toolset fixed by its
type. `explore` subagents are read-only researchers (`read`, `grep`, `find`,
`ls`); `plan-reviewer` subagents are read-only plan reviewers (same toolset as
explore); `general-purpose` subagents share the root build toolset with bash
sandboxed. Modes dictate which types a mode can spawn (plan mode:
`explore`/`plan-reviewer`). The model interfaces through `subagent_create` /
`subagent_send` / `subagent_get` / `subagent_delete`; the TUI gains footer lines
per live subagent and an `/agents` split-pane overlay.

## Decisions locked in

- **Workers are real pi processes over RPC stdio.** `RpcProcess`
  (`src/parts/rpc-process.ts`) is a trimmed port of
  `landstrip/packages/pi-landstrip/rpc-process.ts` (Apache-2.0, SPDX header +
  attribution kept): JSONL framing matching
  `dist/modes/rpc/rpc-types.d.ts`, request/response matching by id + command,
  `agent_settled` settle-waiting, bounded stderr tail, 64 MiB frame limit,
  stray-non-JSON tolerance, `extension_ui_request` handling.
- **`--no-extensions` is mandatory** in workers. Without it the worker
  auto-loads installed packages (pi-synthetic, pi-review, luna) and its
  toolset is polluted (verified live: `sandbox:on`, `mode: build`, synthetic
  widgets from a bare worker).
- **Type → toolset** (via `--tools` allowlist only, no worker-side config):
  | type | tools |
  |---|---|
  | `explore` | `read`, `grep`, `find`, `ls` |
  | `plan-reviewer` | `read`, `grep`, `find`, `ls` (same fixed set as `explore`; own system prompt) |
  | `general-purpose` | root build toolset minus `subagent_*`, `ask`, `plan_submit` (bash included) |
- **Spawn shape** (order-sensitive):
  `cli.js --mode rpc --no-extensions [--extension sandbox.ts] --session-dir <dir> --model <p>/<m> --thinking <level> --system-prompt <type prompt> --approve|--no-approve --tools <csv>`.
  Session dir: `<agentDir>/sessions/<cwd>--/subagents/<handle>/` (kept on
  delete for archaeology; resume-from-disk out of scope).
- **Plan-mode gate**: modes.ts exports `getMode()`/`subagentTypesFor()`; plan
  mode spawns `explore` + `plan-reviewer` (`subagent_create` blocked with a
  clear reason for other types). The plan directive names both plan-mode types
  and runs the review loop on `plan-reviewer`. `PLAN_TOOLS` includes all four
  subagent tools (send/get/delete are free in both modes).
- **Handle tools, non-blocking by design.** `subagent_create`/`subagent_send`
  return on the worker's command ack, never on settle. When a subagent
  settles, its final report is **queued back to the primary automatically**
  (`pi.sendUserMessage(..., {deliverAs: "followUp"})` — a queued follow-up
  while the primary streams, a fresh turn when it is idle; deduped per settled
  turn), so the primary just waits instead of polling. `subagent_get` remains
  for on-demand status/snapshots and caches the report once. `subagent_send`:
  `steer` while running (immediate injection), `prompt` when idle. Cap: 8.
- **RPC `follow_up` only queues when idle** (verified in `agent-session.js`:
  `followUp` → `_queueFollowUp`; the queue is drained at the next run's turn
  boundary). Idle sends therefore use `prompt`, never `follow_up`.
- **Worker bash is sandboxed** by loading the existing `sandbox.ts` part as a
  worker extension (`--extension`). `sandbox:false` prompts resolve
  `cancelled` (extension_ui_request default-cancel) — unsandboxed runs are
  denied inside workers, no prompts.
- **State is in-memory, session-scoped**: workers killed + registry cleared on
  `session_shutdown` (including reload/new/resume/fork) and reset on
  `session_start`.
- **UI**: the built-in footer is replaced with a custom one replicating lines
  1–3 (pwd/branch/session, token stats + context % + model, extension
  statuses) plus one live line per subagent. `/agents` opens the overlay.
- **Nested subagents out of scope** — workers never get `subagent_*` tools.
- **Compiled-binary pi unsupported**: spawning needs `cli.js` on disk; the CLI
  entry is resolved from `process.argv[1]` or — via pi's own `getPackageDir()`
  (not `import.meta.resolve`/`createRequire.resolve`, which fail under pi's
  jiti extension loader: no native `import.meta.resolve` there, and the
  exports-only pi package has no "require" condition) — the resolved
  `@earendil-works/pi-coding-agent` `bin`. Clear error otherwise.

## Configurable subagent models

Each subagent type can run on its own model + thinking level via the
`subagents` key of `~/.pi/agent/extensions/luna.json`:

```json
{
  "extensions": { "...existing toggles...": true },
  "subagents": {
    "explore": null,
    "general-purpose": {
      "model": "openrouter/deepseek/deepseek-v4-flash-0731",
      "thinking": "off"
    }
  }
}
```

- An entry of `null` (the default, self-documenting in the file) inherits
  **both** the primary's `provider/modelId` and thinking level.
- An object entry overrides **per field**; a `null`/omitted field inherits
  that field. `{ "model": null, "thinking": "off" }` inherits the model but
  forces thinking off. Use case: `explore` runs on a cheap OpenRouter model
  while the primary stays on its own. `model` must be the exact
  `provider/modelId` pi knows (the string the primary's footer shows) and
  must contain a `/`. `thinking` is one of
  `off | minimal | low | medium | high | xhigh | max`.
- **Live-read**: `subagents.ts` reads the file at every `subagent_create` —
  edit `luna.json` and the next spawn picks it up, no `/reload`. The
  `extensions` toggles in the same file stay load-time (index.ts reads them
  once at startup); that split is intentional — toggling a part needs a
  reload, swapping a subagent model should not.
- **Two readers of luna.json**: `src/index.ts` (the `extensions` toggles,
  load-time) and `src/parts/subagents.ts` (the `subagents` models, spawn-time,
  via `getAgentDir()`, which respects `PI_CODING_AGENT_DIR`).
- **Validation**: structurally malformed input (unknown type keys,
  non-object entries, wrong field types) is warned about and dropped by
  `parseSubagentConfig` — those entries fall back to inherit and never break
  spawning. A model without a `provider/modelId` shape or an unknown thinking
  level throws at spawn with the reason and valid choices. Config-sourced
  models are checked against the model registry up-front
  (`ctx.modelRegistry.find(provider, id)` on the part before the first `/`);
  an unknown id fails with `model "…" for explore is not in the model
  registry — add it to ~/.pi/agent/models.json` instead of surfacing as a dead
  worker (`markError` would only show "rpc exited").
- **Where models must be registered**: `~/.pi/agent/models.json` (pi loads it
  at `~/.pi/agent/models.json`; workers run `--no-extensions` but still load
  it, so a registered model resolves there the same as for the primary).
  OpenRouter models additionally need the provider registered + an API key
  (`/login` or `OPENROUTER_API_KEY`); missing auth surfaces through the
  worker's error path at the first LLM call.
- **No primary model**: with a config model override a subagent can spawn
  even when the primary has no active model (today it throws unconditionally).
  Only the inherit path requires the primary's model.

## Verification

- Unit: `npm test` (vitest) — protocol client against a fake `node -e` worker,
  pure helpers (toolsets, spawn argv, transcripts, report caching,
  `subagents` config parse/resolve), plan-mode gate matrices, registration.
- Worker E2E: `node scripts/subagent-smoke.mjs` — real worker, prompt →
  `agent_settled` → `get_last_assistant_text`, follow_up queue-drain, clean
  stop (manual; needs API keys).
- TUI (manual): footer lines + `/agents` overlay behaviors; plan-mode gate;
  general-purpose sandboxing.