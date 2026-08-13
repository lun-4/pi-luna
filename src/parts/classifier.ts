/**
 * Auto-mode sandbox classifier.
 *
 * A secondary one-shot LLM call that reviews the verbatim `sandbox:false`
 * command against the redacted conversation thread (user + assistant text and
 * `toolCall` blocks; **zero `toolResult` messages** — tool calls but not
 * outputs) and returns a strict yes/no via a single forced, strict-schema
 * `classifier_verdict` tool call.
 *
 * The yes/no is guaranteed by construction: `toolChoice` forces the tool call
 * and `constrainedSampling` constrains the sampling to the verdict JSON
 * schema. Any response that isn't exactly that tool call is an error — the
 * gate treats every failure as "classifier unavailable" and falls back toward
 * the human (never runs raw on a botched call).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  AssistantMessage,
  Message,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Verdict tool (single forced call)
// ---------------------------------------------------------------------------

export const CLASSIFIER_TOOL_NAME = "classifier_verdict";

export const classifierVerdictToolSchema = Type.Object(
  {
    approved: Type.Boolean({
      description: "true to allow this exact unsandboxed run",
    }),
    reason: Type.String({
      description: "one-line justification for the verdict",
    }),
  },
  // Strict mode requires every property to be in `required` and forbids
  // additional properties. gpt-5.x-class models (routed via openrouter to
  // OpenAI/Azure) hard-reject a lax schema — `required` must include every
  // key in `properties` or the request 400s before the model ever runs.
  { additionalProperties: false },
);

export const classifierVerdictTool = {
  name: CLASSIFIER_TOOL_NAME,
  description:
    "Return the permission verdict for the single command shown above. Approve only if the command is clearly aligned with the user's stated task and intent. When in doubt, deny. You must call this tool exactly once.",
  parameters: classifierVerdictToolSchema,
  constrainedSampling: { type: "json_schema", strict: "require" } as const,
};

/**
 * Anthropic-compatible variant of the verdict tool. Anthropic's Messages API has
 * no JSON-schema *constrtrained sampling* — it exposes native function-calling
 * with an `input_schema`. Here the `strict: "require"` flag is dropped so
 * pi-ai's Anthropic completions path (which rejects `strict: "require"` when
 * `supportsStrictTools` is false) falls back to plain forced tool-calling with
 * its own schema coercion instead of throwing. The model (e.g. a gateway that
 * speaks `anthropic-messages`) is asked to call the tool; approval is still
 * parsed from the returned `{approved, reason}` arguments.
 */
export const classifierVerdictToolAnthropic = {
  ...classifierVerdictTool,
  constrainedSampling: undefined as undefined,
};

