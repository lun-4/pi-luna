/**
 * Sandbox part
 *
 * Overrides pi's built-in `bash` tool so every agent command runs inside a
 * landstrip sandbox (Landlock + seccomp on Linux, Seatbelt on macOS) by
 * default. The agent may pass `sandbox: false` to request a raw run; that
 * escalation is gated by an unsandboxed-program allowlist (session → project →
 * global → base) and otherwise prompts luna live.
 *
 * The gate is structured around a conservative single-simple-command parser
 * (src/parts/command-parser.ts): `sandbox:false` requests that are provably a
 * single simple, non-interpreter, allowlisted command run raw **silently**
 * (the friction reducer); everything else — compound/`&&`/`;`/`cd`-wrapped
 * commands, interpreters, unlisted programs — reaches adjudication:
 *
 *   - interactive mode: the existing verbatim approval menu
 *   - auto mode (`autoMode.enabled`): a secondary LLM "classifier" reviews the
 *     redacted conversation thread + the verbatim command and returns a strict
 *     yes/no (src/parts/classifier.ts). The classifier never persists a grant
 *     and never "always allows"; every failure fails safe toward the human.
 *
 * Sandboxed runs are fire-and-forget: landstrip enforces a static policy and
 * writes terminal trap records as JSON lines on the child's stderr. We parse
 * those to detect "failed because of the sandbox" and surface the denied
 * paths to the agent. No broker socket, no suspended syscalls. (Verified
 * empirically via scripts/landstrip-probe*.mjs: every denial landstrip
 * causes — Landlock allow-miss or glob deny — emits a trap.)
 *
 * Filesystem posture (empirically derived): writes are allow-listed (cwd,
 * /tmp, toolchain caches); reads deny the home roots (/home, /Users, /root)
 * with targeted allowRead exceptions (project, git config, toolchain caches).
 * NOTE: `allowRead` alone does NOT confine reads, and `denyRead: ["/"]`
 * breaks the dynamic loader — denying the home roots is the viable posture.
 * `~/.ssh` & co. stay denied.
 *
 * Config tiers (base < global < project < session), arrays concatenate,
 * objects merge, later scalars win. `unsandboxedAllow`, `autoMode` are
 * pi-luna additions and are stripped before the policy is handed to landstrip.
 * The global tier is ~/.pi/agent/luna-sandbox.json — NOT ~/.pi/agent/sandbox.json,
 * which belongs to pi-landstrip and carries incompatible network semantics.
 */

import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { binaryPath } from "@landstrip/landstrip";
import { Text, type Component } from "@earendil-works/pi-tui";
import { ringBell } from "./bell.ts";
import { getMode, type Mode } from "./mode-state.ts";
import {
  loadConfig, mergeTiers, type LoadOpts, type SandboxAutoModeConfig, type SandboxConfig,
} from "./sandbox-config.ts";
export { loadConfig, mergeTiers } from "./sandbox-config.ts";
export type { LoadOpts, SandboxAutoModeConfig, SandboxConfig } from "./sandbox-config.ts";
import {
  parseEscalationRequest,
  DEFAULT_INTERPRETER_PROGRAMS,
} from "./command-parser.ts";
import {
  addUsage,
  buildClassifierThread,
  createModelRegistryClassifier,
  resolveSystemPrompt,
  type ClassifiedRun,
  type ClassifierClient,
} from "./classifier.ts";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Default model id as catalogued under the openrouter provider. */
export const DEFAULT_AUTO_MODEL = "deepseek/deepseek-v4-flash-0731";

/** Trap codes we treat as "denied because of the sandbox". */
const DENIAL_CODES = new Set(["FILESYSTEM_DENIED", "NETWORK_DENIED"]);
/** Trap codes meaning the sandbox itself never started the command. */
const SETUP_CODES = new Set(["SANDBOX_SETUP_FAILED", "LAUNCH_FAILED", "POLICY_PARSE_FAILED"]);
const TRAP_KINDS = new Set(["filesystem", "network", "launch", "usage", "internal"]);

