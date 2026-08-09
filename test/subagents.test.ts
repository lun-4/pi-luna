/**
 * subagents part: pure helpers (toolsets, spawn argv, transcripts, report
 * caching) and the plan-mode type gate. Runs anywhere (no workers spawned).
 */
import { describe, it, expect } from "vitest";
import {
  applyDelta,
  buildReportNotification,
  collectReport,
  condenseTranscript,
  finalizeStreaming,
  formatToolCall,
  lastToolCallFromMessage,
  makeFooter,
  mergeMessageUsage,
  messagesToTranscript,
  parseHandle,
  previewText,
  renderTranscript,
  sanitizeStatusText,
  spawnArgs,
  subagentPreview,
  subagentToolsFor,
  usageSuffix,
  windowTranscript,
  type SubagentRecord,
  type TranscriptMessage,
} from "../src/parts/subagents.js";
import {
  SUBAGENT_TYPES_PER_MODE,
  planModeGate,
  toolListFor,
} from "../src/parts/modes.js";

const ROOT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ask",
  "plan_submit",
  "subagent_create",
  "subagent_send",
  "subagent_get",
  "subagent_delete",
];

describe("subagentToolsFor", () => {
  it("explore is the fixed read-only set", () => {
    expect(subagentToolsFor("explore", ROOT_TOOLS)).toEqual(["read", "grep", "find", "ls"]);
  });

  it("general-purpose mirrors the root tools minus subagent/ask/plan_submit", () => {
    expect(subagentToolsFor("general-purpose", ROOT_TOOLS)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("general-purpose keeps bash (sandboxed in the worker)", () => {
    const tools = subagentToolsFor("general-purpose", ["bash", "ask"]);
    expect(tools).toEqual(["bash"]);
  });
});

describe("spawnArgs", () => {
  const base = {
    cliEntry: "/pi/dist/cli.js",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "You are a worker",
    model: "openrouter/deepseek-v4",
    thinking: "minimal",
    trusted: true,
    sessionDir: "/tmp/sess/subagents/sa-ab12cd34",
    workerExtensions: [],
  };

  it("builds the exact argv, order-sensitive", () => {
    expect(spawnArgs(base)).toEqual([
      "/pi/dist/cli.js",
      "--mode",
      "rpc",
      "--no-extensions",
      "--session-dir",
      "/tmp/sess/subagents/sa-ab12cd34",
      "--model",
      "openrouter/deepseek-v4",
      "--thinking",
      "minimal",
      "--system-prompt",
      "You are a worker",
      "--approve",
      "--tools",
      "read,grep,find,ls",
    ]);
  });

  it("interleaves --extension flags after --no-extensions", () => {
    expect(
      spawnArgs({ ...base, workerExtensions: ["/a/sandbox.ts", "/b/x.ts"] }),
    ).toEqual([
      "/pi/dist/cli.js",
      "--mode",
      "rpc",
      "--no-extensions",
      "--extension",
      "/a/sandbox.ts",
      "--extension",
      "/b/x.ts",
      "--session-dir",
      "/tmp/sess/subagents/sa-ab12cd34",
      "--model",
      "openrouter/deepseek-v4",
      "--thinking",
      "minimal",
      "--system-prompt",
      "You are a worker",
      "--approve",
      "--tools",
      "read,grep,find,ls",
    ]);
  });

  it("trusted toggles --approve/--no-approve", () => {
    const args = spawnArgs({ ...base, trusted: false });
    expect(args[args.length - 3]).toBe("--no-approve");
    expect(spawnArgs({ ...base, trusted: true })).toContain("--approve");
  });
});

describe("previewText", () => {
  it("takes the first 30 characters by default", () => {
    expect(previewText("x".repeat(50))).toBe("x".repeat(30));
    expect(previewText("short").length).toBe(5);
    expect(previewText("", 10)).toBe("");
  });
  it("counts unicode code points as single characters", () => {
    expect(Array.from(previewText("🦇🦇🦇🦇🦇🦇🦇🦇🦇🦇🦇", 30)).length).toBe(11);
    const s = "aé🦇b".repeat(10);
    expect(Array.from(previewText(s, 30)).length).toBe(30);
  });
});

describe("parseHandle", () => {
  it("accepts sa- + 8 lowercase hex and returns the bare id", () => {
    expect(parseHandle("sa-ab12cd34")).toBe("ab12cd34");
    expect(parseHandle("sa-01234567")).toBe("01234567");
  });
  it("rejects malformed handles", () => {
    expect(parseHandle("sa-Ab12cD34")).toBeUndefined(); // handles are generated lowercase
    expect(parseHandle("sa-ab12cd3")).toBeUndefined(); // 7 hex
    expect(parseHandle("sa-ab12cd345")).toBeUndefined(); // 9 hex
    expect(parseHandle("ab12cd34")).toBeUndefined(); // missing prefix
    expect(parseHandle("sa-ab12cd3g")).toBeUndefined(); // non-hex
    expect(parseHandle("")).toBeUndefined();
    expect(parseHandle("subagent-x")).toBeUndefined();
  });
});

describe("renderTranscript / condenseTranscript", () => {
  const msgs: TranscriptMessage[] = [
    { role: "user", text: "hi there" },
    { role: "assistant", text: "hello", streaming: true },
  ];

  it("labels roles user:/agent:/tool:", () => {
    expect(
      renderTranscript([
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
        { role: "toolResult", text: "c" },
      ]),
    ).toEqual(["user: a", "agent: b", "tool: c"]);
  });

  it("flattens whitespace and suffixes streaming entries with ▸", () => {
    expect(renderTranscript(msgs)).toEqual(["user: hi there", "agent: hello ▸"]);
    expect(renderTranscript([{ role: "assistant", text: "a\nb   c", streaming: false }])).toEqual([
      "agent: a b c",
    ]);
  });

  it("condenseTranscript passes through short threads", () => {
    expect(condenseTranscript(msgs, 10)).toEqual(["user: hi there", "agent: hello ▸"]);
  });

  it("condenseTranscript keeps the first/last halves around an ellipsis", () => {
    const many: TranscriptMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: "user",
      text: `m${i}`,
    }));
    const out = condenseTranscript(many, 5);
    expect(out.length).toBe(5);
    expect(out[0]).toBe("user: m0");
    expect(out[1]).toBe("user: m1");
    expect(out[2]).toBe("…");
    expect(out[3]).toBe("user: m10");
    expect(out[4]).toBe("user: m11");
  });

  it("condenseTranscript maxLines boundary: no ellipsis at exactly maxLines", () => {
    const many: TranscriptMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: "user",
      text: `m${i}`,
    }));
    const out = condenseTranscript(many, 6);
    expect(out).toHaveLength(6);
    expect(out).not.toContain("…");
  });
});

