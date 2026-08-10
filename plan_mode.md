# Build/Plan modes plan

Goal: bring Claude Code's build/plan mode toggle to pi, plus the priming it
needs — an `ask` tool and a `plan_submit` tool — without subagents. Two parts,
one UX bump.

- **Shift+Tab** cycles **Build** → **Build (auto mode)** → **Plan** when Auto is configured, or Build ↔ Plan otherwise. The footer shows `mode: build`, `mode: build (auto mode)`, and `mode: plan`.
- **Plan mode** exposes read tools (`read`, `grep`, `find`, `ls`), the new
  `ask` tool, `plan_submit`, and — **only to the single plan file** — the
  built-in `write`/`edit` tools. No bash, no other writes. The system prompt
  gains plan directives on every turn started in plan mode.
- **The plan lives in a file** the modes part owns: the agent develops it
  there with normal `write`/`edit`, and `plan_submit` takes a **handle** to
  it. Submission prints the full plan, then asks: *(1)* accept → new session,
  plan as first message, already running; *(2)* talk about the plan →
  freeform text sent back to the agent for revision.

## Decisions locked in

- **allowFreeText is unconditional** — every `ask` question can be answered by
  typing; not a schema field.
- **No timeout on ask** — the agent waits indefinitely; `ask` blocks until the
  user answers or hits Escape (Escape → `cancelled: true`, agent decides).
- **Shift+Tab is free** — verified: `~/.pi/agent/keybindings.json` remaps
  `app.thinking.cycle` → `alt+tab` (`effort.ts` already documents this as
  freeing Shift+Tab). This is a **prerequisite**; if the remap disappears the
  mode toggle silently collides with thinking cycling.
- **Plan file, not plan string.** The plan is a markdown file owned by the
  modes part; `plan_submit` submits a handle to it. The part holds all plan
  markdown files — they persist per session, they're the durable record, and
  the accept flow reads the file rather than trusting agent-echoed text.
- **Normal `write`/`edit`, gated** to the plan file — no new plan-writing
  tools. Incremental edits keep TUI diffs; enforcement is a `tool_call` guard
  resolving the target path against the plan path. Build mode passes
  everything through. (Rejected alternative: name-overriding `write`/`edit`
  like `sandbox.ts` does for `bash` — needs mode-aware wrappers and a
  build-mode passthrough; interception is one pure function and leaves the
  builtins untouched.)
- **Plan path is session-scoped**: `<cwd>/.pi/plans/<sessionId>.md`. Session
  switches don't clobber each other; resume re-derives the same file.
- **Plan toolset otherwise strict**: `read`, `grep`, `find`, `ls`, `ask`,
  `plan_submit`. No bash at all — not even read-only bash (revisit later via
  config).
- **`ask` is active in both modes**; `plan_submit` only exists in plan mode.
- **Mode state is in-memory, per session** — resets to build on
  `session_start`; `autoMode.enabled` only configures Auto availability, while selecting Auto activates it for that session. (new/resume/fork/reload). Persisting the mode across
  sessions is out of scope. The plan *files* however persist on disk.
- **Entering plan mode does not abort the in-flight turn.** The round-trip
  already sent its toolset; that turn finishes, and the plan toolset applies
  from the next LLM call. The cost — a build turn may keep writing for a few
  seconds after the switch — is accepted in exchange for never destroying
  work in progress. Exiting to build mode likewise never aborts.
- **No subagents.** `subagent_architecture.md` stays parked.

## Prerequisites

- `~/.pi/agent/keybindings.json` containing `{"app.thinking.cycle": "alt+tab"}`
  (present in current setup — verify on first run of the part).
- `.pi/plans/` is a runtime dir; nothing to commit (`.pi` is already
  gitignored).

## Architecture

Two new parts registered in `src/index.ts` `PARTS_SPEC`, default-enabled,
toggleable in `~/.pi/agent/extensions/luna.json` like the others:

```ts
ask:   { description: "Agent tool to ask the user structured questions", file: ...parts/ask.ts },
modes: { description: "Build/Plan mode switching (shift+tab)",           file: ...parts/modes.ts },
```

Both follow the `sandbox.ts` shape: a tool factory taking a `ui` deps seam
(`AskUI`, `ModeUI`) so behavior is unit-testable headless, and `hasUI` guards
that throw when there's no UI to prompt.

### Part: `ask` — `src/parts/ask.ts`

Schema (typebox):