export interface Trap {
  kind: string;
  code: string;
  operation?: string;
  path?: string;
  requested_path?: string;
  target?: string;
  message?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// argv0 extraction
// ---------------------------------------------------------------------------

/** Best-effort resolution of the program name a command line will exec. */
export function extractArgv0(command: string): string {
  let tokens = command.trim().split(/\s+/);
  // strip leading VAR=value assignments
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  // strip a leading sudo (with simple flags; flags taking a value consume the next token)
  if (tokens[0] === "sudo") {
    tokens.shift();
    while (tokens.length && tokens[0].startsWith("-")) {
      const flag = tokens.shift()!;
      if (/^-[ughpCcURD]$/.test(flag)) tokens.shift(); // flags that take a value
    }
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  }
  const first = tokens[0] ?? "";
  return basename(first);
}

// ---------------------------------------------------------------------------
// Trap parsing
// ---------------------------------------------------------------------------

export class TrapParser {
  private buf = "";
  private traps: Trap[] = [];
  private passthrough: string[] = [];

  feed(data: Buffer): void {
    this.buf += data.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 1);
    }
  }

  /** Newly collected program-stderr lines since the last drain. */
  drainPassthrough(): string[] {
    const out = this.passthrough;
    this.passthrough = [];
    return out;
  }

  /** Flush any trailing partial line; returns everything. */
  finish(): { traps: Trap[]; passthrough: string[] } {
    if (this.buf.length) this.line(this.buf);
    this.buf = "";
    return { traps: this.traps, passthrough: this.drainPassthrough() };
  }

  private line(raw: string): void {
    const s = raw.trim();
    if (!s) return;
    try {
      const obj = JSON.parse(s);
      if (
        obj &&
        typeof obj === "object" &&
        !Array.isArray(obj) &&
        typeof obj.kind === "string" &&
        TRAP_KINDS.has(obj.kind) &&
        typeof obj.code === "string"
      ) {
        this.traps.push(obj as Trap);
        return;
      }
    } catch {
      /* not JSON → program stderr */
    }
    this.passthrough.push(raw);
  }
}

/** Render the "Sandbox: this command was denied" note, or undefined. */
export function formatDenials(traps: Trap[]): string | undefined {
  const denials = traps.filter((t) => DENIAL_CODES.has(t.code));
  if (!denials.length) return undefined;
  const lines = denials.map((t) => {
    if (t.kind === "filesystem") return `  - ${t.operation} ${t.path ?? t.requested_path ?? "?"}`;
    if (t.kind === "network") return `  - ${t.operation} ${t.target ?? "?"}`;
    return `  - ${t.code}`;
  });
  return [
    "Sandbox: this command was denied:",
    ...lines,
    "Retry with sandbox: false to request unsandboxed execution.",
  ].join("\n");
}

/** Strip pi-luna-only keys before handing the policy to landstrip. */
export function landstripPolicy(cfg: SandboxConfig): Record<string, unknown> {
  const { enabled: _e, unsandboxedAllow: _u, autoMode: _a, ...rest } = cfg;
  return rest;
}

// ---------------------------------------------------------------------------
// Sandboxed BashOperations
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

/**
 * BashOperations whose exec runs the command via `landstrip run`. stdout
 * streams through untouched; stderr is filtered for trap JSON lines (collected
 * for denial reporting, the rest passed through). On a non-zero exit caused
 * by sandbox denials, the denial note is appended to the output stream so the
 * wrapping tool reports it exactly like ordinary command output.
 */
