# Sandboxing plan for pi-luna

Goal: override pi's `bash` tool so every agent command runs inside a landstrip
sandbox by default. The agent may explicitly request `sandbox: false`; that
request is gated by an unsandboxed-program allowlist, falling back to a live
prompt to luna when the program isn't listed.

Subagents are **out of scope**. Architecture leaves room for
`prepareProcess`-based subagents later.

## Decisions locked in (from review)

- **Read posture: allow-list only.** No `denyRead` of `/home`. `allowRead` is
  `[".", "~/.gitconfig", "~/.config/git/config", "/dev/null"]`; Landlock
  default-denies everything else.
- **Two-gate model.** Sandboxed is the default and carries no prompts.
  `sandbox:false` is an explicit agent escalation that must pass the
  unsandboxed-allow rules or a live prompt.
- **Bare-program rules.** A rule is just a program name (`git`, `make`). If
  `git` is on the unsandboxed list, then *when the agent chooses*
  `sandbox:false` for a git command it runs raw without prompting. Being listed
  never forces unsandboxed execution — default is always sandboxed.
- **Never auto-rerun.** A failed sandboxed command is reported to the agent
  with its denial info; re-running unsandboxed is the agent's decision, never
  automatic.
- **Network fully open in the sandbox.** `allowNetwork:true` — the sandbox
  confines the filesystem only. No proxy, no per-domain egress control, no
  Landlock `AccessNet` rules, no connect/bind seccomp filter. We decided
  transparent/proxied network control is out of scope; sandboxed commands get
  unrestricted network.
- **Per-project override: yes**, persisted to `.pi/sandbox.json`, behind a
  trust gate.
- **Batteries-included binary.** `@landstrip/landstrip` is a `dependencies`
  entry; `npm install` pulls the meta-package whose `optionalDependencies`
  fetch the platform binary. pi auto-resolves extension `node_modules`. We
  locate the binary via the package's `binaryPath()` — no PATH lookup.

## Approach: drive the landstrip CLI directly

Depend on `@landstrip/landstrip`, **not** the `pi-landstrip` extension.
pi-landstrip's value-add is its own bash tool, `/sandbox` TUI, prompt
coordinator, and subagent stack — none of which we want. The sandbox mechanism
lives entirely in the native binary behind a small CLI contract.

Crucially, **we do not use `--trap-fd` or the live broker query channel.**
Sandboxed runs are fire-and-forget: landstrip enforces the static policy, and
on denial it writes terminal trap records to the child's **stderr** as JSON
lines. We parse those off stderr to detect "failed because of the sandbox."
No socket pair, no suspended syscalls, no control-response loop, no fd
injection. This is the big simplification the two-gate model buys us.

## New sub-extension: `src/parts/sandbox.ts`

Registered in `PARTS_SPEC`, default-enabled, toggleable in
`~/.pi/agent/extensions/luna.json`.

### 1. Bash tool override

`pi.registerTool({ name: "bash", ... })` — pi supports name-override of
built-ins; `renderCall`/`renderResult` inherit per-slot when omitted. We
override only `execute` and the schema.

Input schema = built-in bash schema + one field:

```ts
{ command: string; timeout?: number; sandbox?: boolean /* default true */ }
```

`promptSnippet`/`promptGuidelines` are NOT inherited on override, so we carry
over the built-in bash prompt text and append:

> Commands run inside an OS sandbox (Landlock + seccomp) that confines the
> filesystem to the working directory (network is unrestricted). If a command
> fails due to a filesystem denial you'll be told which path was denied; retry
> that command with `sandbox: false` to request running it unsandboxed
> (subject to user approval).

### 2. Configuration: one file, two concerns

`sandbox.json` holds both the sandbox policy and the unsandboxed allowlist.

Bundled base at `src/parts/sandbox.json`:

