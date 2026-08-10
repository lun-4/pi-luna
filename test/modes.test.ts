/**
 * modes part: pure helpers, the gate matrix, and the plan_submit decision
 * flow through a fake ModeUI seam. Runs anywhere (no TUI, no session).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tempDir } from "./temp.js";
import { dirname, isAbsolute, join } from "node:path";
import {
  PLAN_PROMPT_TEMPLATE,
  PLAN_SPEC,
  PLAN_SPEC_PATH,
  PLAN_TOOLS,
  allowPlanWrite,
  autoModeAvailable,
  modeLabel,
  nextMode,
  buildAcceptKickoff,
  decideReview,
  getMode,
  planModeGate,
  renderPlanDirective,
  resolveTarget,
  runSubmitFlow,
  subagentTypesFor,
  toolListFor,
  type ModeUI,
} from "../src/parts/modes.js";

const cwd = process.cwd();
const planPath = join(cwd, ".pi", "plans", "sess-1.md");
const planState = { mode: "plan" as const, planPath, handoffPending: undefined };
const buildState = { mode: "build" as const, planPath, handoffPending: undefined };

describe("resolveTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(resolveTarget(cwd, "foo/bar.md")).toBe(join(cwd, "foo", "bar.md"));
  });
  it("passes absolute paths through", () => {
    expect(resolveTarget(cwd, "/tmp/x.md")).toBe("/tmp/x.md");
  });
  it("expands ~ and normalizes .. escapes", () => {
    expect(resolveTarget(cwd, "../outside.md")).toBe(join(cwd, "..", "outside.md"));
    expect(resolveTarget(cwd, "~/x.md").startsWith("/")).toBe(true);
  });
  it("strips a leading @ like builtin path tools", () => {
    expect(resolveTarget(cwd, "@foo.md")).toBe(join(cwd, "foo.md"));
  });
});

describe("allowPlanWrite", () => {
  it("allows the exact plan path (absolute and relative forms)", () => {
    expect(allowPlanWrite(planPath, planPath, cwd)).toBe(true);
    expect(allowPlanWrite(".pi/plans/sess-1.md", planPath, cwd)).toBe(true);
    expect(allowPlanWrite("./.pi/plans/../plans/sess-1.md", planPath, cwd)).toBe(true);
  });
  it("rejects other files and escapes", () => {
    expect(allowPlanWrite(join(cwd, "src/index.ts"), planPath, cwd)).toBe(false);
    expect(allowPlanWrite("../.pi/plans/sess-1.md", planPath, cwd)).toBe(false);
    expect(allowPlanWrite(".pi/plans/other.md", planPath, cwd)).toBe(false);
  });
  it("rejects missing path/planPath", () => {
    expect(allowPlanWrite(undefined, planPath, cwd)).toBe(false);
    expect(allowPlanWrite(planPath, undefined, cwd)).toBe(false);
  });
});

describe("auto mode cycle", () => {
  it("configured availability requires explicit enabled true", () => {
    expect(autoModeAvailable({ autoMode: { enabled: true } })).toBe(true);
    expect(autoModeAvailable({ autoMode: { enabled: false } })).toBe(false);
    expect(autoModeAvailable({})).toBe(false);
  });
  it("cycles build → auto → plan → build when available", () => {
    expect(nextMode("build", true)).toBe("auto");
    expect(nextMode("auto", true)).toBe("plan");
    expect(nextMode("plan", true)).toBe("build");
    expect(modeLabel("auto")).toBe("mode: build (auto mode)");
  });
  it("skips auto when unavailable", () => {
    expect(nextMode("build", false)).toBe("plan");
    expect(nextMode("plan", false)).toBe("build");
  });
});

describe("toolListFor", () => {
  const buildTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  it("build returns the captured set", () => {
    expect(toolListFor("build", buildTools)).toEqual(buildTools);
  });
  it("auto has the same toolset as build", () => {
    expect(toolListFor("auto", [...buildTools, "plan_submit"])).toEqual(buildTools);
  });
  it("build strips plan_submit but keeps ask (both-modes tool)", () => {
    // pi auto-activates all extension tools at session_start, so plan_submit
    // and ask both appear in the captured build set.
    const withPlan = [...buildTools, "ask", "plan_submit"];
    expect(toolListFor("build", withPlan)).toEqual([...buildTools, "ask"]);
  });
  it("plan returns the strict plan set", () => {
    expect(toolListFor("plan", buildTools)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
      "ask",
      "plan_submit",
    ]);
  });
  it("plan drops plan-set tools the invocation excluded", () => {
    expect(toolListFor("plan", ["read", "bash", "write"])).toEqual([
      "read",
      "write",
      "ask",
      "plan_submit",
    ]);
  });
});

describe("planModeGate", () => {
  it("auto mode passes everything except plan_submit", () => {
    expect(planModeGate({ ...buildState, mode: "auto" }, "bash", {}, cwd)).toEqual({ block: false });
    expect(planModeGate({ ...buildState, mode: "auto" }, "plan_submit", {}, cwd).block).toBe(true);
  });

  it("build mode passes everything except plan_submit", () => {
    expect(planModeGate(buildState, "bash", {}, cwd)).toEqual({ block: false });
    expect(planModeGate(buildState, "write", { path: "src/x.ts" }, cwd)).toEqual({ block: false });
    expect(planModeGate(buildState, "read", {}, cwd)).toEqual({ block: false });
    expect(planModeGate(buildState, "plan_submit", { file: planPath }, cwd).block).toBe(true);
  });

  it("plan mode allows write/edit only on the plan file", () => {
    expect(planModeGate(planState, "write", { path: planPath }, cwd)).toEqual({ block: false });
    expect(planModeGate(planState, "edit", { path: ".pi/plans/sess-1.md" }, cwd)).toEqual({
      block: false,
    });
    expect(planModeGate(planState, "write", { path: "src/x.ts" }, cwd)).toMatchObject({
      block: true,
      reason: expect.stringContaining("only the plan file is writable"),
    });
    expect(planModeGate(planState, "edit", { path: "/etc/passwd" }, cwd).block).toBe(true);
  });

  it("plan mode blocks bash and anything outside the plan set", () => {
    expect(planModeGate(planState, "bash", { command: "ls" }, cwd)).toMatchObject({
      block: true,
      reason: expect.stringContaining("Not available in plan mode"),
    });
    expect(planModeGate(planState, "questionnaire", {}, cwd).block).toBe(true);
  });

  it("plan mode allows read/search/ask tools", () => {
    for (const t of ["read", "grep", "find", "ls", "ask"]) {
      expect(planModeGate(planState, t, {}, cwd)).toEqual({ block: false });
    }
  });

  it("plan_submit must target the plan file", () => {
    expect(planModeGate(planState, "plan_submit", { file: planPath }, cwd)).toEqual({
      block: false,
    });
    expect(planModeGate(planState, "plan_submit", { file: "src/x.ts" }, cwd)).toMatchObject({
      block: true,
      reason: expect.stringContaining("session plan file"),
    });
  });

  it("blocks everything while the accept handoff is pending", () => {
    const pending = { ...planState, handoffPending: planPath };
    expect(planModeGate(pending, "read", {}, cwd)).toMatchObject({
      block: true,
      reason: expect.stringContaining("new session starting"),
    });
    expect(planModeGate(pending, "write", { path: planPath }, cwd).block).toBe(true);
  });
});

describe("runSubmitFlow", () => {
  const dir = tempDir("luna-plans-");
  const file = join(dir, "plan.md");
  writeFileSync(file, "# Plan\n\n1. do the thing\n");

  const readPlan = async (p: string) => {
    try {
      return await readFile(p, "utf8");
    } catch {
      return undefined;
    }
  };
  const uiPicking = (pick?: string, feedback?: string): ModeUI => ({
    select: async (_t, o) => (pick === undefined ? undefined : o.find((x) => x.startsWith(pick))),
    input: async () => feedback,
  });

  type SubmitFlowOpts = Parameters<typeof runSubmitFlow>[0];
  const bells: string[] = [];
  const flow = (opts: Omit<SubmitFlowOpts, "bell">) =>
    runSubmitFlow({ bell: () => bells.push("bell"), ...opts });

  it("missing/empty plan → missing", async () => {
    expect(await flow({ ui: uiPicking(), planPath: join(dir, "nope.md"), readPlan })).toEqual(
      { kind: "missing" },
    );
  });

  it("accept → accept outcome with content and path", async () => {
    const out = await flow({ ui: uiPicking("Accept"), planPath: file, readPlan });
    expect(out.kind).toBe("accept");
    if (out.kind === "accept") {
      expect(out.planPath).toBe(file);
      expect(out.content).toContain("do the thing");
    }
  });

  it("talk with feedback → talk outcome", async () => {
    const out = await flow({
      ui: uiPicking("Talk", "make it darker"),
      planPath: file,
      readPlan,
    });
    expect(out).toMatchObject({ kind: "talk", feedback: "make it darker" });
  });

  it("talk with empty feedback → cancelled", async () => {
    const out = await flow({ ui: uiPicking("Talk", "   "), planPath: file, readPlan });
    expect(out.kind).toBe("cancelled");
  });

  it("escape on the select → cancelled", async () => {
    const out = await flow({ ui: uiPicking(undefined), planPath: file, readPlan });
    expect(out.kind).toBe("cancelled");
  });

  it("accept is the default-highlighted option (listed first)", async () => {
    let seen: string[] = [];
    const ui: ModeUI = {
      select: async (_t, o) => {
        seen = o;
        return undefined;
      },
      input: async () => undefined,
    };
    await flow({ ui, planPath: file, readPlan });
    expect(seen[0]).toBe("Accept & start building");
  });

  it("rings the bell once, right before the accept/talk dialog", async () => {
    const events: string[] = [];
    const ui: ModeUI = {
      select: async (_t, o) => {
        events.push("select");
        return o[0]; // Accept
      },
      input: async () => undefined,
    };
    const out = await runSubmitFlow({
      bell: () => events.push("bell"),
      ui,
      planPath: file,
      readPlan,
    });
    expect(events).toEqual(["bell", "select"]);
    expect(out.kind).toBe("accept");
  });

  it("no bell when the plan is missing (no dialog shown)", async () => {
    bells.length = 0;
    await flow({ ui: uiPicking(), planPath: join(dir, "nope.md"), readPlan });
    expect(bells).toEqual([]);
  });
});

describe("subagent modes integration", () => {
  it("PLAN_TOOLS includes the four subagent tools", () => {
    for (const t of ["subagent_create", "subagent_send", "subagent_get", "subagent_delete"]) {
      expect(PLAN_TOOLS).toContain(t);
    }
  });

  it("planModeGate passes subagent tools in plan mode, still blocks bash/writes", () => {
    for (const t of ["subagent_create", "subagent_send", "subagent_get", "subagent_delete"]) {
      expect(planModeGate(planState, t, {}, cwd)).toEqual({ block: false });
    }
    expect(planModeGate(planState, "bash", { command: "ls" }, cwd).block).toBe(true);
    expect(planModeGate(planState, "write", { path: "src/x.ts" }, cwd).block).toBe(true);
  });

  it("toolListFor includes subagent tools in both modes", () => {
    const buildTools = [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "write",
      "edit",
      "ask",
      "plan_submit",
      "subagent_create",
      "subagent_send",
      "subagent_get",
      "subagent_delete",
    ];
    const plan = toolListFor("plan", buildTools);
    for (const t of ["subagent_create", "subagent_send", "subagent_get", "subagent_delete"]) {
      expect(plan).toContain(t);
    }
    const build = toolListFor("build", buildTools);
    for (const t of ["subagent_create", "subagent_send", "subagent_get", "subagent_delete"]) {
      expect(build).toContain(t);
    }
    expect(build).not.toContain("plan_submit");
  });

  it("mode state starts build; plan mode spawns explore and plan-reviewer", () => {
    expect(getMode()).toBe("build");
    expect(subagentTypesFor("plan")).toEqual(["explore", "plan-reviewer"]);
    expect(subagentTypesFor("build")).toEqual(["general-purpose", "explore", "plan-reviewer"]);
    expect(subagentTypesFor("auto")).toEqual(subagentTypesFor("build"));
  });
});

describe("renderPlanDirective", () => {
  const template = "path={{plan_path}} spec={{plan_spec}} specPath={{plan_spec_path}}";
  const opts = {
    template,
    spec: "SPEC",
    planPath: "/x/.pi/plans/s.md",
    planSpecPath: "/x/src/parts/plan_spec_default.md",
  };

  it("replaces all three anchors", () => {
    const out = renderPlanDirective(opts);
    expect(out).toBe(
      "path=/x/.pi/plans/s.md spec=SPEC specPath=/x/src/parts/plan_spec_default.md",
    );
    expect(out).not.toContain("{{");
  });

  it("throws when the template is missing {{plan_path}}", () => {
    expect(() =>
      renderPlanDirective({ ...opts, template: template.replace("{{plan_path}}", "") }),
    ).toThrow(/\{\{plan_path\}\}/);
  });

  it("throws when the template is missing {{plan_spec}}", () => {
    expect(() =>
      renderPlanDirective({ ...opts, template: template.replace("{{plan_spec}}", "") }),
    ).toThrow(/\{\{plan_spec\}\}/);
  });

  it("throws when the template is missing {{plan_spec_path}}", () => {
    expect(() =>
      renderPlanDirective({ ...opts, template: template.replace("{{plan_spec_path}}", "") }),
    ).toThrow(/\{\{plan_spec_path\}\}/);
  });
});

describe("plan directive assets (ported from polytoken)", () => {
  const HEADINGS = [
    "## Goal",
    "## Implementation Summary",
    "## Implementation Plan",
    "## Acceptance Criteria",
    "## Test Strategy",
    "## Review Strategy",
    "## Documentation Strategy",
    "## Risks, Blockers, and Required Decisions",
  ];
  // The port must not leak machinery that doesn't exist in pi-luna.
  const LEAKS = ["write_plan", "edit_plan", "handoff_plan", "shell_exec", "polytoken://"];

  const rendered = () =>
    renderPlanDirective({
      template: PLAN_PROMPT_TEMPLATE,
      spec: PLAN_SPEC,
      planPath: "/sess/.pi/plans/s-1.md",
      planSpecPath: PLAN_SPEC_PATH,
    });

  it("the template carries exactly the three anchors and no other template syntax", () => {
    const anchors = PLAN_PROMPT_TEMPLATE.match(/\{\{[^{}]+\}\}/g) ?? [];
    expect(new Set(anchors)).toEqual(
      new Set(["{{plan_path}}", "{{plan_spec}}", "{{plan_spec_path}}"]),
    );
    // anything left after stripping the anchors must be brace-free
    expect(PLAN_PROMPT_TEMPLATE.replace(/\{\{[^{}]+\}\}/g, "")).not.toMatch(/\{\{|\{%/);
  });

  it("renders all eight spec headings and the session plan path", () => {
    const out = rendered();
    for (const h of HEADINGS) expect(out).toContain(h);
    expect(out).toContain("/sess/.pi/plans/s-1.md");
    expect(out).not.toContain("{{plan_path}}");
  });

  it("renders with no unresolved template syntax and no polytoken tool names", () => {
    const out = rendered();
    expect(out).not.toMatch(/\{\{|\{%/);
    for (const leak of LEAKS) expect(out).not.toContain(leak);
  });

  it("points the reviewer at the spec file's absolute path (PLAN_SPEC_PATH)", () => {
    expect(isAbsolute(PLAN_SPEC_PATH)).toBe(true);
    expect(rendered()).toContain(PLAN_SPEC_PATH);
  });

  it("names the pi-luna tools and the plan-reviewer type where the port needs them", () => {
    const out = rendered();
    for (const tool of ["plan_submit", "plan-reviewer", "subagent_create", "subagent_get", "subagent_delete"]) {
      expect(out).toContain(tool);
    }
  });

  it("plan_mode.md documents both assets and the plan-reviewer type", () => {
    const doc = readFileSync(join(process.cwd(), "plan_mode.md"), "utf8");
    expect(doc).toContain("plan_prompt.md");
    expect(doc).toContain("plan_spec_default.md");
    expect(doc).toContain("plan-reviewer");
  });
});

describe("decideReview", () => {
  const content = "# Plan";
  it("accept → accept outcome", () => {
    expect(decideReview(content, "/p.md", "accept")).toEqual({
      kind: "accept",
      content,
      planPath: "/p.md",
    });
  });
  it("talk with feedback → talk outcome", () => {
    expect(decideReview(content, "/p.md", "talk", "  more horns  ")).toEqual({
      kind: "talk",
      content,
      feedback: "more horns",
    });
  });
  it("talk with empty feedback → cancelled", () => {
    expect(decideReview(content, "/p.md", "talk", "   ")).toMatchObject({ kind: "cancelled" });
    expect(decideReview(content, "/p.md", "talk", undefined)).toMatchObject({ kind: "cancelled" });
  });
  it("cancelled → cancelled, content preserved for the transcript", () => {
    expect(decideReview(content, "/p.md", "cancelled")).toEqual({ kind: "cancelled", content });
  });
});

/** Stub the pi surface the modes part touches. */
function stubPi() {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const statuses: [string, string | undefined][] = [];
  const sentUserMessages: { content: string; options?: unknown }[] = [];
  const pi: any = {
    on(event: string, h: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
    registerTool(t: any) {
      tools.set(t.name, t);
    },
    registerCommand(name: string, opts: any) {
      commands.set(name, opts);
    },
    registerShortcut(name: string, opts: any) {
      shortcuts.set(name, opts);
    },
    registerEntryRenderer() {},
    appendEntry() {},
    getActiveTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls"],
    setActiveTools: () => {},
    sendUserMessage(content: string, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
  };
  pi.ui = { setStatus(key: string, text: string | undefined) { statuses.push([key, text]); } };

  const emit = async (event: string, e: unknown, ctx: unknown) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? []) last = await h(e, ctx);
    return last;
  };
  return { pi, commands, tools, shortcuts, statuses, sentUserMessages, emit };
}

