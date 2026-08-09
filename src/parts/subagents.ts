/**
 * subagents part — process-backed subagents
 *
 * The primary agent spawns real, separate pi sessions: child processes
 * speaking pi's JSONL RPC protocol over stdio (RpcProcess, ported from
 * landstrip). A toolset fixed by type: `explore` = read-only researchers
 * (read/grep/find/ls), `general-purpose` = the root build toolset (bash runs
 * sandboxed via the sandbox part loaded as a worker extension; sandbox:false
 * prompts are default-cancelled inside workers). See subagent_architecture.md.
 *
 * The model interfaces through four tools:
 *   subagent_create  — spawn (cap 8, plan mode: explore only)
 *   subagent_send    — steer a running subagent or prompt an idle one
 *   subagent_get     — status + cached final report
 *   subagent_delete  — stop the process, free the slot
 *
 * All four are non-blocking: create/send return on the worker's command ack,
 * never on agent_settled — the primary polls with subagent_get. Workers never
 * get the subagent_* tools (no nesting), and their unsandboxed-run prompts
 * resolve cancelled (denied by default).
 *
 * UI: the built-in footer is replaced by a custom one replicating lines 1–3
 * (pwd/branch/session, token stats + model, extension statuses) plus one line
 * per live subagent (type handle glyph preview, newest first, live-updating).
 * /agents opens the split-pane overlay (see agents-overlay.ts).
 *
 * State is in-memory and session-scoped: workers are killed and the registry
 * cleared on session_shutdown and reset on session_start. Session files
 * persist under <agentDir>/sessions/<cwd>--/subagents/<handle>/.
 *
 * Per-type model config: the `subagents` key of
 * ~/.pi/agent/extensions/luna.json is read live at every spawn (see
 * subagent_architecture.md). A null entry inherits the primary's
 * provider/modelId + thinking; an object entry overrides model and/or
 * thinking per field — e.g. explore can run on a cheap model while the
 * primary stays on its own. Model changes need no /reload (unlike the
 * `extensions` toggles in the same file, which stay load-time).
 */

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  getPackageDir,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";

import { RpcProcess, isRecord } from "./rpc-process.ts";
import { openAgentsOverlay } from "./agents-overlay.ts";
// Values imported from modes.ts (the type-only import of SubagentType back
// there is erased — no runtime cycle).
import { getMode, subagentTypesFor } from "./modes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type SubagentType = "general-purpose" | "explore";
export type SubagentStatus = "spawning" | "running" | "idle" | "stopped" | "error";

export const SUBAGENT_TOOLS = [
  "subagent_create",
  "subagent_send",
  "subagent_get",
  "subagent_delete",
] as const;

/** Verified live: all four register in a bare --no-extensions worker. */
export const EXPLORE_TOOLS = ["read", "grep", "find", "ls"] as const;

export const MAX_SUBAGENTS = 8;

// ---------------------------------------------------------------------------
// Per-type model config — `subagents` key of ~/.pi/agent/extensions/luna.json
// ---------------------------------------------------------------------------

/** Canonical thinking-level scale, the same 7 levels as effort.ts. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Per-type override — a null field inherits that field from the primary. */
export interface SubagentModelEntry {
  model: string | null;
  thinking: ThinkingLevel | null;
}

/** The `subagents` key of luna.json. A null entry inherits both. */
export type SubagentConfig = Partial<Record<SubagentType, SubagentModelEntry | null>>;

export interface SubagentRecord {
  handle: string; // "sa-" + 8 hex chars
  type: SubagentType;
  /** Resolved worker model ("provider/modelId"): inherited from the primary
   *  or from the `subagents` config entry. */
  model: string;
  status: SubagentStatus;
  rpc: RpcProcess;
  /** Streaming text of the in-flight assistant message ("" when idle). */
  currentText: string;
  /** Finalized last assistant text (null if none). */
  lastMessage: string | null;
  /** The last lastMessage already queued back to the primary (dedupe). */
  lastNotified: string | null;
  /** Display text of the most recent tool call (formatToolCall), null if none. */
  lastToolCall: string | null;
  /** Last time assistant text streamed or was finalized (footer recency). */
  lastTextAt: number;
  /** Last time a tool call was emitted (footer recency). */
  lastToolCallAt: number;
  /** Cumulative worker tokens: folded in per message_end, overwritten with
   *  the authoritative get_session_stats totals at settle. Null before the
   *  first committed message. */
  usage: { input: number; output: number } | null;
  /** Cached final report; set once by collectReport on first subagent_get. */
  report: string | null;
  /** From get_state after spawn. */
  sessionFile?: string;
  error?: string;
  createdAt: number;
}