export function createSandboxedOperations(policy: Record<string, unknown>): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) {
        throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
      }
      if (signal?.aborted) throw new Error("aborted");

      const dir = mkdtempSync(join(tmpdir(), "luna-sandbox-"));
      const policyFile = join(dir, "policy.json");
      writeFileSync(policyFile, JSON.stringify(policy));

      try {
        return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
          const child = spawn(
            binaryPath(),
            ["run", "-p", policyFile, "--", "bash", "-c", command],
            {
              cwd,
              env: env ?? process.env,
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
            },
          );

          const parser = new TrapParser();
          child.stdout.on("data", onData);
          child.stderr.on("data", (d: Buffer) => {
            parser.feed(d);
            for (const line of parser.drainPassthrough()) onData(Buffer.from(line + "\n"));
          });

          const kill = () => {
            if (!child.pid) return;
            try {
              if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
              else child.kill();
            } catch {}
          };

          let timedOut = false;
          let timeoutHandle: NodeJS.Timeout | undefined;
          if (timeout !== undefined) {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              kill();
            }, timeout * 1000);
          }

          const onAbort = () => kill();
          if (signal) signal.addEventListener("abort", onAbort, { once: true });

          child.on("error", (err) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (signal) signal.removeEventListener("abort", onAbort);
            reject(err);
          });

          child.on("close", (code) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (signal) signal.removeEventListener("abort", onAbort);
            const { traps, passthrough } = parser.finish();
            for (const line of passthrough) onData(Buffer.from(line + "\n"));

            if (signal?.aborted) return reject(new Error("aborted"));
            if (timedOut) return reject(new Error(`timeout:${timeout}`));

            const setup = traps.find((t) => SETUP_CODES.has(t.code));
            if (setup) {
              return reject(
                new Error(
                  `Sandbox unavailable: ${setup.message ?? setup.code}\n` +
                    `The sandbox failed to start (this can happen nested inside another sandbox). ` +
                    `Retry with sandbox: false.`,
                ),
              );
            }
            const note = formatDenials(traps);
            if (code !== 0 && code !== null && note) {
              onData(Buffer.from(`\n${note}\n`));
            }
            resolve({ exitCode: code });
          });
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool factory (also used directly by tests)
// ---------------------------------------------------------------------------

export interface SandboxUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  setStatus(key: string, text: string | undefined): void;
}

export interface SandboxToolDeps {
  config?: SandboxConfig;
  ui: SandboxUI;
  ctx: { hasUI: boolean; isProjectTrusted(): boolean; cwd: string };
  sessionAllow?: Set<string>;
  persistProject?: (argv0: string) => Promise<void>;
  persistGlobal?: (argv0: string) => Promise<void>;
  /** Test seam: override where the global tier is read from. */
  homeDir?: string;
  /** Test seam: inject a fake classifier; otherwise built lazily from ctx.modelRegistry. */
  classifier?: ClassifierClient;
  /** Live session mode; Auto is activated only when this returns auto. */
  mode?: () => Mode;
  /** Session-scoped audit trail of auto-mode decisions (shared with /sandbox). */
  classifierLog?: ClassifiedRun[];
  /** Transcript seam for classifier decisions. */
  appendEntry?: (type: string, data: unknown) => void;
  /**
   * Ring the terminal bell (\a) to get luna's attention before the approval
   * dialog blocks. Optional so minimal test constructions keep compiling;
   * production always provides it. Tests that assert use a spy.
   */
  bell?(): void;
}