```json
{
  "enabled": true,
  "unsandboxedAllow": [],
  "shell": { "readAccess": "host" },
  "network": {
    "allowNetwork": true, "allowLocalBinding": true,
    "allowAllUnixSockets": true, "allowUnixSockets": [],
    "allowedDomains": [], "deniedDomains": []
  },
  "filesystem": {
    "denyRead": [],
    "allowRead":  [".", "~/.gitconfig", "~/.config/git/config", "/dev/null"],
    "allowWrite": [".", "/dev/null", "/tmp"],
    "denyWrite":  ["**/.env", "**/.env.*", "**/*.pem", "**/*.key",
                   ".pi/sandbox.json", "~/.pi/agent/sandbox.json"]
  }
}
```

- `unsandboxedAllow`: list of bare program names permitted to run raw when the
  agent passes `sandbox:false`. This is luna's addition, not a landstrip field
  — we strip it before handing the rest to landstrip as the policy.
- `shell.readAccess:"host"` lets the shell bootstrap read host rc/env; the
  command stays confined.
- `allowWrite` includes `/tmp` (builds need it).
- `denyWrite` hard-blocks secrets even under allowed roots.
- `.pi/sandbox.json` is deny-write so a sandboxed command can't edit policy.

**Layering / precedence** (base < global < project < session):
- base: bundled file
- global: `~/.pi/agent/sandbox.json`
- project: `<cwd>/.pi/sandbox.json`, **only if project trusted**
  (`ctx.isProjectTrusted?.()`), since a repo could otherwise grant itself
  unsandboxed access
- session: in-memory list, highest precedence, lost on exit

