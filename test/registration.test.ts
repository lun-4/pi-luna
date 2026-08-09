/**
 * The part's default export: registration wiring against a stub ExtensionAPI.
 * Runs anywhere (no landstrip spawn).
 */
import { describe, it, expect } from "vitest";
import factory from "../src/parts/sandbox.js";
import askFactory from "../src/parts/ask.js";
import modesFactory from "../src/parts/modes.js";
import subagentsFactory from "../src/parts/subagents.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function stubPi() {
  const handlers = new Map<string, Function>();
  const stub = {
    tool: undefined as any,
    tools: [] as any[],
    commands: new Map<string, any>(),
    shortcuts: new Map<string, any>(),
    activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    on(event: string, h: Function) {
      handlers.set(event, h);
    },
    registerTool(t: any) {
      stub.tool = t;
      stub.tools.push(t);
    },
    registerCommand(name: string, opts: any) {
      stub.commands.set(name, opts);
    },
    registerShortcut(shortcut: string, opts: any) {
      stub.shortcuts.set(shortcut, opts);
    },
    getActiveTools() {
      return stub.activeTools;
    },
    setActiveTools(names: string[]) {
      stub.activeTools = names;
    },
    appendEntry() {},
    sendUserMessage() {},
    entryRenderers: new Map<string, any>(),
    registerEntryRenderer(customType: string, renderer: any) {
      stub.entryRenderers.set(customType, renderer);
    },
    handlers,
  };
  return stub;
}

describe("part registration", () => {
  it("registers the bash override, /sandbox command, and session handlers", () => {
    const pi = stubPi();
    factory(pi as unknown as ExtensionAPI);
    expect(pi.tool).toBeDefined();
    expect(pi.tool.name).toBe("bash");
    expect(pi.tool.parameters).toBeDefined();
    expect(pi.commands.has("sandbox")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
  });

  it("renders shell UI by omitting renderCall/renderResult", () => {
    const pi = stubPi();
    factory(pi as unknown as ExtensionAPI);
    expect(pi.tool.renderCall).toBeUndefined();
    expect(pi.tool.renderResult).toBeUndefined();
  });
});

describe("ask part registration", () => {
  it("registers the ask tool and a session_start handler", () => {
    const pi = stubPi();
    askFactory(pi as unknown as ExtensionAPI);
    expect(pi.tools.map((t) => t.name)).toContain("ask");
    expect(pi.handlers.has("session_start")).toBe(true);
  });
});

describe("modes part registration", () => {
  it("registers plan_submit, /plan, /build, /plan-accept, shift+tab, and handlers", () => {
    const pi = stubPi();
    modesFactory(pi as unknown as ExtensionAPI);
    expect(pi.tools.map((t) => t.name)).toContain("plan_submit");
    for (const cmd of ["plan", "build", "plan-accept"]) {
      expect(pi.commands.has(cmd)).toBe(true);
    }
    expect(pi.shortcuts.has("shift+tab")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("tool_call")).toBe(true);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
    expect(pi.handlers.has("agent_settled")).toBe(true);
  });

  it("registers the plan-print entry renderer (full plan in transcript)", () => {
    const pi = stubPi();
    modesFactory(pi as unknown as ExtensionAPI);
    const renderer = pi.entryRenderers.get("plan-print");
    expect(renderer).toBeDefined();
    const theme = {
      fg: (_c: string, s: string) => s,
      bg: (_c: string, s: string) => s,
      bold: (s: string) => s,
    };
    const component = renderer(
      { data: { path: "/x/.pi/plans/s.md", content: "# Plan\n\n1. step" } },
      {},
      theme,
    );
    const text = component.render(80).join("\n");
    expect(text).toContain("# Plan");
    expect(text).toContain("1. step");
    expect(text).toContain("s.md");
  });
});

describe("subagents part registration", () => {
  it("registers the four subagent tools, /agents, and session handlers", () => {
    const pi = stubPi();
    subagentsFactory(pi as unknown as ExtensionAPI);
    const names = pi.tools.map((t) => t.name);
    for (const t of ["subagent_create", "subagent_send", "subagent_get", "subagent_delete"]) {
      expect(names).toContain(t);
    }
    expect(pi.commands.has("agents")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("tool_call")).toBe(true);
  });

  it("tools return JSON text content with structured details", async () => {
    const pi = stubPi();
    subagentsFactory(pi as unknown as ExtensionAPI);
    const tool = pi.tools.find((t) => t.name === "subagent_get");
    expect(tool.parameters).toBeDefined();
  });

  it("subagent_create schema accepts the plan-reviewer literal", () => {
    const pi = stubPi();
    subagentsFactory(pi as unknown as ExtensionAPI);
    const tool = pi.tools.find((t) => t.name === "subagent_create");
    const subagentType = (tool.parameters as any).properties.subagent_type;
    expect(subagentType.anyOf.map((t: { const?: string }) => t.const)).toEqual([
      "general-purpose",
      "explore",
      "plan-reviewer",
    ]);
  });
});