/** Read-only view of the registry handed to the overlay and footer. */
export interface SubagentRegistry {
  readonly size: number;
  get(handle: string): SubagentRecord | undefined;
  /** Newest first. */
  list(): SubagentRecord[];
  /** Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** One line of a transcript as rendered in the /agents overlay. */
export interface TranscriptMessage {
  role: "user" | "assistant" | "toolResult";
  text: string;
  streaming?: boolean;
}

/** System prompts passed via --system-prompt when spawning workers. */
export const TYPE_PROMPTS: Record<SubagentType, string> = {
  explore:
    "You are an **explore** subagent: a read-only researcher spawned by the primary agent. " +
    "Your only tools are read, grep, find, ls — no shell, no writes. Investigate exactly what " +
    "the primary asked, then make your FINAL message a concise markdown report: findings with " +
    "exact file references, and anything the primary must know. Your final message IS the " +
    "report; it is delivered back to the primary automatically when you settle.",
  "general-purpose":
    "You are a **general-purpose** subagent spawned by the primary agent. You share the " +
    "primary's tools (bash runs sandboxed; unsandboxed runs are denied). Complete the task " +
    "you were given; your FINAL message must contain a concise report of what you did and " +
    "found, so the primary can act on it. Your final message is delivered back to the " +
    "primary automatically when you settle.",
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Read the `subagents` key of ~/.pi/agent/extensions/luna.json (live at every
 * spawn — no caching, no /reload). Uses getAgentDir(), which respects
 * PI_CODING_AGENT_DIR, unlike index.ts's hardcoded homedir. Returns {} on a
 * missing/unparseable file; malformed entries are dropped by
 * parseSubagentConfig with a warning — a bad config never breaks spawning.
 */
export function loadSubagentConfig(): SubagentConfig {
  const path = join(getAgentDir(), "extensions", "luna.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  return parseSubagentConfig(raw);
}

/**
 * Validate the raw `subagents` JSON. Structurally malformed input (unknown
 * type keys, non-object roots/entries, wrong field types) is console.warned
 * and dropped, never thrown — a bad config must not break spawns. Field
 * *values* that are type-correct but semantically invalid (model without
 * "provider/modelId", unknown thinking level) pass through; resolveSubagentModel
 * rejects those loudly at spawn.
 */
export function parseSubagentConfig(raw: unknown): SubagentConfig {
  if (!isRecord(raw)) return {};
  if (raw.subagents === undefined) return {};
  if (!isRecord(raw.subagents)) {
    console.warn(
      `[luna] subagents config: "subagents" must be an object, got ${typeof raw.subagents} — ignoring`,
    );
    return {};
  }
  const cfg: SubagentConfig = {};
  for (const [key, value] of Object.entries(raw.subagents)) {
    if (key !== "explore" && key !== "general-purpose") {
      console.warn(
        `[luna] subagents config: unknown subagent type "${key}" (expected "explore" or "general-purpose") — ignoring`,
      );
      continue;
    }
    if (value === null || value === undefined) {
      cfg[key] = null; // explicit inherit (self-documenting default)
      continue;
    }
    if (!isRecord(value)) {
      console.warn(
        `[luna] subagents config: entry for "${key}" must be null or an object, got ${
          Array.isArray(value) ? "array" : typeof value
        } — ignoring`,
      );
      continue;
    }
    const entry: SubagentModelEntry = { model: null, thinking: null };
    let malformed = false;
    if (value.model !== undefined) {
      if (value.model === null) entry.model = null;
      else if (typeof value.model === "string") entry.model = value.model;
      else {
        console.warn(
          `[luna] subagents config: "${key}" model must be a string or null, got ${typeof value.model} — ignoring entry`,
        );
        malformed = true;
      }
    }
    if (value.thinking !== undefined) {
      if (value.thinking === null) entry.thinking = null;
      else if (typeof value.thinking === "string") {
        entry.thinking = value.thinking as ThinkingLevel; // membership validated at resolve
      } else {
        console.warn(
          `[luna] subagents config: "${key}" thinking must be a string or null, got ${typeof value.thinking} — ignoring entry`,
        );
        malformed = true;
      }
    }
    if (malformed) continue; // entry dropped → inherits
    cfg[key] = entry;
  }
  return cfg;
}

/**
 * Resolve the model + thinking a subagent of `type` spawns with.
 *
 * Entry semantics: an absent/null entry inherits both; an object entry
 * overrides per field (a null field inherits that field). A config-sourced
 * model spawns even when the primary has no active model; the model must
 * still be inherited when no config model is set, so that case throws.
 * Invalid config values (model without "provider/modelId", unknown thinking
 * level) throw with the reason and valid choices — never silently inherit.
 */
export function resolveSubagentModel(
  type: SubagentType,
  cfg: SubagentConfig,
  primary: { provider: string; id: string; thinking: string } | undefined,
): { model: string; thinking: string; source: "inherit" | "config" } {
  const entry = cfg[type] ?? null;

  if (entry && entry.model !== null) {
    const slash = entry.model.indexOf("/");
    if (slash <= 0 || slash === entry.model.length - 1) {
      throw new Error(
        `subagents config: model "${entry.model}" for ${type} has no "provider/modelId" shape — ` +
          `expected e.g. "openrouter/deepseek/deepseek-v4-flash-0731"`,
      );
    }
  }
  if (entry && entry.thinking !== null) {
    if (!THINKING_LEVELS.includes(entry.thinking)) {
      throw new Error(
        `subagents config: thinking "${entry.thinking}" for ${type} is invalid — ` +
          `valid levels: ${THINKING_LEVELS.join(", ")}`,
      );
    }
  }

  const inheritModel = entry === null || entry.model === null;
  const inheritThinking = entry === null || entry.thinking === null;
  if (inheritModel && !primary) {
    throw new Error("No model available for subagent");
  }

  const model = inheritModel ? `${primary!.provider}/${primary!.id}` : entry!.model!;
  // No primary + model from config: inherited thinking falls back to off.
  const thinking = inheritThinking ? (primary?.thinking ?? "off") : entry!.thinking!;
  const source =
    entry !== null && (entry.model !== null || entry.thinking !== null)
      ? "config"
      : "inherit";
  return { model, thinking, source };
}

/** The worker toolset for a subagent type. explore is fixed; general-purpose
 *  mirrors the root build toolset minus subagent/ask/plan_submit tools. */
export function subagentToolsFor(
  type: SubagentType,
  rootTools: string[],
): string[] {
  if (type === "explore") return [...EXPLORE_TOOLS];
  // ask is excluded because worker prompts would proxy to the parent and get
  // cancelled; plan_submit is the root's plan-file concern. bash stays.
  return rootTools.filter(
    (t) => !(SUBAGENT_TOOLS as readonly string[]).includes(t) && t !== "ask" && t !== "plan_submit",
  );
}

/** Exact worker argv (order-sensitive; verified against cli/args.js). */
export function spawnArgs(o: {
  cliEntry: string;
  tools: string[];
  systemPrompt: string;
  model: string;
  thinking: string;
  trusted: boolean;
  sessionDir: string;
  workerExtensions: string[];
}): string[] {
  return [
    o.cliEntry,
    "--mode",
    "rpc",
    "--no-extensions",
    ...o.workerExtensions.flatMap((e) => ["--extension", e]),
    "--session-dir",
    o.sessionDir,
    "--model",
    o.model,
    "--thinking",
    o.thinking,
    "--system-prompt",
    o.systemPrompt,
    o.trusted ? "--approve" : "--no-approve",
    "--tools",
    o.tools.join(","),
  ];
}

/** First n characters, unicode-safe. No ellipsis — the footer truncates. */
export function previewText(text: string, n = 30): string {
  return Array.from(text).slice(0, n).join("");
}

/** Footer display text for a tool call: `tool: <name> <json args>` when the
 *  call has arguments, bare `tool: <name>` otherwise. */
export function formatToolCall(name: string, args?: unknown): string {
  let argsText = "";
  if (typeof args === "object" && args !== null && Object.keys(args as object).length > 0) {
    argsText = ` ${JSON.stringify(args)}`;
  }
  return `tool: ${name}${argsText}`;
}

/** Last tool call (by content order) inside an assistant message, if any. */
export function lastToolCallFromMessage(message: { content?: unknown } | undefined):
  | { name: string; arguments?: unknown }
  | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i];
    if (isRecord(part) && part.type === "toolCall" && typeof part.name === "string") {
      return { name: part.name, arguments: part.arguments };
    }
  }
  return undefined;
}