```ts
{
  questions: Array<{
    id: string,                // opaque, echoed back in the result
    text: string,              // the question
    options?: string[],        // A/B/C/D list when provided
    multi?: boolean,           // single vs multi-select (A and C)
  }>,
}
```

No `allowFreeText`, no `timeout` — per the locked decisions.

Execution, tiered by need:

1. `!ctx.hasUI` → throw ("no UI to ask"). Blocking forever in a headless mode
   is a hang; refusing is correct.
2. One question, no options → `ctx.ui.input(text)` directly.
3. One question with options, single-select → `ctx.ui.select(text, options)`
   with an appended last item `✎ type your own answer`; choosing it falls
   through to `ctx.ui.input`.
4. Multiple questions, or `multi: true` on any question → a
   `ctx.ui.custom()` overlay form (pi-tui checkbox rows per question + `Input`
   row for free text). **Enter submits all answers at once**, Escape cancels.
   Requires `ctx.mode === "tui"`; in RPC mode fall back to a sequence of plain
   `select`/`input` dialogs.

Result (parseable JSON back to the agent):

```json
{ "answers": [{ "id": "...", "selected": ["A"], "custom": "..." }], "cancelled": false }
```

### Part: `modes` — `src/parts/modes.ts`

State (in-memory, session-scoped):

```ts
type Mode = "build" | "plan";
let mode: Mode = "build";
let buildTools: string[] = [];             // captured at session_start
let handoffPending: string | undefined;    // plan path, after accept, pre-new-session
let planPath: string | undefined;          // .pi/plans/<sessionId>.md
```

**Plan file lifecycle:**

- `session_start` → `planPath = join(ctx.cwd, ".pi", "plans", sessionId + ".md")`,
  `mkdir -p` its directory. Session id via `ctx.sessionManager.getSessionId()`.
- The file is the store: no in-memory plan registry, no `appendEntry` needed
  for the plan itself (the doc survives reloads and resumes). `appendEntry`
  is still used as a journal line per submission (`{ path, ts, accepted }`)
  for `/tree` archaeology.

**Path resolution helper** (pure, testable):

```
resolveTarget(cwd, p) → path.resolve(cwd, p)    // expands relative, ~, ..
allowPlanWrite(writeOrEdit, targetPath, planPath)
  → canonical(targetPath) === canonical(planPath)
```

Canonicalization via `path.resolve`; symlink/path-trick containment is
declared out of scope (documented, not chased).

**Shortcut** — `pi.registerShortcut("shift+tab", ...)`: toggles `mode`,
applies `pi.setActiveTools`, updates footer. Never aborts a running turn.

**Commands** — `/plan [message]` and `/build`, sharing the same toggle path:

- `/plan` enters plan mode; with a `message` argument, the text is sent to
  the agent as a user message after the switch ("start planning X"), so
  planning kicks off in plan mode immediately.
- `/build` returns to build mode; takes no message.

Both are the scriptable/RPC-friendly path (Shift+Tab is TUI-only).

**Tool gating** — pure helper:

```
toolListFor(mode, buildTools):
  build → buildTools minus "plan_submit"   // ask stays (both-modes)
  plan  → ["read","grep","find","ls","ask","plan_submit","write","edit"]
```

`buildTools` is captured at `session_start` from `pi.getActiveTools()`, so
CLI `--tools`/`--exclude-tools` restrictions are respected on restore.
`plan_submit` is stripped from the build set: pi auto-activates *every*
registered extension tool at session_start, so it leaks into
`getActiveTools()` — and its description ("only usable in plan mode")
visibly confuses the model in an executing session — unless we filter it.
`ask` stays in build mode (deliberately both-modes). Note that "bash" in the
build list is the *sandboxed override* — re-adding the name re-enables the
sandbox part, nothing special needed.

**Footer** — `ctx.ui.setStatus("mode", "build mode" | "plan mode")` on
session_start and every toggle. Cleared on shutdown.

**Enforcement — one `tool_call` guard** (`planModeGate`, pure function):

- In plan mode:
  - `write` / `edit` → allowed only if
    `allowPlanWrite(input.path, planPath)`; else
    `{ block: true, reason: "Plan mode: only the plan file is writable" }`.
  - `bash` or any tool outside the plan set →
    `{ block: true, reason: "Not available in plan mode" }`.
  - `plan_submit` with `file` that doesn't resolve to `planPath` → block.
  - while `handoffPending` — block all tools
    (`reason: "Plan accepted — new session starting"`) so the agent doesn't
    burn work between accept and the handoff command running.
- Build mode: `plan_submit` blocked by name (paranoia backing up the
  toolset strip). Everything else passes.