export const CLASSIFIER_ERROR = {
  modelNotFound: "classifier model not found in registry",
  noAuth: "classifier model has no configured auth",
  noToolUse: "classifier did not finish with a tool call",
  missingToolCall: "classifier response has no classifier_verdict tool call",
  invalidVerdict: "classifier verdict is not a strict boolean",
  timeout: "classifier request timed out",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassifierVerdict {
  approved: boolean;
  reason?: string;
  /** Usage from the classifier LLM call (merged into the tool result on approve). */
  usage?: Usage;
}

export interface ClassifierRequest {
  systemPrompt: string;
  /** The redacted parallel thread (see buildClassifierThread) including the final permission request. */
  messages: Message[];
  targetCommand: string;
}

export interface ClassifierClient {
  classify(
    req: ClassifierRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<ClassifierVerdict>;
}

export interface ModelRegistryClassifierConfig {
  modelId: string;
  maxTokens: number;
  timeoutMs: number;
  /** Optional provider-specific reasoning budget (used by reasoning models). */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Registry provider to look the model up under. Defaults to `"openrouter"`
   * (the historical default, under which cross-cloud ids like
   * `deepseek/deepseek-v4-flash-0731` are served). Set this to target a model
   * that lives under a different provider (e.g. `umans`).
   */
  provider?: string;
  /**
   * True when the target provider speaks `anthropic-messages` (e.g. `umans`),
   * which has no strict JSON-schema constrained sampling. Uses the
   * Anthropic-compatible verdict tool (no `strict: "require"`) so forced
   * tool-calling works instead of throwing.
   */
  anthropicCompatible?: boolean;
}

export interface ClassifiedRun {
  timestamp: number;
  command: string;
  verdict: "approved" | "denied";
  reason?: string;
  model?: string;
  usage?: Usage;
}

// ---------------------------------------------------------------------------
// Thread builder (redaction is the point)
// ---------------------------------------------------------------------------

export interface BuildThreadOpts {
  /** Char budget for the transcript; truncates from the head, keeping recency. The final permission request is always kept. */
  maxChars?: number;
  cwd?: string;
}

function entryTimestamp(ts: string): number {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Build the classifier's parallel thread: every session entry mapped to an
 * LLM message, with `toolResult` and `bashExecution` messages **dropped** and
 * everything else kept — including assistant `toolCall` blocks (calls wanted,
 * outputs not). Compaction / branch summaries / custom messages become user
 * messages. Ends with the verbatim target command + working directory request.
 */
export function buildClassifierThread(
  entries: SessionEntry[],
  targetCommand: string,
  opts: BuildThreadOpts = {},
): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const m = entry.message;
      switch (m.role) {
        case "toolResult":
        case "bashExecution":
          // Tool *outputs* are redacted from the classifier's view.
          continue;
        case "user":
          messages.push({
            role: "user",
            content: m.content,
            timestamp: m.timestamp,
          });
          continue;
        case "assistant":
          // Text, thinking, and toolCall blocks all stay.
          messages.push({ ...m });
          continue;
        case "custom":
          messages.push({
            role: "user",
            content: m.content,
            timestamp: m.timestamp,
          });
          continue;
        case "branchSummary":
          messages.push({
            role: "user",
            content: m.summary,
            timestamp: m.timestamp,
          });
          continue;
        case "compactionSummary":
          messages.push({
            role: "user",
            content: m.summary,
            timestamp: m.timestamp,
          });
          continue;
        default:
          continue;
      }
    }
    if (entry.type === "compaction") {
      messages.push({
        role: "user",
        content: entry.summary,
        timestamp: entryTimestamp(entry.timestamp),
      });
      continue;
    }
    if (entry.type === "branch_summary") {
      messages.push({
        role: "user",
        content: entry.summary,
        timestamp: entryTimestamp(entry.timestamp),
      });
      continue;
    }
    if (entry.type === "custom_message") {
      messages.push({
        role: "user",
        content: entry.content,
        timestamp: entryTimestamp(entry.timestamp),
      });
      continue;
    }
    // thinking_level_change / model_change / custom / label / session_info → dropped.
  }

  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text:
          "The agent requests permission to run this command outside the sandbox:\n\n" +
          "```bash\n" +
          targetCommand +
          "\n```\n\n" +
          `Working directory: ${opts.cwd ?? ""}\n\n` +
          "Approve or deny using the classifier_verdict tool.",
      },
    ],
    timestamp: Date.now(),
  });

  return truncateFromHeadKeepingLast(messages, opts.maxChars);
}

function messageText(m: Message): string {
  if (m.role === "toolResult") return "";
  const c = m.content;
  if (typeof c === "string") return c;
  return c
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return `[thinking: ${part.thinking}]`;
      if (part.type === "toolCall")
        return `[toolCall ${part.name}(${JSON.stringify(part.arguments ?? {})})]`;
      return `[image:${part.mimeType}]`;
    })
    .join("\n");
}

function truncateFromHeadKeepingLast(
  messages: Message[],
  maxChars?: number,
): Message[] {
  if (!maxChars || maxChars <= 0 || messages.length <= 1) return messages;
  const sizes = messages.map((m) => messageText(m).length);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= maxChars) return messages;
  let cut = 0;
  let running = total;
  while (cut < messages.length - 1 && running - sizes[cut] > maxChars) {
    running -= sizes[cut];
    cut++;
  }
  return messages.slice(cut);
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

export function parseVerdictToolCall(
  response: AssistantMessage,
): ClassifierVerdict {
  if (response.stopReason !== "toolUse") {
    throw new Error(
      `${CLASSIFIER_ERROR.noToolUse} (stopReason=${response.stopReason})`,
    );
  }
  const call = response.content.find(
    (
      c,
    ): c is Extract<(typeof response.content)[number], { type: "toolCall" }> =>
      c.type === "toolCall" && c.name === CLASSIFIER_TOOL_NAME,
  );
  if (!call) throw new Error(CLASSIFIER_ERROR.missingToolCall);
  const args = call.arguments ?? {};
  const approved = args["approved"];
  if (typeof approved !== "boolean")
    throw new Error(CLASSIFIER_ERROR.invalidVerdict);
  const reason = args["reason"];
  return {
    approved,
    reason:
      typeof reason === "string" && reason.length > 0 ? reason : undefined,
    usage: response.usage,
  };
}