/** The footer preview for a subagent: the most recent of the last tool call
 *  and the last assistant text. Ties (a message_end that carried both) favor
 *  the tool call — it is what executes next. */
export function subagentPreview(
  record: Pick<
    SubagentRecord,
    "lastToolCall" | "lastToolCallAt" | "lastTextAt" | "lastMessage" | "currentText"
  >,
): string {
  if (record.lastToolCall && record.lastToolCallAt >= record.lastTextAt) return record.lastToolCall;
  return record.lastMessage || record.currentText || "spawning…";
}

/** Token suffix appended to subagent footer lines, matching the main footer's
 *  ↑/↓ arrows and formatting: ` (↑1.2k/↓345)`. Empty until usage is known. */
export function usageSuffix(usage: { input: number; output: number } | null): string {
  if (!usage || (usage.input === 0 && usage.output === 0)) return "";
  return ` (↑${formatTokens(usage.input)}/↓${formatTokens(usage.output)})`;
}

/** Fold a committed message's usage into the rolling totals (realtime footer
 *  updates). Assistant and toolResult messages carry their own `usage`; the
 *  settle-time get_session_stats poll later overwrites with the authoritative
 *  session totals (which also include compaction entries). */
export function mergeMessageUsage(
  usage: { input: number; output: number } | null,
  message: { usage?: unknown; [key: string]: unknown } | undefined,
): { input: number; output: number } | null {
  if (!message || !isRecord(message.usage)) return usage;
  const input = typeof message.usage.input === "number" ? message.usage.input : 0;
  const output = typeof message.usage.output === "number" ? message.usage.output : 0;
  if (input === 0 && output === 0) return usage;
  const prev = usage ?? { input: 0, output: 0 };
  return { input: prev.input + input, output: prev.output + output };
}

/**
 * Validate a subagent handle. Returns the bare id (the 8-hex part) when the
 * handle matches `sa-[0-9a-f]{8}`, undefined otherwise. Callers rebuild the
 * full handle with `"sa-" + id` for registry lookups.
 */
export function parseHandle(handle: string): string | undefined {
  if (!/^sa-[0-9a-f]{8}$/.test(handle)) return undefined;
  return handle.slice(3);
}

function flattenSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Labeled one-line-per-message transcript; the overlay wraps at render time. */
export function renderTranscript(messages: TranscriptMessage[]): string[] {
  return messages.map((m) => {
    const label = m.role === "user" ? "user:" : m.role === "toolResult" ? "tool:" : "agent:";
    const text = flattenSpaces(m.text);
    const suffix = m.role === "assistant" && m.streaming ? " ▸" : "";
    return `${label} ${text}${suffix}`;
  });
}

/** Condense a transcript to at most maxLines: keep first/last halves around an
 *  ellipsis when the thread overflows. */