The filesystem/network portion merges recursively (objects merge, arrays
combine — same rule as landstrip's multi-`-p`). `unsandboxedAllow` arrays
concatenate across tiers. Each command's effective landstrip policy is written
to a fresh `mkdtemp` file and deleted on dispose; no shared mutable file.

### 3. Sandboxed path (default)

```
execute(params, sandbox !== false):
  policy = merge(base, global, project?, sessionSandboxGrants)
  write policy to tmpfile
  child = spawn(binaryPath(),
    ["run","-p",tmpfile,"--",shell,...args,wrap(command)],
    { stdio:["ignore","pipe","pipe"], detached:true })
  capture stdout+stderr; scan stderr for trap JSON lines
  on exit:
    parse traps → denialList
    if exit!=0 and denialList non-empty → append denial note to result
```

Shell wrapping mirrors pi-landstrip's posix provider: write an `env.sh` of the
composed env, run `source env.sh && <command>`, add the env file to that
invocation's read paths.

**Denial detection.** Landstrip emits each denial as a flat JSON line tagged
by `kind` (`FILESYSTEM_DENIED`, `NETWORK_DENIED`, `LAUNCH_FAILED`, …) on
stderr. We collect them and, on non-zero exit, append:

```
Sandbox: this command was denied:
  - write /home/luna/.ssh/config
  - connect github.com:443
Retry with sandbox: false to request unsandboxed execution.
```

That's the agent's only signal — no prompt appears for sandboxed runs.

### 4. `sandbox: false` path (gated escalation)

```
execute(params, sandbox === false):
  argv0 = basename(first token of command, resolved through shell if needed)
  if argv0 in effectiveUnsandboxedAllow:        // session | project | global | base
      runRaw()
  else:
      choice = await ui.menu(
        `${command}`,
        ["deny",
         "allow once",
         `always allow ${argv0} this session`,
         `always allow ${argv0} for this project`,   // only if project trusted
         `always allow ${argv0} globally`])
      deny     → return toolError("unsandboxed run denied")
      once     → runRaw()
      session  → sessionUnsandboxed.add(argv0); runRaw()
      project  → append argv0 to .pi/sandbox.json unsandboxedAllow; runRaw()
      global   → append argv0 to ~/.pi/agent/sandbox.json unsandboxedAllow; runRaw()

runRaw(): spawn via createLocalBashOperations()  // identical kill/timeout/shell
          to the built-in bash tool
```

- The menu shows the **exact command verbatim** as the title.
- Project option hidden when the project isn't trusted.
- "allow once" stores nothing.
- argv0 extraction: take the command string, resolve the leading token to its
  executable basename (handle `VAR=x prog`, `sudo prog` minimally — leading
  env-assignments stripped; anything exotic falls back to the literal first
  token). Best-effort; the point is a stable rule key, not perfect parsing.
- If `ctx.hasUI` is false, unlisted programs are denied (no headless prompt).

### 5. Platform behavior

- **Linux** (your machine): full path — Landlock + seccomp, stderr trap
  detection. Primary target.
- **macOS**: Seatbelt, denials surface as EPERM/EACCES in stderr (less
  structured JSON). Denial detection is best-effort via stderr text; the
  `sandbox:false` gate works identically. Degraded but functional.
- **Windows**: out of scope. Part detects `win32`, no-ops with a warning.

### 6. UI surface

- The unsandboxed-approval menu (only interactive element).
- `/sandbox` command (read-only): active?, `binaryPath()`, `landstrip doctor`
  output, effective merged landstrip policy, and the effective
  `unsandboxedAllow` list split by tier.
- Footer status `ctx.ui.setStatus("sandbox", …)`: on/off + count of session
  unsandboxed grants.

## Files

- `src/parts/sandbox.ts` — the part (~300 lines: config load/merge, sandboxed
  spawn, stderr trap parse, unsandboxed gate + menu, tool def, `/sandbox`).
- `src/parts/sandbox.json` — bundled base policy.
- `src/index.ts` — add `sandbox` to `PARTS_SPEC`.
- `package.json` — add `"@landstrip/landstrip": "^0.18.26"` to `dependencies`;
  `npm install` (pulls platform binary into
  `node_modules/@landstrip/landstrip-linux-x64`).

## Testing (per testing pillars — test our seams, not the kernel)

1. `landstrip policy validate` passes on the bundled base policy (minus the
   `unsandboxedAllow` key, which we strip first).
2. Config merge: precedence order, project gated on trust, `unsandboxedAllow`
   concatenation, `unsandboxedAllow` stripped before landstrip.
3. Trap-line parser: denial kinds, malformed lines, partial-line-across-reads.
4. argv0 extraction: bare, `VAR=x prog`, leading `sudo`, exotic fallback.
5. Integration (Linux, headless-ok):
   - `echo hi` → exit 0, no traps.
   - `cat /etc/shadow` → fails, denial note present in result.
   - `curl -sI https://example.com` from a sandboxed run → succeeds (network
     is unrestricted in the sandbox).
   - `sandbox:false` with argv0 not listed + UI stub deny → toolError.
   - `sandbox:false` with argv0 not listed + UI stub "allow once" → runs raw.
   - `sandbox:false` with argv0 pre-listed in session → runs raw, no menu.
6. `landstrip doctor` once during implementation as a sanity check.

## Later phases (not this plan)

- Auto-mode approval model ahead of the UI menu in the `sandbox:false` gate
  (stub hook left in place).
- Outbound network control, if ever wanted, via landstrip's authenticated
  egress proxy (per-domain `allowedDomains`). Decided out of scope for now —
  network is simply open in the sandbox.
- Arg-pattern rules (e.g. allow `git push` but not arbitrary `git`).
- Subagents on `prepareProcess`-equivalent logic.
- Richer `/sandbox` TUI (rule management, policy editor).

---

# Appendix: implementation context (for a cold start)

Everything below is verified against the installed packages, not from memory.
A fresh thread should be able to implement without re-deriving these.

## A. Exact API contracts we rely on

### Overriding the built-in bash tool

`pi.registerTool({ name: "bash", ... })` replaces the built-in. Renderers
inherit per-slot: omit `renderCall`/`renderResult` and the built-in bash
rendering (syntax highlight, output box) is used. Omit both → fully stock UI.

The `ToolDefinition` shape (from
`@earendil-works/pi-coding-agent` → `dist/core/extensions/types.d.ts`):

```ts
interface ToolDefinition<TParams extends TSchema, TDetails, TState> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;      // NOT inherited from built-in — we must supply
  promptGuidelines?: string[]; // NOT inherited — we must supply
  parameters: TParams;          // TypeBox schema
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
  renderCall?: ...;   // omit → inherit built-in
  renderResult?: ...; // omit → inherit built-in
}
```

`AgentToolResult<TDetails>` (from `@earendil-works/pi-agent-core`):

```ts
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // text to the model
  details: T;                               // structured, for UI/logs
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
// TextContent = { type: "text", text: string }
```

Our result is `AgentToolResult<BashToolDetails | undefined>` where
`BashToolDetails = { truncation?: TruncationResult; fullOutputPath?: string }`.

### Reusing pi's shell execution for the raw (unsandboxed) path

```ts
import { createBashToolDefinition, createLocalBashOperations }
  from "@earendil-works/pi-coding-agent";
```

- `createLocalBashOperations({ shellPath? })` → `BashOperations` with pi's
  standard local spawn / process-group kill / timeout. We call its
  `exec(command, cwd, { onData, signal, timeout, env })` for `sandbox:false`
  runs so behavior matches the built-in tool exactly.
- Alternatively wrap `createBashToolDefinition(cwd, { operations })` and
  delegate `execute` to it, so output truncation and `BashToolDetails` come
  free. **Prefer this**: build our tool by wrapping
  `createBashToolDefinition`, swapping `operations` per call site —
  sandboxed ops for `sandbox:true`, `createLocalBashOperations()` for
  `sandbox:false`. That keeps truncation/render/result-shape correct by
  construction.

`BashOperations.exec` returns `Promise<{ exitCode: number | null }>` and
streams via `onData: (data: Buffer) => void`.

### Context / trust / UI

```ts
ctx: ExtensionContext {
  hasUI: boolean;                 // false → never prompt, auto-deny
  isProjectTrusted(): boolean;    // gate for project-tier rules & menu opt 4
  ui.confirm(title, msg): Promise<boolean>;
  ui.select(title, options): Promise<string>;  // our 5-option menu
  ui.setStatus(key, text): void;               // footer
  cwd: string;
}
```

Headless note: `-p` / `--mode json` don't prompt for trust; project resources
only load when trusted. `ctx.hasUI` is true in `--mode rpc` (dialogs proxied).

### The landstrip binary

```ts
import { binaryPath } from "@landstrip/landstrip";
binaryPath();  // absolute path to the native binary for this platform
```

`@landstrip/landstrip` is a meta-package; `optionalDependencies` pull
`@landstrip/landstrip-<platform>-<arch>`. Add it to pi-luna `dependencies`,
run `npm install` in the pi-luna dir, and pi resolves it from
`node_modules/` automatically. No PATH lookup.

## B. Landstrip trap format (what we parse off stderr)

Without `--trap-fd`, terminal trap records are written to the child's **stderr**
as newline-delimited JSON. The discriminated union (from
`@landstrip/landstrip` `lib/index.d.ts`) — we only need the terminal kinds:

```ts
type LandstripTrap =
  | { kind: "filesystem"; code: "FILESYSTEM_DENIED";
      operation: "read" | "write"; path: string; requested_path: string;
      syscall: string; errno: string; reason: "allow_miss" | "deny_match";
      suggested_grant: { allowRead?: string; allowWrite?: string };
      process: { pid: number; exe: string | null; cwd: string | null } }
  | { kind: "network"; code: "NETWORK_DENIED";
      operation: "connect" | "bind"; target: string; syscall: string }
  | { kind: "launch"; code: "LAUNCH_FAILED"; program: string; message: string }
  | { kind: "usage"; code: "USAGE_ERROR"; message: string }
  | { kind: "internal"; code: string; message: string };
```

Parsing rule: a stderr line is a trap iff it parses as JSON, is an object, has
a string `kind` in the set above and a string `code`. Anything else is program
stderr and is passed through to output untouched. We collect traps; on non-zero
exit with ≥1 denial trap we append the denial note to the result `content`.

(With network open — `allowNetwork:true` — we expect few `NETWORK_DENIED`
traps, but parse them anyway for forward-compat.)

## C. pi-luna conventions the part must follow

- Parts live in `src/parts/`, registered in `PARTS_SPEC` in `src/index.ts`
  with `{ description, file: join(__dirname, "parts", "<name>.ts") }`.
- Parts are **dynamically imported** (`await import(spec.file)`), default
  enabled, toggleable via `~/.pi/agent/extensions/luna.json` →
  `extensions: { sandbox: false }`. A disabled part is never imported.
- Each part exports `export default function (pi: ExtensionAPI)`.
- Do NOT start long-lived resources at import; defer to `session_start` /
  first use. Register a `session_shutdown` to clean up session state (the
  in-memory session grant tier).
- Config tiers: base (bundled) < global `~/.pi/agent/sandbox.json` < project
  `<cwd>/.pi/sandbox.json` (trusted only) < session (in-memory). Objects merge
  recursively, arrays concatenate, later scalars win (mirror landstrip's
  multi-`-p` merge). `unsandboxedAllow` concatenates across tiers and is
  stripped before the policy is handed to landstrip.

## D. Run / verify loop

```bash
cd ~/git/pi-luna
npm install                      # pulls @landstrip/landstrip + platform binary
node -e "console.log(require('@landstrip/landstrip').binaryPath())"
$(node -e "process.stdout.write(require('@landstrip/landstrip').binaryPath())") doctor
#   ^ must print OK on this machine (Landlock + seccomp user_notif available)

# run pi with the extension loaded over the repo:
pi -e ./src/index.ts

# headless smoke (no trust prompt; project not trusted → project tier skipped):
pi -p -e ./src/index.ts "run the bash tool: echo hi"
```

Interactive: launch `pi -e ./src/index.ts`, ask the agent to `cat /etc/shadow`
(expect a sandbox denial note), then to rerun it with `sandbox:false` (expect
the approval menu).

## E. TDD acceptance checklist (write tests first)

Build an integration test suite (vitest, matching pi-landstrip's setup) that
spawns the real landstrip binary on Linux and stubs `ctx.ui` for the menu.
Write these tests **before** the implementation, watch them fail, then
implement to green.

Tool-behavior tests:
- [ ] `bash("echo hi")` (sandbox default) exits 0, output contains "hi", no
      denial note.
- [ ] `bash("cat /etc/shadow")` exits non-zero and the result `content`
      includes a "Sandbox: this command was denied" note naming the path.
- [ ] `bash("curl -sI https://example.com")` succeeds (network open in
      sandbox).
- [ ] `bash(cmd, { sandbox:false })` with `git` NOT in `unsandboxedAllow` and
      UI stub answering "deny" → result is an error, command did NOT run.
- [ ] same, UI stub answering "allow once" → command runs raw; store stays
      empty (a second call prompts again).
- [ ] same, UI stub answering "session" → runs raw; a second `sandbox:false`
      git call runs WITHOUT prompting.
- [ ] `sandbox:false` with `git` pre-seeded in the session tier → runs raw, no
      menu shown.
- [ ] project-tier menu option is absent when `isProjectTrusted()` is false.

Unit tests (our seams, not the kernel):
- [ ] base policy passes `landstrip policy validate` (after stripping
      `unsandboxedAllow`).
- [ ] trap parser: accepts each denial kind, rejects malformed/non-JSON/plain
      stderr lines, handles a JSON line split across two stderr reads.
- [ ] config merge: precedence order, arrays concatenate, project skipped when
      untrusted, `unsandboxedAllow` stripped from the landstrip policy.
- [ ] argv0 extraction: `git push` → `git`; `FOO=1 git` → `git`;
      `/usr/bin/git` → `git`; `sudo git` → `git`.

Done = all green + `landstrip doctor` OK + the two manual smoke tests behave.