export function makeSandboxTool(
  fallbackCwd: string,
  deps: SandboxToolDeps,
): ToolDefinition<typeof schema, BashToolDetails | undefined, unknown> {
  const sessionAllow = deps.sessionAllow ?? new Set<string>();
  const classifierLog = deps.classifierLog ?? ([] as ClassifiedRun[]);
  const modeReader = deps.mode ?? getMode;

  function effectiveConfig(cwd: string): SandboxConfig {
    const { config } = loadConfig({
      cwd,
      trusted: deps.ctx.isProjectTrusted(),
      homeDir: deps.homeDir,
    });
    // deps.config (per-tool override) takes highest precedence, above the
    // loaded base/global/project tiers. Not passed in production; used by
    // tests to force specific gate config (e.g. auto mode on/off).
    return mergeTiers([config, deps.config]);
  }

  function rawExecute(
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3],
    ctx: ExtensionContext,
  ) {
    const t = createBashToolDefinition(ctx.cwd ?? fallbackCwd, {
      operations: createLocalBashOperations({}),
    });
    return t.execute(toolCallId, params as never, signal, onUpdate, ctx);
  }

  const tool: ToolDefinition<typeof schema, BashToolDetails | undefined, unknown> = {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command. Commands run inside an OS sandbox (Landlock + seccomp): " +
      "writes are confined to the working directory and /tmp, and the user's home directory " +
      "is unreadable except the working directory, git config, and toolchain caches (network " +
      "is unrestricted). If a command fails due to a filesystem denial you'll be told which " +
      "path was denied; retry that command with sandbox: false to request running it " +
      "unsandboxed (subject to user approval).",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: [
      "You can inspect PI_* environment variables for current model and session details.",
      "Commands run inside a filesystem sandbox; use sandbox:false only when a sandboxed run was denied.",
    ],
    parameters: schema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runCtx = ctx ?? (deps.ctx as unknown as ExtensionContext);
      const cwd = runCtx.cwd ?? fallbackCwd;
      const config = effectiveConfig(cwd);
      const sandboxEnabled = config.enabled !== false;

      if (params.sandbox !== false && sandboxEnabled) {
        const t = createBashToolDefinition(cwd, {
          operations: createSandboxedOperations(landstripPolicy(config)),
        });
        return t.execute(toolCallId, params as never, signal, onUpdate, runCtx);
      }

      if (params.sandbox !== false) {
        // sandboxing disabled in config → raw, no gate
        return rawExecute(toolCallId, params, signal, onUpdate, runCtx);
      }

      return runGatedRaw(params, signal, onUpdate, runCtx, toolCallId);
    },
  };

  /** Footer status text reflecting auto mode + session raw grants. */
  function statusText(config: SandboxConfig, rawCount: number): string {
    const am = config.autoMode;
    if (am?.enabled && modeReader() === "auto") {
      const modelShort = (am.model ?? DEFAULT_AUTO_MODEL).split("/").pop() ?? DEFAULT_AUTO_MODEL;
      return `sandbox:auto (${modelShort})` + (rawCount ? ` (${rawCount} raw)` : "");
    }
    return rawCount ? `sandbox:on (${rawCount} raw)` : "sandbox:on";
  }

  /** The verbatim approval menu (interactive fallback and legacy gate path). */
  async function adjudicateMenu(opts: {
    params: { command: string; timeout?: number };
    signal: AbortSignal | undefined;
    onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3];
    ctx: ExtensionContext;
    toolCallId: string;
    gateKey: string;
    config: SandboxConfig;
  }): Promise<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>> {
    const { params, signal, onUpdate, ctx, toolCallId, gateKey, config } = opts;
    if (!ctx.hasUI) {
      throw new Error(`Unsandboxed run of '${gateKey}' denied (no UI to prompt).`);
    }
    const options = [
      "deny",
      "allow once",
      `always allow ${gateKey} this session`,
      ...(deps.ctx.isProjectTrusted() ? [`always allow ${gateKey} for this project`] : []),
      `always allow ${gateKey} globally`,
    ];
    // The dialog below blocks mid-turn — agent_settled won't fire while it's
    // up, so the gate rings for itself (same pattern as ask/plan_submit).
    deps.bell?.();
    const choice = await ctx.ui.select(params.command, options);
    if (!choice || choice === "deny") {
      throw new Error(`Unsandboxed run of '${gateKey}' denied by user.`);
    } else if (choice === "allow once") {
      // nothing to store
    } else if (choice.includes("this session")) {
      sessionAllow.add(gateKey);
      deps.ui.setStatus("sandbox", statusText(config, sessionAllow.size));
    } else if (choice.includes("for this project")) {
      await deps.persistProject?.(gateKey);
    } else if (choice.includes("globally")) {
      await deps.persistGlobal?.(gateKey);
    }

    return rawExecute(toolCallId, params, signal, onUpdate, ctx);
  }

  /** Turn a classifier failure into the configured fallback; never runs raw. */
  async function applyAutoFallback(opts: {
    params: { command: string; timeout?: number };
    signal: AbortSignal | undefined;
    onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3];
    ctx: ExtensionContext;
    toolCallId: string;
    gateKey: string;
    config: SandboxConfig;
    reason: string;
  }): Promise<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>> {
    const { params, signal, onUpdate, ctx, toolCallId, gateKey, config, reason } = opts;
    const fallback = config.autoMode?.fallback ?? "prompt";
    if (fallback === "sandbox") {
      // Re-run confined instead of throwing; the sandbox is the real boundary.
      const t = createBashToolDefinition(ctx.cwd ?? fallbackCwd, {
        operations: createSandboxedOperations(landstripPolicy(config)),
      });
      const result = await t.execute(toolCallId, params as never, signal, onUpdate, ctx);
      result.content = [
        { type: "text", text: "Sandbox classifier unavailable; ran sandboxed instead.\n" },
        ...result.content,
      ];
      return result;
    }
    if (fallback === "deny") {
      throw new Error(
        `Unsandboxed run of '${gateKey}' denied (sandbox classifier unavailable: ${reason}).`,
      );
    }
    // "prompt" — headless can't prompt, so deny.
    if (!ctx.hasUI) {
      throw new Error(
        `Unsandboxed run of '${gateKey}' denied (no UI, sandbox classifier unavailable: ${reason}).`,
      );
    }
    return adjudicateMenu({ params, signal, onUpdate, ctx, toolCallId, gateKey, config });
  }

  /** Auto mode: one classifier call per gated request. Never persists grants. */
  async function adjudicateAuto(opts: {
    params: { command: string; timeout?: number };
    signal: AbortSignal | undefined;
    onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3];
    ctx: ExtensionContext;
    toolCallId: string;
    cwd: string;
    config: SandboxConfig;
    gateKey: string;
  }): Promise<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>> {
    const { params, signal, onUpdate, ctx, toolCallId, cwd, config, gateKey } = opts;
    const am = config.autoMode ?? {};

    let client: ClassifierClient;
    if (deps.classifier) {
      client = deps.classifier;
    } else {
      const registry = (ctx as ExtensionContext).modelRegistry;
      if (!registry) {
        return applyAutoFallback({
          params, signal, onUpdate, ctx, toolCallId, gateKey, config,
          reason: "no model registry available",
        });
      }
      client = createModelRegistryClassifier({
        modelId: am.model ?? DEFAULT_AUTO_MODEL,
        maxTokens: am.maxTokens ?? 256,
        timeoutMs: am.timeoutMs ?? 20000,
      })(registry, cwd);
    }

    const systemPrompt = resolveSystemPrompt(am.systemPromptFile, cwd, __dirname);

    let messages;
    try {
      messages = buildClassifierThread(
        (ctx as ExtensionContext).sessionManager?.buildContextEntries?.() ?? [],
        params.command,
        { maxChars: am.maxTranscriptChars ?? 64000, cwd },
      );
    } catch (err) {
      return applyAutoFallback({
        params, signal, onUpdate, ctx, toolCallId, gateKey, config,
        reason: `failed to build classifier context: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const setWorking = (text?: string) => {
      try {
        (ctx as ExtensionContext).ui?.setWorkingMessage?.(text);
      } catch {
        /* UI best-effort */
      }
    };
    setWorking("classifying…");

    let verdict;
    try {
      verdict = await client.classify(
        { systemPrompt, messages, targetCommand: params.command },
        { signal },
      );
    } catch (err) {
      return applyAutoFallback({
        params, signal, onUpdate, ctx, toolCallId, gateKey, config,
        reason: `classifier call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setWorking(undefined);
    }

    if (!verdict || typeof verdict.approved !== "boolean") {
      return applyAutoFallback({
        params, signal, onUpdate, ctx, toolCallId, gateKey, config,
        reason: "classifier returned an invalid verdict",
      });
    }

    // Audit trail (in-memory, session-scoped). Classifier decisions never
    // touch sessionAllow or persisted config — no "always allow" in auto mode.
    const decision: ClassifiedRun = {
      timestamp: Date.now(),
      command: params.command,
      verdict: verdict.approved ? "approved" : "denied",
      reason: verdict.reason,
      model: am.model ?? DEFAULT_AUTO_MODEL,
      usage: verdict.usage,
    };
    classifierLog.push(decision);
    deps.appendEntry?.("sandbox-classifier", decision);
    deps.ui.setStatus("sandbox", statusText(config, sessionAllow.size));

    if (verdict.approved) {
      const result = await rawExecute(toolCallId, params, signal, onUpdate, ctx);
      if (verdict.usage) {
        return { ...result, usage: addUsage(result.usage, verdict.usage) };
      }
      return result;
    }

    throw new Error(
      `Unsandboxed run of '${gateKey}' denied by classifier: ${verdict.reason ?? "no reason given"}`,
    );
  }

  /**
   * The single adjudication point for `sandbox:false`.
   *
   * Parser-gated: only provably-simple, non-interpreter, allowlisted commands
   * run raw silently. Compound / `cd`-wrapped / interpreter / unlisted requests
   * always reach adjudication (menu or classifier).
   */
  async function runGatedRaw(
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3],
    ctx: ExtensionContext,
    toolCallId: string,
  ) {
    const cwd = ctx.cwd ?? fallbackCwd;
    const config = effectiveConfig(cwd);
    const am = config.autoMode ?? {};
    const autoEnabled = am.enabled === true && modeReader() === "auto";
    const interpreterSet = new Set(am.interpreterPrograms ?? DEFAULT_INTERPRETER_PROGRAMS);
    const parsed = parseEscalationRequest(params.command, interpreterSet);
    // The gate key is the peeled remainder's argv0 — `cd X && git status` keys
    // on `git`, never `cd`. Bare `cd`/pure-env remainders have no argv0, so
    // they can never silent-allow; fall back to the legacy extractArgv0 for
    // menu display only.
    const gateKey = parsed.argv0 ?? extractArgv0(params.command);
    const listed =
      !!gateKey && (sessionAllow.has(gateKey) || (config.unsandboxedAllow ?? []).includes(gateKey));

    const silentRaw =
      parsed.simple &&
      !!parsed.argv0 &&
      !parsed.interpreter &&
      listed &&
      !(autoEnabled && am.bypassAllowlist === true);

    if (silentRaw) {
      return rawExecute(toolCallId, params, signal, onUpdate, ctx);
    }

    if (autoEnabled) {
      return adjudicateAuto({
        params, signal, onUpdate, ctx, toolCallId, cwd, config, gateKey,
      });
    }

    return adjudicateMenu({ params, signal, onUpdate, ctx, toolCallId, gateKey, config });
  }

  return tool;
}