describe("registered mode shortcut", () => {
  it("cycles the live footer through all enabled labels", async () => {
    const { default: modesFactory } = await import("../src/parts/modes.js");
    const statuses: string[] = [];
    const ctx: any = {
      cwd: tempDir("luna-mode-cycle-"), hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "cycle" },
      ui: {
        setStatus: (key: string, text?: string) => { if (key === "mode" && text) statuses.push(text); },
        theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
        notify() {},
      },
    };
    const fresh = stubPi();
    modesFactory(fresh.pi);
    await fresh.emit("session_start", {}, ctx);
    const shortcut = fresh.shortcuts.get("shift+tab");
    await shortcut.handler(ctx); await shortcut.handler(ctx); await shortcut.handler(ctx);
    expect(statuses).toEqual([
      "<bashMode>mode: build</bashMode>",
      "<warning>mode: build (auto mode)</warning>",
      "<accent>mode: plan</accent>",
      "<bashMode>mode: build</bashMode>",
    ]);
  });
});

describe("accept handoff (bug: accept must /new + run, not message the old session)", () => {
  const setup = () => {
    const dir = tempDir("luna-handoff-");
    const sessionId = "sess-handoff";
    const planPath = join(dir, ".pi", "plans", `${sessionId}.md`);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, "# Plan\n\n1. build the thing\n");
    const sessionCtx = {
      cwd: dir,
      hasUI: true,
      mode: "tui",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(dir, "old-session.jsonl"),
      },
      ui: { setStatus() {}, notify() {} },
    };
    return { dir, planPath, sessionCtx };
  };

  it("accept → terminate; agent_settled stages /plan-accept in the editor and injects Enter", async () => {
    const { default: modesFactory } = await import("../src/parts/modes.js");
    const { dir, planPath, sessionCtx } = setup();
    const { pi, tools, sentUserMessages, emit } = stubPi();
    modesFactory(pi);
    await emit("session_start", { reason: "startup" }, sessionCtx);

    const toolCtx = {
      ...sessionCtx,
      ui: {
        ...sessionCtx.ui,
        select: vi.fn(async () => "Accept & start building"),
        input: vi.fn(async () => ""),
      },
    };
    const result = await tools
      .get("plan_submit")!
      .execute("call-1", { file: planPath }, undefined, undefined, toolCtx);

    // The turn must terminate so the handoff runs on settle, and NOTHING may
    // be queued as a user message — the old bug queued "/plan-accept" via
    // followUp, which bypassed command dispatch and landed in the old
    // session as model input.
    expect(result.terminate).toBe(true);
    expect(sentUserMessages).toEqual([]);

    const notify = vi.fn();
    const push = vi.spyOn(process.stdin, "push").mockImplementation(() => true);
    try {
      // Stateful fake editor: setEditorText stores, getEditorText reads back.
      let editorText = "";
      const setEditorText = vi.fn((t: string) => {
        editorText = t;
      });
      const ui = {
        ...sessionCtx.ui,
        getEditorText: () => editorText,
        setEditorText,
        notify,
      };
      await emit("agent_settled", {}, { ...sessionCtx, ui });
      expect(setEditorText).toHaveBeenCalledWith(`/plan-accept ${planPath}`);
      expect(notify).not.toHaveBeenCalled();
      // The injected Enter is deferred one macrotask (past idle resolution).
      await new Promise((r) => setTimeout(r, 10));
      expect(push).toHaveBeenCalledWith("\r");
    } finally {
      push.mockRestore();
    }
  });

  it("/plan-accept → newSession, plan + 'can you build this?' as first message of the fresh session", async () => {
    const { default: modesFactory } = await import("../src/parts/modes.js");
    const { dir, planPath, sessionCtx } = setup();
    const { pi, commands, emit } = stubPi();
    modesFactory(pi);
    await emit("session_start", { reason: "startup" }, sessionCtx);

    const freshSessionMessages: string[] = [];
    const newSessionCalls: { parentSession?: string }[] = [];
    const commandCtx = {
      ...sessionCtx,
      async newSession(opts: {
        parentSession?: string;
        withSession?: (c: unknown) => Promise<void>;
      }) {
        newSessionCalls.push({ parentSession: opts.parentSession });
        await opts.withSession?.({
          async sendUserMessage(text: string) {
            freshSessionMessages.push(text);
          },
        });
        return { cancelled: false };
      },
    };
    await commands.get("plan-accept")!.handler(planPath, commandCtx);

    expect(newSessionCalls).toEqual([{ parentSession: join(dir, "old-session.jsonl") }]);
    expect(freshSessionMessages).toHaveLength(1);
    expect(freshSessionMessages[0]).toContain("1. build the thing");
    expect(freshSessionMessages[0]).toMatch(/\n\ncan you build this\?$/);
  });

  it("editor occupied at settle → no injection, notifies the manual command", async () => {
    const { default: modesFactory } = await import("../src/parts/modes.js");
    const { planPath, sessionCtx } = setup();
    const { pi, tools, emit } = stubPi();
    modesFactory(pi);
    await emit("session_start", { reason: "startup" }, sessionCtx);

    const toolCtx = {
      ...sessionCtx,
      ui: {
        ...sessionCtx.ui,
        select: vi.fn(async () => "Accept & start building"),
        input: vi.fn(async () => ""),
      },
    };
    await tools
      .get("plan_submit")!
      .execute("call-1", { file: planPath }, undefined, undefined, toolCtx);

    const setEditorText = vi.fn();
    const notify = vi.fn();
    const push = vi.spyOn(process.stdin, "push").mockImplementation(() => true);
    try {
      await emit(
        "agent_settled",
        {},
        {
          ...sessionCtx,
          ui: {
            ...sessionCtx.ui,
            // Occupied editor stays occupied: getEditorText returns a draft
            // regardless of setEditorText.
            getEditorText: () => "half-typed draft",
            setEditorText,
            notify,
          },
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(setEditorText).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(`/plan-accept ${planPath}`),
        "info",
      );
    } finally {
      push.mockRestore();
    }
  });
});