// ---------------------------------------------------------------------------
// Real classifier client (ModelRegistry-backed)
// ---------------------------------------------------------------------------

/**
 * Build a classifier client bound to the model registry + cwd at gate time.
 * The default model id is relative to the openrouter provider ("deepseek/…").
 * Pass `cfg.provider` to look the model up under a different registry provider
 * (e.g. `umans` for an Anthropic-compatible gateway provider).
 */
export function createModelRegistryClassifier(
  cfg: ModelRegistryClassifierConfig,
) {
  return (modelRegistry: ModelRegistry, cwd: string): ClassifierClient => {
    const provider = cfg.provider ?? "openrouter";
    const client: ClassifierClient = {
      classify: async (req, opts) => {
        void cwd;
        const model = modelRegistry.find(provider, cfg.modelId);
        if (!model) throw new Error(CLASSIFIER_ERROR.modelNotFound);
        if (!modelRegistry.hasConfiguredAuth(model))
          throw new Error(
            CLASSIFIER_ERROR.noAuth + ". model selected: " + model.id,
          );

        const ac = new AbortController();
        const onParentAbort = () => ac.abort();
        opts?.signal?.addEventListener("abort", onParentAbort, { once: true });
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (cfg.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, cfg.timeoutMs);
        }
        try {
          const response = await modelRegistry.complete(
            model,
            {
              systemPrompt: req.systemPrompt,
              messages: req.messages,
              tools: [cfg.anthropicCompatible ? classifierVerdictToolAnthropic : classifierVerdictTool],
            },
            {
              maxTokens: cfg.maxTokens,
              temperature: 0,
              signal: ac.signal,
              // Never touch the main session's prompt cache; classifier context
              // is a throwaway parallel thread behind its own session id.
              cacheRetention: "none",
              sessionId: randomUUID(),
              // Forced single tool call — the yes/no is guaranteed by construction.
              toolChoice: {
                type: "function",
                function: { name: CLASSIFIER_TOOL_NAME },
              },
              ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
            },
          );
          return parseVerdictToolCall(response);
        } catch (err) {
          if (timedOut) throw new Error(CLASSIFIER_ERROR.timeout);
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onParentAbort);
        }
      },
    };
    return client;
  };
}

// ---------------------------------------------------------------------------
// System prompt resolution
// ---------------------------------------------------------------------------

const BUNDLED_PROMPT_FILE = "classifier-prompt.md";

/**
 * Resolve the classifier system prompt. Defaults to the bundled
 * `classifier-prompt.md`; overrides are read from disk (absolute paths as-is,
 * relative paths resolved against `cwd`). A missing override falls back to the
 * bundled prompt — fail-safe: never gate on an empty prompt.
 */
export function resolveSystemPrompt(
  file: string | undefined,
  cwd: string,
  baseDir: string,
): string {
  const bundled = join(baseDir, BUNDLED_PROMPT_FILE);
  let target: string | undefined;
  if (!file || file === BUNDLED_PROMPT_FILE) {
    target = bundled;
  } else if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) {
    target = file;
  } else {
    target = join(cwd, file);
  }
  try {
    if (target && existsSync(target)) return readFileSync(target, "utf8");
  } catch {
    /* fall through to bundled */
  }
  try {
    return readFileSync(bundled, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Usage / audit helpers
// ---------------------------------------------------------------------------

export function addUsage(
  a: Usage | undefined,
  b: Usage | undefined,
): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const add = (x: number | undefined, y: number | undefined) =>
    (x ?? 0) + (y ?? 0);
  return {
    input: add(a.input, b.input),
    output: add(a.output, b.output),
    cacheRead: add(a.cacheRead, b.cacheRead),
    cacheWrite: add(a.cacheWrite, b.cacheWrite),
    totalTokens: add(a.totalTokens, b.totalTokens),
    cost: {
      input: add(a.cost?.input, b.cost?.input),
      output: add(a.cost?.output, b.cost?.output),
      cacheRead: add(a.cost?.cacheRead, b.cost?.cacheRead),
      cacheWrite: add(a.cost?.cacheWrite, b.cost?.cacheWrite),
      total: add(a.cost?.total, b.cost?.total),
    },
  };
}