const schema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  sandbox: Type.Optional(
    Type.Boolean({
      description:
        "Run inside the landstrip sandbox (default true). Set false to request unsandboxed execution (subject to user approval).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Part registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  if (process.platform === "win32") {
    console.error("[luna:sandbox] windows is not supported, sandbox part disabled");
    return;
  }

  try {
    binaryPath();
  } catch (err) {
    console.error(`[luna:sandbox] landstrip binary unavailable, part disabled: ${err}`);
    return;
  }

  const sessionAllow = new Set<string>();
  const classifierLog: ClassifiedRun[] = [];
  let ctxRef: ExtensionContext | undefined;

  const persist = (which: "project" | "global") => async (argv0: string) => {
    const path =
      which === "project"
        ? join(ctxRef?.cwd ?? process.cwd(), ".pi", "sandbox.json")
        : join(homedir(), ".pi", "agent", "luna-sandbox.json");
    await mkdir(dirname(path), { recursive: true });
    let cfg: SandboxConfig = {};
    try { cfg = JSON.parse(await readFile(path, "utf8")); } catch {}
    cfg.unsandboxedAllow = [...(cfg.unsandboxedAllow ?? []), argv0];
    await writeFile(path, JSON.stringify(cfg, null, 2) + "\n");
  };

  pi.on("session_start", async (_e, ctx) => {
    ctxRef = ctx;
    updateStatus(ctx);
  });
  pi.on("session_shutdown", async () => {
    sessionAllow.clear();
  });

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const { config } = loadConfig({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
    const am = config.autoMode;
    if (am?.enabled && getMode() === "auto") {
      const modelShort = (am.model ?? DEFAULT_AUTO_MODEL).split("/").pop() ?? DEFAULT_AUTO_MODEL;
      ctx.ui.setStatus(
        "sandbox",
        `sandbox:auto (${modelShort})` + (sessionAllow.size ? ` (${sessionAllow.size} raw)` : ""),
      );
      return;
    }
    ctx.ui.setStatus(
      "sandbox",
      sessionAllow.size ? `sandbox:on (${sessionAllow.size} raw)` : "sandbox:on",
    );
  }

  pi.registerEntryRenderer(
    "sandbox-classifier",
    (entry, _options, theme): Component => {
      const data = entry.data as ClassifiedRun;
      const color = data.verdict === "approved" ? "success" : "error";
      const result = data.verdict === "approved" ? "allowed" : "denied";
      return new Text(
        theme.fg(color, `Auto mode: ${result} unsandboxed bash — ${data.command}`) +
          (data.reason ? ` (${data.reason})` : ""),
        1,
        0,
      );
    },
  );

  pi.registerTool(
    makeSandboxTool(process.cwd(), {
      ui: { select: (t, o) => ctxRef!.ui.select(t, o), setStatus: (k, v) => ctxRef?.ui.setStatus(k, v) },
      ctx: {
        get hasUI() { return ctxRef?.hasUI ?? false; },
        isProjectTrusted: () => ctxRef?.isProjectTrusted() ?? false,
        cwd: process.cwd(),
      },
      sessionAllow,
      classifierLog,
      appendEntry: (type, data) => pi.appendEntry(type, data),
      mode: getMode,
      persistProject: persist("project"),
      persistGlobal: persist("global"),
      bell: ringBell,
    }) as never,
  );

  pi.registerCommand("sandbox", {
    description: "Show sandbox status, effective policy, and recent classifier verdicts",
    handler: async (_args, ctx) => {
      let doctor = "unavailable";
      try {
        const { stdout } = await execFileP(binaryPath(), ["doctor"]);
        doctor = stdout.trim();
      } catch (e) {
        doctor = String(e);
      }
      const { config } = loadConfig({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
      const am = config.autoMode ?? {};
      const recent = classifierLog.slice(-5).map((r) =>
        `${new Date(r.timestamp).toISOString()} ${r.verdict} ${r.command}` +
        (r.reason ? ` — ${r.reason}` : ""),
      );
      ctx.ui.notify(
        [
          `active: yes (platform ${process.platform})`,
          `binary: ${binaryPath()}`,
          `doctor: ${doctor}`,
          `auto mode: ${am.enabled ? `available (active: ${getMode() === "auto"}, model ${am.model ?? DEFAULT_AUTO_MODEL}, fallback ${am.fallback ?? "prompt"}, maxTokens ${am.maxTokens ?? 256}, timeoutMs ${am.timeoutMs ?? 20000})` : "disabled"}`,          `bypass allowlist in auto mode: ${am.bypassAllowlist === true}`,
          `session unsandboxed: ${[...sessionAllow].join(", ") || "(none)"}`,
          ...(classifierLog.length
            ? [`classifier runs (last ${Math.min(5, classifierLog.length)}):`, ...recent]
            : ["classifier runs: (none)"]),
          `policy: ${JSON.stringify(landstripPolicy(config))}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