describe("plan directive injection (before_agent_start)", () => {
  it("build mode leaves the system prompt untouched; plan mode appends the rendered directive", async () => {
    const { default: modesFactory } = await import("../src/parts/modes.js");
    const { pi, commands, emit } = stubPi();
    modesFactory(pi);
    const sessionCtx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "sess-dir" },
      ui: { setStatus() {}, notify() {} },
    };
    await emit("session_start", { reason: "startup" }, sessionCtx);
    const planPath = join(cwd, ".pi", "plans", "sess-dir.md");

    // Build mode: handler returns undefined, system prompt untouched.
    expect(await emit("before_agent_start", { systemPrompt: "BASE" }, {})).toBeUndefined();

    // /plan → the rendered directive is appended.
    await commands.get("plan")!.handler("", sessionCtx as never);
    const result = await emit("before_agent_start", { systemPrompt: "BASE" }, {});
    const rendered = (result as { systemPrompt?: string } | undefined)?.systemPrompt;
    expect(rendered).toBeDefined();
    expect(rendered!.startsWith("BASE\n")).toBe(true);
    expect(rendered).toContain("You are in **Plan mode**");
    expect(rendered).toContain(planPath);
    expect(rendered).toContain("## Goal");
    expect(rendered).toContain("plan_submit");
    expect(rendered).toContain("plan-reviewer");
    expect(rendered).not.toContain("{{plan_path}}");
  });
});

describe("buildAcceptKickoff", () => {
  it("assembles first message = plan + 'can you build this?'", () => {
    expect(buildAcceptKickoff("# Plan\n\nsteps")).toBe("# Plan\n\nsteps\n\ncan you build this?");
  });
});