describe("applyDelta / finalizeStreaming", () => {
  it("appends delta into the last streaming assistant entry", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", text: "q" },
      { role: "assistant", text: "hel", streaming: true },
    ];
    const out = applyDelta(msgs, "lo");
    expect(out[1]).toEqual({ role: "assistant", text: "hello", streaming: true });
    expect(msgs[1].text).toBe("hel"); // input untouched (pure)
  });

  it("starts a new streaming entry when the last entry is not streaming", () => {
    const msgs: TranscriptMessage[] = [{ role: "user", text: "q" }];
    expect(applyDelta(msgs, "hi")).toEqual([
      { role: "user", text: "q" },
      { role: "assistant", text: "hi", streaming: true },
    ]);
    const final: TranscriptMessage[] = [{ role: "assistant", text: "done", streaming: false }];
    expect(applyDelta(final, "x")).toHaveLength(2);
  });

  it("finalizeStreaming clears the streaming flag", () => {
    const msgs: TranscriptMessage[] = [
      { role: "assistant", text: "done", streaming: true },
    ];
    expect(finalizeStreaming(msgs)).toEqual([
      { role: "assistant", text: "done", streaming: false },
    ]);
    expect(finalizeStreaming(msgs)).not.toBe(msgs);
  });

  it("finalizeStreaming is a no-op without a streaming assistant tail", () => {
    const msgs: TranscriptMessage[] = [{ role: "user", text: "q" }];
    expect(finalizeStreaming(msgs)).toBe(msgs);
  });
});