**Plan directives** — `pi.on("before_agent_start")`: if `mode === "plan"`,
append to the chained system prompt a rendered planning directive. The
directive is a port of polytoken's shipped plan facet
(`polytoken://facets/plan.md`): read-only side-effect discipline, intent
classification, the plan artifact specification, and the plan-review loop.
Two markdown assets in `src/parts/` are the source of truth — editing them
changes the prompt without touching TypeScript:

- `src/parts/plan_prompt.md` — the directive body. Carries exactly three
  template anchors: `{{plan_path}}`, `{{plan_spec}}`, `{{plan_spec_path}}`.
- `src/parts/plan_spec_default.md` — the plan artifact specification (Goal /
  Implementation Summary / Implementation Plan / Acceptance Criteria / Test
  Strategy / Review Strategy / Documentation Strategy / Risks), a port of
  polytoken's default plan spec (`polytoken://resources/plan_spec_default.md`),
  spliced in at the `{{plan_spec}}` anchor.

`modes.ts` reads both at load via the `import.meta.url` pattern
(`renderPlanDirective()` splices them per plan-mode turn and throws if an
anchor ever goes missing, so a doc edit can't silently drop the spec). The
polytoken → pi-luna tool-name mapping the port follows is the table in the
port's plan document, under `.pi/plans/`.

The directive runs the review loop on a dedicated **`plan-reviewer`**
subagent type (see `subagents.ts`): a read-only reviewer with its own system
prompt (explore toolset) that reads the plan file and the specification and
returns severity-tagged findings. Review is strongly recommended, not
required — luna decides at the `plan_submit` approval step. Test-infrastructure
gaps must be handled by revising the plan to build the missing infra; they are
surfaced via `ask` before `plan_submit` only when genuinely out of scope.

### plan_submit

Registered by `modes`, active only in plan mode (registered always so the
guard has a name to police).

Schema: `{ file: string, message?: string }` — `file` is the handle (must
resolve to `planPath`), `message` an optional short note.

`execute`:
1. `!ctx.hasUI` → throw.
2. Validate the handle (`allowPlanWrite`), read the file. Missing/empty →
   error result: "No plan at <path> yet — write it first."
3. Echo the full file content in the tool result card so it's printed in the
   transcript.
4. `ctx.ui.select("Plan submitted", ["Accept & start building", "Talk about the plan"])`
   — accept listed first, so the dialog's default highlight is **Accept**
   (Enter accepts; down-arrow for Talk; Escape cancels).
   - **Escape** → result `"Plan submission cancelled — still in plan mode."`
   - **Accept** → `handoffPending = planPath`; journal via `appendEntry`;
     result `"Plan accepted — a new session will start executing it."`;
     `terminate: true`. The handoff runs from the `agent_settled` hook
     (below): `/plan-accept <path>` is staged in the editor and submitted
     with one injected Enter.
   - **Talk** → `ctx.ui.input("Feedback:", "")`; queue
     `pi.sendUserMessage(feedback, { deliverAs: "steer" })`; result
     `"Feedback sent — revise the plan and resubmit."`

**Why the command handoff:** `plan_submit` is a tool and tools run with
`ExtensionContext`; `ctx.newSession()` lives only on `ExtensionCommandContext`
— commands are the only surface pi hands it to. There is **no API to
dispatch a command programmatically**, and both obvious hacks lose:

- Queued `"/plan-accept"` as `deliverAs: "followUp"` bypasses extension
  command dispatch entirely (pi's `sendUserMessage` passes
  `expandPromptTemplates: false`; queued steers/followUps are injected as
  plain user messages) — the original bug: the *model* got the text.
- Capturing a command ctx and calling `ctx.newSession()` from
  `agent_settled` fails because pi invalidates its entire extension runner
  at session replacement (`teardownCurrent → dispose → invalidate`) — every
  guarded getter on the captured ctx throws the staleness error at
  `newSession` time (the "context not found" failure).

So instead of dispatching, the `agent_settled` hook **types**: it stages
`/plan-accept <path>` into the editor (`ctx.ui.setEditorText`) and injects
one `\r` into `process.stdin` — pi-tui reads stdin in flowing mode, so the
keypress is consumed exactly like a physical Enter, and the TUI runs the
command on a command ctx it mints fresh. Graceful degradation: no TUI
(RPC/print) or an occupied editor → notify `"Plan accepted — start it with: /plan-accept <path>"` instead; if stdin injection fails, the staged
command stays in the editor, one physical Enter away.

**`/plan-accept <path>` command (the converge point):**
1. Read the plan file at `<path>` (validated; missing → error notify).
2. `ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      withSession: async (ctx) => {
        await ctx.sendUserMessage(content + `\n\ncan you build this?`);
      }
    })`
3. `sendUserMessage` always triggers a turn → the plan lands as the **first
   message of the fresh session and immediately starts executing**. The new
   session starts in **build mode** by default (fresh `session_start` → mode
   reset), which is exactly what "already running it" means. The kickoff
   message is the plan verbatim plus the trailing `\n\ncan you build this?`
   (luna's exact Enter equivalent). The old plan file stays in `.pi/plans/`
   for history.

Footgun checked against the docs: `withSession` receives a fresh
replacement-session `ctx`; capture only plain data (the file content string
and parent session path) before `newSession`, never captured `pi`/old `ctx`
objects — they are stale after the teardown.

## Edge cases

- **Shift+Tab mid-turn** — the in-flight turn finishes with the toolset
  already sent to it; the plan set applies from the next LLM call. A build
  turn that keeps writing a moment after the switch is accepted-by-design
  (see locked decisions).
- **write/edit path tricks** — `../`, `~`, `./` all normalize through
  `path.resolve` before the comparison; `..` escapes fail the check. Symlink
  aliasing is out of scope (documented).
- **Agent calls plan_submit before writing** — clear error result, stays in
  plan mode.
- **Session switch / resume** — plan path derives from session id; a
  different session gets its own file. Resume re-derives the same file.
- **Reload** — mode + `handoffPending` reset; `.pi/plans/` persists so the
  plan text survives; the pending handoff won't re-fire (known limitation,
  mirror of the previous design).
- **RPC mode** — `ctx.hasUI` true; `select`/`input` work over the RPC UI
  protocol, `custom()` doesn't → ask tier 4 fallback handles this. The
  footer status is a no-op in non-TUI modes; harmless.
- **CLI `--tools` restrict** — buildTools captured from the *effective* set,
  so restore is correct. If a tool in the plan set was excluded by the
  invocation, plan mode simply doesn't offer it.
- **sandbox interplay** — `.pi/plans/` sits under `.` which is in the
  sandbox's `allowWrite`; and plan mode has no bash anyway. No sandbox
  config change needed.

## Tests (mirror existing seams)

- `test/ask.test.ts` — fake `AskUI`; schema accepts/rejects; tiers 2/3/4
  mapping (select→option, select→"✎"→input, custom form for multi/multi-q);
  Escape → `cancelled: true`; no-UI throws.
- `test/modes.test.ts` —
  - `toolListFor(build|plan, buildTools)` exact sets; build strips
    `plan_submit` but keeps `ask`;
  - `allowPlanWrite` matrix: exact path (absolute, relative, `~/`, `../`
    escapes, missing `path` field) — block/allow;
  - `planModeGate` matrix: write/edit on plan path in plan mode pass, off
    path block; bash block; plan_submit correct handle pass, wrong handle
    block; build mode passes everything except plan_submit;
  - accept/talk/cancel decision mapping through a fake `ModeUI` (which action
    sets `handoffPending`, which queues steer vs followUp, which journals);
  - accept handoff: `terminate` + nothing queued; `agent_settled` stages
    `/plan-accept <path>` in the editor and injects `\r` (occupied editor /
    non-TUI → notify fallback); `/plan-accept` content assembly (first
    message = plan + `\n\ncan you build this?`).
- `test/registration.test.ts` — extend: `ask`, `modes` keys present in
  `PARTS_SPEC`; enabling registers `ask`, `plan_submit`, `/plan-accept`,
  `/plan`, `/build`, and the shortcut.

## Files

- `src/parts/ask.ts` (new), `src/parts/modes.ts` (new)
- `src/index.ts` — two PARTS_SPEC entries
- `test/ask.test.ts`, `test/modes.test.ts` (new); `test/registration.test.ts`
  (extend)
- Runtime (uncommitted): `.pi/plans/<sessionId>.md`

## Out of scope

- Subagents / `prepareProcess`
- Persisting mode choice across sessions
- Multi-file plans, symlink containment, plan templates
- Configurable plan-mode toolset (e.g. read-only bash later)

## Resolved in review

1. In-flight turn finishes; no abort on mode switch.
2. `/plan [message]` and `/build` commands (plus Shift+Tab toggle).
3. Accept is the default-highlighted option.
4. `plan_submit` keeps optional `message`.
5. No `PLAN.md` promotion — `.pi/plans/` is the only home.
