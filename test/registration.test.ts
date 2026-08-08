/**
 * The part's default export: registration wiring against a stub ExtensionAPI.
 * Runs anywhere (no landstrip spawn).
 */
import { describe, it, expect } from "vitest";
import factory from "../src/parts/sandbox.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function stubPi() {
  const handlers = new Map<string, Function>();
  const stub = {
    tool: undefined as any,
    commands: new Map<string, any>(),
    on(event: string, h: Function) {
      handlers.set(event, h);
    },
    registerTool(t: any) {
      stub.tool = t;
    },
    registerCommand(name: string, opts: any) {
      stub.commands.set(name, opts);
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