describe("windowTranscript", () => {
  const many = (): TranscriptMessage[] =>
    Array.from({ length: 12 }, (_, i) => ({ role: "user", text: `m${i}` }));

  it("autofollow pins the window to the newest lines", () => {
    const out = windowTranscript(many(), 5, 50, 0, true);
    expect(out.lines).toEqual([
      "user: m7",
      "user: m8",
      "user: m9",
      "user: m10",
      "user: m11",
    ]);
    expect(out.scroll).toBe(7);
  });

  it("without autofollow keeps the given scroll", () => {
    const out = windowTranscript(many(), 5, 50, 0, false);
    expect(out.lines).toEqual([
      "user: m0",
      "user: m1",
      "user: m2",
      "user: m3",
      "user: m4",
    ]);
    expect(out.scroll).toBe(0);
  });

  it("clamps scroll beyond the max", () => {
    const out = windowTranscript(many(), 5, 50, 999, false);
    expect(out.lines).toEqual([
      "user: m7",
      "user: m8",
      "user: m9",
      "user: m10",
      "user: m11",
    ]);
    expect(out.scroll).toBe(7);
  });

  it("wraps long lines and autofollows the wrapped tail", () => {
    const msgs: TranscriptMessage[] = [{ role: "user", text: "x".repeat(40) }];
    const out = windowTranscript(msgs, 2, 20, 0, true);
    expect(out.lines).toEqual(["x".repeat(20), "x".repeat(20)]); // 3 wrapped lines → last 2
    expect(out.scroll).toBe(1);
  });

  it("short threads pass through with scroll 0", () => {
    const out = windowTranscript(
      [
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
      ],
      10,
      50,
      8,
      false,
    );
    expect(out.lines).toEqual(["user: a", "agent: b"]);
    expect(out.scroll).toBe(0);
  });

  it("empty transcripts yield no lines", () => {
    expect(windowTranscript([], 5, 50, 0, true)).toEqual({ lines: [], scroll: 0 });
  });

  it("never returns more lines than rows", () => {
    const cases: Array<[number, number, number, boolean]> = [
      [12, 5, 50, true],
      [12, 5, 50, false],
      [1, 2, 20, true],
      [3, 1, 10, false],
      [0, 5, 50, true],
    ];
    for (const [n, rows, wrapWidth, autofollow] of cases) {
      const msgs: TranscriptMessage[] = Array.from({ length: n }, (_, i) => ({
        role: "user",
        text: `msg ${i} `.repeat(20), // long enough to wrap
      }));
      const out = windowTranscript(msgs, rows, wrapWidth, 999, autofollow);
      expect(out.lines.length, `n=${n} rows=${rows}`).toBeLessThanOrEqual(rows);
    }
  });
});

describe("buildReportNotification", () => {
  it("returns undefined without a final message", () => {
    expect(
      buildReportNotification({ handle: "sa-ab12cd34", type: "explore", lastMessage: null }),
    ).toBeUndefined();
    expect(
      buildReportNotification({ handle: "sa-ab12cd34", type: "explore", lastMessage: "" }),
    ).toBeUndefined();
  });

  it("tags the report with handle and type, verbatim text", () => {
    const text = buildReportNotification({
      handle: "sa-ab12cd34",
      type: "general-purpose",
      lastMessage: "# findings\n\n- first",
    });
    expect(text).toBe(
      "[subagent sa-ab12cd34 (general-purpose) report]\n\n# findings\n\n- first",
    );
  });
});

describe("sanitizeStatusText", () => {
  it("flattens newlines/tabs to single spaces, trims", () => {
    expect(sanitizeStatusText("line1\nline2")).toBe("line1 line2");
    expect(sanitizeStatusText("a\r\nb\tc")).toBe("a b c");
    expect(sanitizeStatusText("  spaced   out  ")).toBe("spaced out");
  });
});