export function condenseTranscript(messages: TranscriptMessage[], maxLines: number): string[] {
  const lines = renderTranscript(messages);
  if (lines.length <= maxLines) return lines;
  const half = Math.floor((maxLines - 1) / 2);
  return [...lines.slice(0, half), "…", ...lines.slice(lines.length - half)];
}

export interface TranscriptWindow {
  lines: string[];
  scroll: number;
}

/** Right-pane window over a transcript: wrap each rendered line to wrapWidth,
 *  then slice `rows` lines starting at scroll. While autofollow is set the
 *  window pins to the newest lines (streaming) and the returned scroll is the
 *  max. Pure; used by the /agents overlay. */
export function windowTranscript(
  msgs: TranscriptMessage[],
  rows: number,
  wrapWidth: number,
  scroll: number,
  autofollow: boolean,
): TranscriptWindow {
  const wrapped: string[] = [];
  for (const line of renderTranscript(msgs)) {
    const w = wrapTextWithAnsi(line, Math.max(1, wrapWidth));
    wrapped.push(...(w.length ? w : [""]));
  }
  const max = Math.max(0, wrapped.length - rows);
  const pinned = autofollow ? max : Math.min(scroll, max);
  const start = Math.min(pinned, Math.max(0, wrapped.length - rows));
  return { lines: wrapped.slice(start, start + rows), scroll: pinned };
}

/** Append a streaming delta into the last streaming assistant entry (pure;
 *  returns a new array). Finalize via finalizeStreaming when the message ends. */
export function applyDelta(messages: TranscriptMessage[], delta: string): TranscriptMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    return [...messages.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...messages, { role: "assistant", text: delta, streaming: true }];
}

/** Mark the last assistant entry as finalized (message_end). Pure. */
export function finalizeStreaming(messages: TranscriptMessage[]): TranscriptMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !last.streaming) return messages;
  return [...messages.slice(0, -1), { ...last, streaming: false }];
}

/**
/**
 * The queued message queued back to the primary when a subagent settles:
 * a tagged copy of the final report. undefined when there is no report.
 * The primary gets this automatically — no polling required.
 */
export function buildReportNotification(
  record: Pick<SubagentRecord, "handle" | "type" | "lastMessage">,
): string | undefined {
  if (!record.lastMessage) return undefined;
  return `[subagent ${record.handle} (${record.type}) report]\n\n${record.lastMessage}`;
}

/** Cache the finalized last message as the report, once. `fresh` is true only
 *  on the collection that actually caches. status guards which states count —
 *  but the caller decides when to call it (idle/stopped). */
export function collectReport(
  record: Pick<SubagentRecord, "status" | "lastMessage" | "report">,
): { report: string | null; fresh: boolean } {
  if (record.report === null && record.lastMessage) {
    record.report = record.lastMessage;
    return { report: record.report, fresh: true };
  }
  return { report: record.report, fresh: false };
}

/** Map raw pi AgentMessages (from get_messages) to transcript lines. Defensive
 *  structural access — takes only the text parts of content items. */
export function messagesToTranscript(messages: unknown[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = raw.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    const content = Array.isArray(raw.content) ? raw.content : [];
    const parts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "thinking" && typeof item.thinking === "string") {
        parts.push(`[thinking] ${item.thinking}`);
      } else if (item.type === "image") {
        parts.push(`[image]`);
      } else if (item.type === "toolCall" && typeof item.name === "string") {
        parts.push(`[tool: ${item.name}]`);
      } else if (item.type === "toolResult") {
        parts.push(`[tool result]`);
      }
    }
    const text = parts.join("\n");
    if (!text) continue;
    out.push({ role, text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI entry resolution
// ---------------------------------------------------------------------------

interface PiPackage {
  cliEntry: string;
}

let piPackageResolved = false;
let cachedPiPackage: PiPackage | undefined;

/**
 * Resolve the Pi package this extension is running inside, then its cli.js
 * entry. Uses pi's own getPackageDir() (walk-up from the running module's
 * dir) — NOT import.meta.resolve/createRequire, which break under pi's jiti
 * extension loader (jiti has no native import.meta.resolve, and
 * createRequire.resolve fails on the exports-only package: no "require"
 * condition). Observed live: subagent_create failed with "Unable to determine
 * the running Pi CLI entry" until this switch.
 */
function resolvePiPackage(): PiPackage | undefined {
  if (piPackageResolved) return cachedPiPackage;
  piPackageResolved = true;
  try {
    cachedPiPackage = readPiPackage(join(getPackageDir(), "package.json"));
  } catch {
    cachedPiPackage = undefined;
  }
  return cachedPiPackage;
}

function readPiPackage(pkgPath: string): PiPackage | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!isRecord(value) || value.name !== "@earendil-works/pi-coding-agent") return undefined;
    const bin = value.bin;
    const entry =
      typeof bin === "string" ? bin : isRecord(bin) && typeof bin.pi === "string" ? bin.pi : undefined;
    return entry ? { cliEntry: join(dirname(pkgPath), entry) } : undefined;
  } catch {
    return undefined;
  }
}

let invocationCache: { command: string; args: string[] } | undefined;

/** Copy of landstrip's piInvocation(): the running CLI entry when launched
 *  directly from cli.js, else the resolved package's bin. Throws for
 *  compiled-binary pi (no cli.js on disk). */
