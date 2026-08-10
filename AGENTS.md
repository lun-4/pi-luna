# AGENTS.md

These are guidelines and context for coding agents to follow on this codebase:

## what it is

pi-luna is luna's global meta-extension for the pi coding agent — a set of
extensions to make pi feel more homely. It ships seven toggleable sub-parts
(`ask`, `bell`, `effort`, `exit`, `sandbox`, `modes`, `subagents`), each
registering tools, commands, events, or keybindings with pi.

Architecture: `src/index.ts` is an async factory that dynamically
`await import()`s enabled sub-extensions from `src/parts/` based on toggle
config in `~/.pi/agent/extensions/luna.json` (unlisted parts default to
enabled; a disabled part is never imported at all). It also registers a
`/luna` management command. Toggle changes require a `/reload`. There is no
build step — pi runs the extension straight from source via its jiti loader.

## how to build & test it

```sh
# Run the extension from source (per package.json pi.extensions entry)
pi -e ./src/index.ts

# Run the full test suite (vitest)
npm test

# Watch mode
npm run test:watch

# Run only the integration suite from a TOP-LEVEL shell
# (spawns the real landstrip binary; auto-skips when nested inside a sandbox)
npx vitest run test/integration.test.ts
```

Notes:
- Requires Node >= 22.19.0 (engine field).
- Manual smoke scripts live in `scripts/` (`subagent-smoke.mjs`,
  `verify-model-override.mjs` need real API keys; `sandbox-smoke.mjs` /
  `landstrip-probe*.mjs` probe the landstrip sandbox locally).
- Plan-mode (`modes.ts`) depends on the `shift+tab` keybinding.

## initial directories

- `src/` — extension source: `index.ts` (dynamic loader) and `parts/`
  (one file per sub-extension, plus support: `rpc-process.ts`,
  `agents-overlay.ts`, `sandbox.json` base policy, `command-parser.ts`
  (single-command gate parser), `classifier.ts` + `classifier-prompt.md`
  (auto-mode escalation classifier))
- `test/` — vitest suites, one per part plus
  `integration.test.ts` (spawns the real landstrip binary)
- `benchmarks/classifier/` — malicious-agent corpus (`corpus/*.json`),
  `candidate-prompts/`, `RESULTS.md` + `RESULTS.csv` (see
  `test/benchmark-classifier.test.ts`)
- `scripts/` — manual smoke/probe scripts
- root markdown — design docs (`plan_mode.md`, `sandboxing_plan.md`,
  `subagent_architecture.md`, `subagent_ui.md`, `TODO.md`)
- `.pi/plans/` — plan-mode state