describe("footer subagent lines", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const footerData = {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map<string, string>(),
    getAvailableProviderCount: () => 1,
  };
  const ctx = {
    sessionManager: { getCwd: () => "/home/luna", getSessionName: () => undefined, getEntries: () => [] },
    getContextUsage: () => undefined,
    model: undefined,
    thinkingLevel: undefined,
    ui: {},
  };

  function renderWith(record: Partial<SubagentRecord>) {
    const rec = {
      handle: "sa-ab12cd34",
      type: "explore",
      status: "running",
      currentText: "heading\nbody line\ncode",
      lastMessage: null,
      lastToolCall: null,
      lastTextAt: 0,
      lastToolCallAt: 0,
      usage: null,
      report: null,
      createdAt: 0,
      ...record,
    } as never;
    const registry = {
      size: 1,
      get: () => rec,
      list: () => [rec],
      subscribe: () => () => {},
    } as never;
    const factory = makeFooter(() => ctx as never, registry, () => "minimal");
    const component = factory({ requestRender() {} } as never, theme as never, footerData as never);
    return component.render(80);
  }

  it("previews streamed markdown as one line (no newlines in the cell)", () => {
    const lines = renderWith({});
    const subagentLine = lines[lines.length - 1];
    expect(subagentLine).toContain("sa-ab12cd34");
    expect(subagentLine).toContain("heading body line code");
    expect(subagentLine).not.toMatch(/\n/);
    // 2 built-in lines (no extension statuses in this stub) + exactly one subagent line
    expect(lines.length).toBe(3);
    expect(lines.filter((l) => l.includes("sa-ab12cd34"))).toHaveLength(1);
  });

  it("prefers the finalized last message over live text", () => {
    const lines = renderWith({ currentText: "working chatter", lastMessage: "The report." });
    const subagentLine = lines[lines.length - 1];
    expect(subagentLine).toContain("The report.");
    expect(subagentLine).not.toContain("working chatter");
  });

  it("falls back to the last message and stays single-line", () => {
    const lines = renderWith({ currentText: "", lastMessage: "done\nwith newlines" });
    expect(lines[lines.length - 1]).toContain("done with newlines");
    expect(lines[lines.length - 1]).not.toMatch(/\n/);
  });

  it("shows the last tool call when it is more recent than the text", () => {
    const lines = renderWith({
      currentText: "thinking out loud",
      lastMessage: "The report.",
      lastToolCall: 'tool: bash {"cmd":"npm test"}',
      lastTextAt: 1000,
      lastToolCallAt: 2000,
    });
    expect(lines[lines.length - 1]).toContain('tool: bash {"cmd":"npm test"}');
    expect(lines[lines.length - 1]).not.toContain("The report.");
  });

  it("shows the text when it is more recent than the tool call", () => {
    const lines = renderWith({
      currentText: "",
      lastMessage: "The report.",
      lastToolCall: 'tool: read {"path":"a.ts"}',
      lastTextAt: 2000,
      lastToolCallAt: 1000,
    });
    expect(lines[lines.length - 1]).toContain("The report.");
    expect(lines[lines.length - 1]).not.toContain("tool: read");
  });

  it("truncates the preview to 30 chars and appends the ↑/↓ token suffix", () => {
    const lines = renderWith({
      currentText: "",
      lastMessage: "x".repeat(80),
      usage: { input: 1234, output: 56 },
    });
    const subagentLine = lines[lines.length - 1];
    const expectedPreview = "x".repeat(30);
    expect(subagentLine).toContain(expectedPreview);
    expect(subagentLine).not.toContain("x".repeat(31));
    expect(subagentLine).toContain("(↑1.2k/↓56)");
  });

  it("omits the token suffix until usage is known", () => {
    const lines = renderWith({});
    expect(lines[lines.length - 1]).not.toMatch(/\(↑/);
  });
});

describe("formatToolCall", () => {
  it("renders name with JSON args, bare name without", () => {
    expect(formatToolCall("bash", { command: "ls" })).toBe('tool: bash {"command":"ls"}');
    expect(formatToolCall("read")).toBe("tool: read");
    expect(formatToolCall("read", {})).toBe("tool: read");
    expect(formatToolCall("edit", { path: "a.ts", old_string: "x", new_string: "y" })).toBe(
      'tool: edit {"path":"a.ts","old_string":"x","new_string":"y"}',
    );
  });
});

