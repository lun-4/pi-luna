/**
 * Unit tests for the auto-mode classifier: thread building (redaction),
 * verdict parsing, the ModelRegistry-backed client (options/schema/timeout),
 * and usage merging. All offline — no network, no API keys.
 */
import { describe, it, expect, vi } from "vitest";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildClassifierThread,
  parseVerdictToolCall,
  createModelRegistryClassifier,
  addUsage,
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_ERROR,
  classifierVerdictTool,
  classifierVerdictToolSchema,
} from "../src/parts/classifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseAssistant(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "I'll check the repo." }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test-model",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: 1000,
    ...over,
  };
}

function zeroUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function entry(type: string, message: unknown, extra: Record<string, unknown> = {}): SessionEntry {
  return {
    type,
    id: `e-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp: new Date(1000).toISOString(),
    ...(type === "message" ? { message } : {}),
    ...extra,
  } as unknown as SessionEntry;
}

function userMsg(text: string): Message["content"] {
  return [{ type: "text", text }];
}

// ---------------------------------------------------------------------------
// buildClassifierThread — redaction is the point
// ---------------------------------------------------------------------------

describe("buildClassifierThread", () => {
  it("keeps user + assistant (with toolCall blocks), drops every toolResult", () => {
    const entries = [
      entry("message", { role: "user", content: userMsg("push the branch"), timestamp: 1 }),
      entry("message", baseAssistant({
        content: [
          { type: "text", text: "Running git status first." },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "git status" } },
        ],
        stopReason: "toolUse",
      })),
      entry("message", {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: userMsg("On branch main"),
        isError: false,
        timestamp: 3,
      }),
      entry("message", { role: "user", content: userMsg("ok, push it"), timestamp: 4 }),
    ];
    const msgs = buildClassifierThread(entries, "git push", { cwd: "/proj" });
    const roles = msgs.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "user"]);
    expect(roles).not.toContain("toolResult");

    const assistant = msgs[1];
    expect(assistant.role).toBe("assistant");
    const toolCalls = (assistant as AssistantMessage).content.filter((c) => c.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("bash");
  });

  it("drops bashExecution (the ! command path) as tool output", () => {
    const entries = [
      entry("message", { role: "bashExecution", command: "ls -la", output: "secret listing", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 }),
      entry("message", { role: "user", content: userMsg("now what"), timestamp: 6 }),
    ];
    const msgs = buildClassifierThread(entries, "cat x", {});
    expect(msgs.map((m) => m.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(msgs)).not.toContain("secret listing");
  });

  it("maps compaction, branch_summary, custom_message entries to user messages", () => {
    const entries = [
      entry("compaction", undefined, { summary: "compacted summary text", firstKeptEntryId: "x", tokensBefore: 99 }),
      entry("branch_summary", undefined, { fromId: "b1", summary: "branch summary text" }),
      entry("custom_message", undefined, { customType: "luna", content: userMsg("custom injected text"), display: false }),
    ];
    const msgs = buildClassifierThread(entries, "git status", {});
    const text = msgs.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))).join("\n");
    expect(text).toContain("compacted summary text");
    expect(text).toContain("branch summary text");
    expect(text).toContain("custom injected text");
  });

  it("drops thinking_level_change / model_change / custom / label / session_info entries", () => {
    const entries = [
      entry("message", { role: "thinking_level_change", thinkingLevel: "high", timestamp: 1 } as never, { thinkingLevel: "high" }),
      entry("message", { role: "model_change", provider: "openrouter", modelId: "x", timestamp: 2 } as never, { provider: "openrouter", modelId: "x" }),
      entry("custom", undefined, { customType: "luna-state", data: { anything: true } }),
      entry("label", undefined, { targetId: "x", label: "bookmark" }),
      entry("session_info", undefined, { name: "mysession" }),
    ];
    const msgs = buildClassifierThread(entries, "echo hi", {});
    // Only the appended permission request remains.
    expect(msgs).toHaveLength(1);
  });

  it("appends the verbatim command and working directory as the final user message", () => {
    const msgs = buildClassifierThread([], "git push && cat ~/.ssh/id_rsa", { cwd: "/home/luna/repo" });
    expect(msgs).toHaveLength(1);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    const text = typeof last.content === "string" ? last.content : last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("git push && cat ~/.ssh/id_rsa");
    expect(text).toContain("Working directory: /home/luna/repo");
    expect(text).toContain("classifier_verdict");
  });

  it("truncates from the head, keeping recency and always keeping the final request", () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      entry("message", { role: "user", content: userMsg(`message number ${i} `.repeat(20)), timestamp: i }),
    );
    const msgs = buildClassifierThread(entries, "git status", { cwd: "/x", maxChars: 2000 });
    // Truncated below 50, but the tail + final request survive.
    expect(msgs.length).toBeLessThan(50);
    expect(msgs.length).toBeGreaterThan(1);
    const last = msgs[msgs.length - 1];
    const lastText = typeof last.content === "string" ? last.content : last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(lastText).toContain("git status");
    // The surviving transcript mentions the most recent (tail) message.
    const joined = msgs.map((m) => JSON.stringify(m)).join("");
    expect(joined).toContain("message number 49");
  });
});

// ---------------------------------------------------------------------------
// parseVerdictToolCall
// ---------------------------------------------------------------------------

describe("parseVerdictToolCall", () => {
  it("returns the verdict + reason + usage for a valid tool call", () => {
    const v = parseVerdictToolCall(verdictResponse({ approved: false, reason: "smuggles a chain" }));
    expect(v.approved).toBe(false);
    expect(v.reason).toBe("smuggles a chain");
  });

  it("attaches usage from the response", () => {
    const usage = { ...zeroUsage(), input: 7, output: 2, totalTokens: 9 };
    const response = verdictResponse({ approved: true });
    const withUsage: AssistantMessage = { ...response, usage };
    const v = parseVerdictToolCall(withUsage);
    expect(v.approved).toBe(true);
    expect(v.usage).toEqual(usage);
  });

  it("throws when stopReason is not toolUse", () => {
    const response = baseAssistant({ content: [{ type: "text", text: "sure" }], stopReason: "stop" });
    expect(() => parseVerdictToolCall(response)).toThrow(CLASSIFIER_ERROR.noToolUse);
  });

  it("throws when the tool call is missing", () => {
    const response = baseAssistant({
      content: [{ type: "toolCall", id: "tc", name: "other_tool", arguments: {} }],
      stopReason: "toolUse",
    });
    expect(() => parseVerdictToolCall(response)).toThrow(CLASSIFIER_ERROR.missingToolCall);
  });

  it("rejects a non-boolean approved (strict)", () => {
    expect(() => parseVerdictToolCall(verdictResponse({ approved: "yes" }))).toThrow(CLASSIFIER_ERROR.invalidVerdict);
    expect(() => parseVerdictToolCall(verdictResponse({ approved: 1 }))).toThrow(CLASSIFIER_ERROR.invalidVerdict);
    expect(() => parseVerdictToolCall(verdictResponse({}))).toThrow(CLASSIFIER_ERROR.invalidVerdict);
  });
});

// ---------------------------------------------------------------------------
// createModelRegistryClassifier — the real client, offline via a mock registry
// ---------------------------------------------------------------------------

interface CapturedCall {
  model: unknown;
  context: unknown;
  options: Record<string, unknown>;
}

const noModel = Symbol("no-model");

function mockRegistry(over: {
  model?: unknown;
  configuredAuth?: boolean;
  complete?: (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<AssistantMessage>;
}) {
  const calls: CapturedCall[] = [];
  const registry = {
    calls,
    find: vi.fn(() => over.model === noModel ? undefined : (over.model ?? { id: "deepseek/deepseek-v4-flash-0731", api: "openai-completions" })),
    hasConfiguredAuth: vi.fn(() => over.configuredAuth ?? true),
    complete: vi.fn(async (model: unknown, context: unknown, options: Record<string, unknown>) => {
      calls.push({ model, context, options });
      if (over.complete) return over.complete(model, context, options);
      return verdictResponse({ approved: true, reason: "test" });
    }),
  };
  return registry;
}

function verdictResponse(args: Record<string, unknown>): AssistantMessage {
  return baseAssistant({
    content: [{ type: "toolCall", id: "tc", name: CLASSIFIER_TOOL_NAME, arguments: args }],
    stopReason: "toolUse",
  });
}

const clientCfg = { modelId: "deepseek/deepseek-v4-flash-0731", maxTokens: 128, timeoutMs: 1000 };

describe("createModelRegistryClassifier", () => {
  it("issues a single strict-schema tool with forced toolChoice and exact options (AC.6)", async () => {
    const reg = mockRegistry({});
    const client = createModelRegistryClassifier(clientCfg)(reg as never, "/proj");
    const req = {
      systemPrompt: "be a judge",
      messages: [{ role: "user" as const, content: "run git push", timestamp: 1 }],
      targetCommand: "git push",
    };
    const verdict = await client.classify(req, { signal: undefined });

    expect(verdict.approved).toBe(true);
    expect(reg.calls).toHaveLength(1);
    const { model, context, options } = reg.calls[0];
    expect(model).toMatchObject({ id: "deepseek/deepseek-v4-flash-0731" });
    expect((context as { systemPrompt: string }).systemPrompt).toBe("be a judge");
    expect(context).toMatchObject({ messages: req.messages });

    // The single tool: strict json_schema constrained sampling.
    const tools = (context as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(1);
    const tool = tools[0] as typeof classifierVerdictTool;
    expect(tool.name).toBe(CLASSIFIER_TOOL_NAME);
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "require" });
    expect(tool.parameters).toBe(classifierVerdictToolSchema);

    expect(options.maxTokens).toBe(128);
    expect(options.temperature).toBe(0);
    expect(options.cacheRetention).toBe("none");
    expect(typeof options.sessionId).toBe("string");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.toolChoice).toEqual({ type: "function", function: { name: CLASSIFIER_TOOL_NAME } });
  });

  it("model not found → throws", async () => {
    const reg = mockRegistry({ model: noModel });
    const client = createModelRegistryClassifier(clientCfg)(reg as never, "/proj");
    await expect(
      client.classify({ systemPrompt: "x", messages: [], targetCommand: "x" }, {}),
    ).rejects.toThrow(CLASSIFIER_ERROR.modelNotFound);
  });

  it("no configured auth → throws", async () => {
    const reg = mockRegistry({ configuredAuth: false });
    const client = createModelRegistryClassifier(clientCfg)(reg as never, "/proj");
    await expect(
      client.classify({ systemPrompt: "x", messages: [], targetCommand: "x" }, {}),
    ).rejects.toThrow(CLASSIFIER_ERROR.noAuth);
  });

  it("complete() throwing → propagates (gate treats it as classifier unavailable)", async () => {
    const reg = mockRegistry({ complete: async () => { throw new Error("provider explosion"); } });
    const client = createModelRegistryClassifier(clientCfg)(reg as never, "/proj");
    await expect(
      client.classify({ systemPrompt: "x", messages: [], targetCommand: "x" }, {}),
    ).rejects.toThrow("provider explosion");
  });

  it("non-toolUse response → throws", async () => {
    const reg = mockRegistry({
      complete: async () => baseAssistant({ content: [{ type: "text", text: "no" }], stopReason: "stop" }),
    });
    const client = createModelRegistryClassifier(clientCfg)(reg as never, "/proj");
    await expect(
      client.classify({ systemPrompt: "x", messages: [], targetCommand: "x" }, {}),
    ).rejects.toThrow(CLASSIFIER_ERROR.noToolUse);
  });

  it("invalid verdict args → throws", async () => {
    const reg = mockRegistry({
      complete: async () => verdictResponse({ approved: "maybe" }),
    });
    const client = createModelRegistryClassifier(clientCfg)(reg as never, "/proj");
    await expect(
      client.classify({ systemPrompt: "x", messages: [], targetCommand: "x" }, {}),
    ).rejects.toThrow(CLASSIFIER_ERROR.invalidVerdict);
  });

  it("honors timeoutMs by aborting an in-flight request", async () => {
    const reg = mockRegistry({
      complete: async (_m, _c, options: { signal?: AbortSignal }) =>
        new Promise<AssistantMessage>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const client = createModelRegistryClassifier({ ...clientCfg, timeoutMs: 20 })(reg as never, "/proj");
    await expect(
      client.classify({ systemPrompt: "x", messages: [], targetCommand: "x" }, {}),
    ).rejects.toThrow(CLASSIFIER_ERROR.timeout);
  });

  it("propagates the caller's abort signal", async () => {
    const reg = mockRegistry({
      complete: async (_m, _c, options: { signal?: AbortSignal }) =>
        new Promise<AssistantMessage>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const client = createModelRegistryClassifier(clientCfg)(reg as never, "/proj");
    const ac = new AbortController();
    const pending = client.classify({ systemPrompt: "x", messages: [], targetCommand: "x" }, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

// ---------------------------------------------------------------------------
// addUsage
// ---------------------------------------------------------------------------

describe("addUsage", () => {
  it("merges two usages (sums tokens and cost fields)", () => {
    const a: Usage = { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 16, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, total: 3.1 } };
    const b: Usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 4, totalTokens: 9, cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0.4, total: 1.9 } };
    const m = addUsage(a, b)!;
    expect(m.input).toBe(12);
    expect(m.output).toBe(8);
    expect(m.totalTokens).toBe(25);
    expect(m.cost.total).toBeCloseTo(5);
  });
  it("returns the other when one is undefined", () => {
    expect(addUsage(undefined, undefined)).toBeUndefined();
    const u = zeroUsage();
    expect(addUsage(u, undefined)).toBe(u);
    expect(addUsage(undefined, u)).toBe(u);
  });
});