function piInvocation(): { command: string; args: string[] } {
  if (invocationCache) return invocationCache;
  const argvEntry = process.argv[1];
  if (argvEntry && /(?:^|[/\\])cli\.(?:js|mjs|cjs|ts)$/.test(argvEntry)) {
    invocationCache = { command: process.execPath, args: [argvEntry] };
    return invocationCache;
  }
  const pkg = resolvePiPackage();
  if (!pkg) {
    throw new Error(
      "Unable to determine the running Pi CLI entry; process-backed subagents are unavailable",
    );
  }
  invocationCache = { command: process.execPath, args: [pkg.cliEntry] };
  return invocationCache;
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/** Flatten display text to a single line (newlines/tabs → spaces, collapse). */
export function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache hit rate of the most recent assistant message, when known. */
  latestCacheHitRate: number | undefined;
}

/** Same rolling totals the built-in footer computes (footer.js render()). */
function computeUsageTotals(entries: unknown[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined };
  let latestCacheHitRate: number | undefined;
  for (const entry of entries) {
    let usage: unknown;
    let isAssistant = false;
    if (isRecord(entry) && entry.type === "message" && isRecord(entry.message)) {
      const role = entry.message.role;
      if (role === "assistant") {
        usage = entry.message.usage;
        isAssistant = true;
      } else if (role === "toolResult") usage = entry.message.usage;
    } else if (
      isRecord(entry) &&
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      usage = entry.usage;
    }
    if (!isRecord(usage)) continue;
    totals.input += typeof usage.input === "number" ? usage.input : 0;
    totals.output += typeof usage.output === "number" ? usage.output : 0;
    totals.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    totals.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
    const cost = isRecord(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
    totals.cost += cost;
    if (isAssistant) {
      const promptTokens =
        (typeof usage.input === "number" ? usage.input : 0) +
        (typeof usage.cacheRead === "number" ? usage.cacheRead : 0) +
        (typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0);
      latestCacheHitRate =
        promptTokens > 0 && typeof usage.cacheRead === "number"
          ? (usage.cacheRead / promptTokens) * 100
          : undefined;
    }
  }
  return { ...totals, latestCacheHitRate };
}

const STATUS_GLYPHS: Record<SubagentStatus, string> = {
  spawning: "…",
  running: "▸",
  idle: "·",
  stopped: "■",
  error: "✗",
};

/** The custom footer: built-in lines 1–3 (replicated from footer.js) plus one
 *  live line per subagent, newest first. Exported for render-path tests. */
export function makeFooter(
  ctxRef: () => ExtensionContext | undefined,
  registry: SubagentRegistry,
  getThinking: () => string,
) {
  return (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
    const unsubscribe = registry.subscribe(() => tui.requestRender());
    return {
      render(width: number): string[] {
        const ctx = ctxRef();
        const lines: string[] = [];
        if (!ctx) {
          lines.push(theme.fg("dim", "..."));
          return lines;
        }
        const sessionManager = ctx.sessionManager;

        // -- line 1: pwd/branch/session -------------------------------------
        let pwd = sessionManager.getCwd() ?? "";
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home) {
          const resolved = pwd.replace(/\/+$/, "");
          const resolvedHome = home.replace(/\/+$/, "");
          if (resolved === resolvedHome) pwd = "~";
          else if (resolved.startsWith(resolvedHome + "/")) pwd = `~${resolved.slice(resolvedHome.length)}`;
        }
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;
        lines.push(truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")));

        // -- line 2: token stats + context % + model -------------------------
        const totals = computeUsageTotals(sessionManager.getEntries());
        const statsParts: string[] = [];
        if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
        if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
        if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
        if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
        if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.latestCacheHitRate !== undefined) {
          statsParts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
        }
        if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);
        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
        let contextPercentStr: string;
        if (contextPercent === "?") contextPercentStr = `?/${formatTokens(contextWindow)}`;
        else if (contextPercentValue > 90) {
          contextPercentStr = theme.fg("error", `${contextPercent}%/${formatTokens(contextWindow)}`);
        } else if (contextPercentValue > 70) {
          contextPercentStr = theme.fg("warning", `${contextPercent}%/${formatTokens(contextWindow)}`);
        } else contextPercentStr = `${contextPercent}%/${formatTokens(contextWindow)}`;
        statsParts.push(contextPercentStr);

        let statsLeft = statsParts.join(" ");
        if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "...");

        const model = ctx.model;
        const modelName = model?.id ?? "no-model";
        let rightSide = modelName;
        if (model?.reasoning) {
          const thinkingLevel = ctx.thinkingLevel ?? getThinking() ?? "off";
          rightSide =
            thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        if (footerData.getAvailableProviderCount() > 1 && model) {
          rightSide = `(${model.provider}) ${rightSide}`;
        }
        const minPadding = 2;
        const rightSideWidth = visibleWidth(rightSide);
        const statsLeftWidth = visibleWidth(statsLeft);
        let statsLine: string;
        if (statsLeftWidth + minPadding + rightSideWidth <= width) {
          statsLine =
            statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
        } else {
          const availableForRight = width - statsLeftWidth - minPadding;
          if (availableForRight > 0) {
            const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
            statsLine =
              statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
          } else statsLine = statsLeft;
        }
        // Dim both halves separately: statsLeft may carry color resets.
        lines.push(theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)));

        // -- line 3: extension statuses --------------------------------------
        const statuses = footerData.getExtensionStatuses();
        if (statuses.size > 0) {
          const sorted = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatusText(text))
            .join(" ");
          lines.push(truncateToWidth(sorted, width, theme.fg("dim", "...")));
        }

        // -- lines 4+: subagents, newest first --------------------------------
        for (const record of registry.list()) {
          // Most recent of the last tool call and the last assistant text
          // (currentText streams live, lastMessage once finalized). Sanitize
          // first: streamed markdown and JSON tool args contain newlines,
          // which would shatter the single-line footer cell.
          const preview = previewText(sanitizeStatusText(subagentPreview(record)));
          const text =
            `${theme.bold(record.type)} ${record.handle} ${STATUS_GLYPHS[record.status]} ${preview}` +
            usageSuffix(record.usage);
          lines.push(truncateToWidth(theme.fg("dim", text), width, theme.fg("dim", "...")));
        }
        return lines;
      },
      dispose() {
        unsubscribe();
      },
      invalidate() {
        // footer lines are recomputed on every render; nothing to cache
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Part registration
// ---------------------------------------------------------------------------

const createSchema = Type.Object({
  subagent_type: Type.Union([Type.Literal("general-purpose"), Type.Literal("explore")]),
  message: Type.String({ description: "Initial message: the task context and the report the subagent must produce" }),
});
type CreateParams = Static<typeof createSchema>;

const sendSchema = Type.Object({
  handle: Type.String({ description: "Subagent handle from subagent_create" }),
  message: Type.String({ description: "Message to deliver" }),
  interrupt: Type.Optional(
    Type.Boolean({
      description: "Abort the current turn, then deliver the message (default false)",
    }),
  ),
});
type SendParams = Static<typeof sendSchema>;

const handleSchema = Type.Object({
  handle: Type.String({ description: "Subagent handle from subagent_create" }),
});
type HandleParams = Static<typeof handleSchema>;

export default function (pi: ExtensionAPI) {
  const records = new Map<string, SubagentRecord>();
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const listener of subscribers) listener();
  };
  const registry: SubagentRegistry = {
    get size() {
      return records.size;
    },
    get: (handle) => records.get(handle),
    list: () => [...records.values()].reverse(), // newest first (Map keeps insertion order)
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };

  let ctxRef: ExtensionContext | undefined;

  function sessionDirFor(handle: string, cwd: string): string {
    const safeCwd = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
    return join(getAgentDir(), "sessions", safeCwd, "subagents", handle);
  }

  /** Kill everything and clear the registry (session boundary). */
  async function teardownWorkers() {
    for (const record of records.values()) {
      await record.rpc.stop().catch(() => {});
    }
    records.clear();
    notify();
  }

  /** Event wiring per worker. Returns the unsubscribe for rpc.onEvent. */
  function wireEvents(record: SubagentRecord) {
    return record.rpc.onEvent((event) => {
      switch (event.type) {
        case "agent_start":
          record.status = "running";
          break;
        case "message_update": {
          const ae = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
          if (ae?.type === "text_delta" && typeof ae.delta === "string") {
            record.currentText += ae.delta;
            record.lastTextAt = Date.now();
            record.status = "running";
          } else if (ae?.type === "toolcall_end") {
            // The tool call finished streaming; show it live until the
            // containing message finalizes (message_end re-sets it).
            const tc = isRecord(ae.toolCall) ? ae.toolCall : undefined;
            if (tc && typeof tc.name === "string") {
              record.lastToolCall = formatToolCall(tc.name, tc.arguments);
              record.lastToolCallAt = Date.now();
            }
          }
          break;
        }
        case "message_end": {
          const m = isRecord(event.message) ? event.message : undefined;
          if (m?.role === "assistant") {
            // Finalize only real text: currentText accumulates text_delta
            // only, so a textless (tool-call-only) assistant message must not
            // clobber the previous good message with null.
            if (record.currentText) {
              record.lastMessage = record.currentText;
              record.currentText = "";
              record.lastTextAt = Date.now();
            }
            const toolCall = lastToolCallFromMessage(m);
            if (toolCall) {
              record.lastToolCall = formatToolCall(toolCall.name, toolCall.arguments);
              record.lastToolCallAt = Date.now();
            }
          }
          // Realtime token totals: every committed message bills its own
          // usage, so fold it in per message instead of waiting for settle.
          if (m?.role === "assistant" || m?.role === "toolResult") {
            const merged = mergeMessageUsage(record.usage, m);
            if (merged !== record.usage) {
              record.usage = merged;
              notify();
            }
          }
          break;
        }
        case "agent_settled": {
          record.status = "idle";
          // Queue the subagent's final report back to the primary, once per
          // settled turn (lastNotified dedupes repeats). deliverAs "followUp":
          // queued at the primary's turn end while it streams; a full new turn
          // when the primary is idle — sendUserMessage always triggers a turn
          // when idle (prompt path), so the report is never lost to the
          // raw-follow_up queue. Errors stay human-facing (ui.notify in
          // markError); the primary can still subagent_get for status.
          if (record.lastMessage && record.lastMessage !== record.lastNotified) {
            record.lastNotified = record.lastMessage;
            const notification = buildReportNotification(record);
            if (notification) {
              // fires-and-forgets: "Always triggers a turn" (queued follow-up
              // while the primary streams).
              pi.sendUserMessage(notification, { deliverAs: "followUp" });
            }
          }
          // Authoritative token totals (per-message folds miss compaction
          // entries): roll the worker's cumulative session stats into the
          // footer suffix. Fire-and-forget: a dead/stopping worker must not
          // break settle.
          record.rpc
            .request<{ tokens?: { input?: number; output?: number } }>("get_session_stats")
            .then((stats) => {
              if (!records.has(record.handle)) return; // torn down meanwhile
              const t = stats?.tokens;
              record.usage = { input: t?.input ?? 0, output: t?.output ?? 0 };
              notify();
            })
            .catch(() => {});
          break;
        }
        default:
          return;
      }
      notify();
    });
  }

  function markError(record: SubagentRecord, message: string) {
    if (!records.has(record.handle)) return;
    record.status = "error";
    record.error = `${message} — ${record.rpc.getStderr()}`;
    notify();
    ctxRef?.ui.notify(`subagent ${record.handle} failed: ${message}`, "error");
  }

  async function spawnSubagent(
    type: SubagentType,
    message: string,
    ctx: ExtensionContext,
  ): Promise<SubagentRecord> {
    if (records.size >= MAX_SUBAGENTS) {
      throw new Error(`subagent cap reached (${MAX_SUBAGENTS}) — delete one first`);
    }
    // Per-type model config, read live at spawn (no /reload). A null entry
    // inherits the primary's provider/modelId + thinking; an object entry
    // overrides per field. A config-sourced model spawns even when the
    // primary has no active model — resolveSubagentModel only throws when the
    // model must be inherited from a missing primary.
    const cfg = loadSubagentConfig();
    const primary = ctx.model
      ? {
          provider: ctx.model.provider,
          id: ctx.model.id,
          thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
        }
      : undefined;
    // Config-sourced models are checked against the model registry up-front:
    // a typo'd/unknown id fails here with a clear message instead of a dead
    // worker (markError would only surface "rpc exited"). resolveSubagentModel
    // already rejected models without a valid "provider/modelId" shape.
    const resolved = resolveSubagentModel(type, cfg, primary);
    const entry = cfg[type];
    if (entry && entry.model !== null) {
      const slash = entry.model.indexOf("/");
      if (!ctx.modelRegistry.find(entry.model.slice(0, slash), entry.model.slice(slash + 1))) {
        throw new Error(
          `model "${entry.model}" for ${type} is not in the model registry — add it to ~/.pi/agent/models.json`,
        );
      }
    }
    const model = resolved.model;
    const thinking = resolved.thinking;
    const trusted = ctx.isProjectTrusted();

    const handle = "sa-" + randomUUID().slice(0, 8);
    const sessionDir = sessionDirFor(handle, ctx.cwd);
    mkdirSync(sessionDir, { recursive: true });

    const invocation = piInvocation();
    const tools = subagentToolsFor(type, pi.getActiveTools());
    const workerExtensions =
      type === "general-purpose" ? [join(__dirname, "sandbox.ts")] : [];
    const args = [
      ...invocation.args,
      ...spawnArgs({
        cliEntry: invocation.args[0]!,
        tools,
        systemPrompt: TYPE_PROMPTS[type],
        model,
        thinking,
        trusted,
        sessionDir,
        workerExtensions,
      }),
    ];

    const rpc = new RpcProcess({
      command: invocation.command,
      args,
      cwd: ctx.cwd,
      env: process.env,
      // Per-worker timeouts: requests are generous; a turn may legitimately
      // run for a full day (agent task loops).
      requestTimeoutMs: 120_000,
      settleTimeoutMs: 24 * 60 * 60 * 1000,
      onExit: (info) => {
        markError(record, `worker exited (${info.signal ?? `code ${info.code}`})`);
      },
    });
    const record: SubagentRecord = {
      handle,
      type,
      model,
      status: "spawning",
      rpc,
      currentText: "",
      lastMessage: null,
      lastNotified: null,
      lastToolCall: null,
      lastTextAt: 0,
      lastToolCallAt: 0,
      usage: null,
      report: null,
      createdAt: Date.now(),
    };

    rpc.onError((error) => markError(record, error.message));
    wireEvents(record);
    // extension_ui_request from workers (sandbox:false prompts etc.) is
    // default-cancelled inside RpcProcess — nothing to wire here.

    // -- spawn ---------------------------------------------------------------
    await rpc.start();
    const state = await rpc.getState();
    if (state.sessionFile) record.sessionFile = state.sessionFile;
    records.set(handle, record);
    notify();

    // First message, non-blocking: ack-only (never await settle).
    await rpc.request("prompt", { message });

    return record;
  }

  // -- lifecycle ---------------------------------------------------------------

  pi.on("session_start", async (_e, ctx) => {
    await teardownWorkers();
    ctxRef = ctx;
    if (ctx.mode === "tui" && ctx.hasUI) {
      ctx.ui.setFooter(makeFooter(() => ctxRef, registry, () => pi.getThinkingLevel()));
    }
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    await teardownWorkers();
    ctxRef = undefined;
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
  });

  // -- plan-mode gate (only subagents the mode may spawn) -----------------------

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "subagent_create") return;
    const requested = isRecord(event.input) ? event.input.subagent_type : undefined;
    if (!subagentTypesFor(getMode()).includes(requested as SubagentType)) {
      return { block: true, reason: "Plan mode only spawns explore subagents" };
    }
  });

  // -- model tools ---------------------------------------------------------------

  const toolResult = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  });

  pi.registerTool({
    name: "subagent_create",
    label: "subagent_create",
    description:
      "Spawn a process-backed subagent (a separate pi session) and give it its first task. " +
      "explore subagents are read-only researchers (read/grep/find/ls only); general-purpose " +
      "subagents share your tools (their bash is sandboxed). Returns immediately; the subagent " +
      "works asynchronously in the background. When it settles, its final report is queued " +
      "back to you automatically — you can end your turn and wait. subagent_get is for " +
      "status/last message on demand; subagent_delete frees it.",
    promptSnippet: "Delegate a scoped task to a subagent (explore = read-only research)",
    promptGuidelines: [
      "General-purpose subagents share your tools; explore subagents are read-only researchers",
      "Plan mode can only spawn explore subagents",
      "Subagents run async: after spawning (or sending), you may end your turn and wait — the subagent's final report is queued back to you as a message when it settles; do NOT poll with subagent_get",
      "subagent_get is for on-demand status or an earlier snapshot, not for waiting",
      "Delete finished subagents with subagent_delete to free slots (cap 8)",
    ],
    parameters: createSchema,
    async execute(_id, params: CreateParams, _signal, _onUpdate, ctx) {
      const record = await spawnSubagent(params.subagent_type, params.message, ctx);
      return toolResult({
        handle: record.handle,
        subagent_type: record.type,
        model: record.model,
        status: record.status,
        note: "async: its final report will be queued to you automatically when it settles; subagent_delete frees it",
      });
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "subagent_send",
    description:
      "Send a message to a live subagent: prompts it when idle, injects a steer while it is " +
      "running. Optional interrupt: abort the current turn first. Never blocks on the subagent " +
      "finishing — its reply is queued back to you automatically when the subagent settles.",
    promptSnippet: "Send a message to a subagent (steers it when running)",
    parameters: sendSchema,
    async execute(_id, params: SendParams, _signal, _onUpdate, _ctx) {
      const record = lookup(params.handle);
      if (!record) {
        return toolResult({ handle: params.handle, error: `no live subagent with handle ${params.handle}` });
      }
      if (params.interrupt) {
        try {
          await record.rpc.abort();
        } catch (error) {
          markError(record, error instanceof Error ? error.message : String(error));
          return toolResult({
            handle: params.handle,
            delivered: false,
            status: record.status,
            error: `abort failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      try {
        if (record.status === "running") {
          await record.rpc.request("steer", { message: params.message });
        } else {
          // ack-only, non-blocking (never await settle)
          await record.rpc.request("prompt", { message: params.message });
          record.status = "spawning";
          notify();
        }
      } catch (error) {
        markError(record, error instanceof Error ? error.message : String(error));
        return toolResult({
          handle: params.handle,
          delivered: false,
          status: record.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return toolResult({ handle: params.handle, delivered: true, status: record.status });
    },
  });

  pi.registerTool({
    name: "subagent_get",
    label: "subagent_get",
    description:
      "Check a subagent's status and collect its final report. The report is the subagent's " +
      "final message, cached on first collection for a finished subagent; while it is running " +
      "returns whatever has settled so far plus the streaming last message.",
    promptSnippet: "Fetch a subagent's status and cached final report",
    parameters: handleSchema,
    async execute(_id, params: HandleParams, _signal, _onUpdate, _ctx) {
      const record = lookup(params.handle);
      if (!record) {
        return toolResult({ handle: params.handle, error: `no live subagent with handle ${params.handle}` });
      }
      if (record.status === "idle" || record.status === "stopped") {
        collectReport(record);
      }
      return toolResult({
        handle: record.handle,
        subagent_type: record.type,
        status: record.status,
        report: record.report,
        last_message: record.lastMessage,
        error: record.error,
      });
    },
  });

  pi.registerTool({
    name: "subagent_delete",
    label: "subagent_delete",
    description:
      "Stop a subagent: aborts any turn, terminates the worker process, and frees the slot. " +
      "Its session files stay on disk. Deleting a running subagent loses in-flight work — " +
      "collect the report first when it matters.",
    promptSnippet: "Stop and remove a subagent (frees the slot)",
    parameters: handleSchema,
    async execute(_id, params: HandleParams, _signal, _onUpdate, _ctx) {
      const record = lookup(params.handle);
      if (!record) {
        return toolResult({ handle: params.handle, deleted: false, error: `no live subagent with handle ${params.handle}` });
      }
      records.delete(record.handle);
      notify();
      await record.rpc.stop().catch(() => {});
      return toolResult({ deleted: true, handle: record.handle });
    },
  });

  function lookup(handle: string): SubagentRecord | undefined {
    const id = parseHandle(handle);
    return id ? records.get("sa-" + id) : undefined;
  }

  // -- /agents command -----------------------------------------------------------

  pi.registerCommand("agents", {
    description: "Inspect subagents: list, condensed threads, focus a subagent to interact",
    handler: (args: string, ctx: ExtensionCommandContext) => openAgentsOverlay(ctx, registry),
  });
}