describe("lastToolCallFromMessage", () => {
  it("returns the last toolCall part of an assistant message", () => {
    const message = {
      content: [
        { type: "text", text: "let me check" },
        { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", name: "grep", arguments: { pattern: "foo" } },
      ],
    };
    expect(lastToolCallFromMessage(message)).toEqual({ name: "grep", arguments: { pattern: "foo" } });
  });

  it("returns undefined for malformed or tool-less messages", () => {
    expect(lastToolCallFromMessage({ content: [{ type: "text", text: "hi" }] })).toBeUndefined();
    expect(lastToolCallFromMessage({})).toBeUndefined();
    expect(lastToolCallFromMessage(undefined)).toBeUndefined();
  });
});

describe("subagentPreview / usageSuffix", () => {
  const base = {
    lastToolCall: null,
    lastToolCallAt: 0,
    lastTextAt: 0,
    lastMessage: null,
    currentText: "",
  };
  it("tie between tool call and text favors the tool call", () => {
    const rec = { ...base, lastToolCall: "tool: bash", lastToolCallAt: 5, lastTextAt: 5, lastMessage: "report" };
    expect(subagentPreview(rec)).toBe("tool: bash");
  });
  it("falls back to spawning… before any activity", () => {
    expect(subagentPreview(base)).toBe("spawning…");
  });
  it("formats the suffix with ↑/↓ and skips zero usage", () => {
    expect(usageSuffix({ input: 1234, output: 56 })).toBe(" (↑1.2k/↓56)");
    expect(usageSuffix({ input: 10000, output: 2500000 })).toBe(" (↑10k/↓2.5M)");
    expect(usageSuffix(null)).toBe("");
    expect(usageSuffix({ input: 0, output: 0 })).toBe("");
  });
});

describe("mergeMessageUsage", () => {
  it("folds assistant message usage into the running totals", () => {
    const msg = { role: "assistant", usage: { input: 100, output: 25 } };
    expect(mergeMessageUsage(null, msg)).toEqual({ input: 100, output: 25 });
    expect(mergeMessageUsage({ input: 100, output: 25 }, msg)).toEqual({ input: 200, output: 50 });
  });

  it("folds toolResult usage too (mirrors the built-in footer), skips zero", () => {
    expect(mergeMessageUsage(null, { role: "toolResult", usage: { input: 5, output: 0 } })).toEqual({
      input: 5,
      output: 0,
    });
    expect(mergeMessageUsage({ input: 5, output: 0 }, { role: "toolResult", usage: { input: 0, output: 0 } })).toEqual({
      input: 5,
      output: 0,
    });
  });

  it("ignores messages without usage and malformed usage", () => {
    expect(mergeMessageUsage({ input: 1, output: 2 }, { role: "user" })).toEqual({ input: 1, output: 2 });
    expect(mergeMessageUsage({ input: 1, output: 2 }, { role: "assistant", usage: "nope" })).toEqual({
      input: 1,
      output: 2,
    });
    expect(mergeMessageUsage(null, { role: "assistant" })).toBeNull();
  });
});

describe("collectReport", () => {
  const rec = () => ({ status: "idle" as const, lastMessage: "the report", report: null as string | null });

  it("caches the last message as the report exactly once", () => {
    const r = rec();
    expect(collectReport(r)).toEqual({ report: "the report", fresh: true });
    expect(collectReport(r)).toEqual({ report: "the report", fresh: false });
    expect(collectReport(r)).toEqual({ report: "the report", fresh: false });
  });

  it("returns the cached report even after lastMessage is updated", () => {
    const r = rec();
    collectReport(r);
    r.lastMessage = "newer text";
    expect(collectReport(r)).toEqual({ report: "the report", fresh: false });
  });

  it("stays uncached while there is no finalized last message", () => {
    const r = { status: "running" as const, lastMessage: null as string | null, report: null as string | null };
    expect(collectReport(r)).toEqual({ report: null, fresh: false });
  });
});

describe("messagesToTranscript", () => {
  it("maps pi AgentMessages to transcript lines (text parts joined)", () => {
    const out = messagesToTranscript([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "out" }] },
    ]);
    expect(out).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "line1\nline2" },
      { role: "toolResult", text: "out" },
    ]);
  });

  it("labels non-text content and survives malformed messages", () => {
    const out = messagesToTranscript([
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
      { role: "assistant", content: [{ type: "toolResult" }] },
      { role: "user", content: [{ type: "image" }] },
      "garbage",
      { role: "weird" },
      { role: "assistant", content: "not-an-array" },
    ]);
    expect(out).toEqual([
      { role: "assistant", text: "[thinking] hmm" },
      { role: "assistant", text: "[tool: bash]" },
      { role: "assistant", text: "[tool result]" },
      { role: "user", text: "[image]" },
    ]);
  });
});

describe("plan-mode integration", () => {
  it("plan mode only spawns explore subagents", () => {
    expect(SUBAGENT_TYPES_PER_MODE.plan).toEqual(["explore"]);
    expect(SUBAGENT_TYPES_PER_MODE.build).toEqual(["general-purpose", "explore"]);
  });

  it("plan toolset includes the subagent tools", () => {
    const buildTools = [
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
      "ask",
      "plan_submit",
      "subagent_create",
      "subagent_send",
      "subagent_get",
      "subagent_delete",
    ];
    expect(toolListFor("plan", buildTools)).toContain("subagent_create");
    expect(toolListFor("plan", buildTools)).toContain("subagent_delete");
    // build keeps them too (only plan_submit is stripped)
    expect(toolListFor("build", buildTools)).toContain("subagent_send");
    expect(toolListFor("build", buildTools)).not.toContain("plan_submit");
  });

  it("planModeGate lets subagent tools through in plan mode", () => {
    const state = { mode: "plan" as const, planPath: "/x/.pi/plans/s.md", handoffPending: undefined };
    for (const t of ["subagent_create", "subagent_send", "subagent_get", "subagent_delete"]) {
      expect(planModeGate(state, t, {}, "/x")).toEqual({ block: false });
    }
  });

  it("planModeGate still blocks bash and stray tools in plan mode", () => {
    const state = { mode: "plan" as const, planPath: "/x/.pi/plans/s.md", handoffPending: undefined };
    expect(planModeGate(state, "bash", { command: "ls" }, "/x").block).toBe(true);
    expect(planModeGate(state, "write", { path: "/etc/passwd" }, "/x").block).toBe(true);
  });
});