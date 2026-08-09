/**
 * rpc-process part: JSONL protocol framing against a fake pi worker child.
 * The child is a real `node -e` process speaking the wire protocol: JSONL
 * commands on stdin, `{type:"response"}` / events on stdout, one garbage
 * line on startup to prove stray stdout noise is ignored.
 */
import { describe, it, expect, vi } from "vitest";
import { RpcProcess, type RpcRecord, type ExtensionUiRequest } from "../src/parts/rpc-process.js";

const FAKE_CHILD = `
const readline = require("node:readline");
process.stdout.write("this is not json\\n"); // stray noise before any protocol
let uiResponses = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const reply = (id, command, data) => out({ type: "response", id, command, success: true, data });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type === "extension_ui_response") { uiResponses++; return; }
  if (!cmd.type || cmd.type === "response") return; // not a command for us
  process.stderr.write("CMD:" + cmd.type + "\\n");
  switch (cmd.type) {
    case "never": return; // hold the request open
    case "mismatch": return out({ type: "response", id: cmd.id, command: "wrong", success: true, data: {} });
    case "fail": return out({ type: "response", id: cmd.id, command: "fail", success: false, error: "boom" });
    case "garbage": out("noise in the middle\\n"); return reply(cmd.id, "garbage", { echo: "garbage" });
    case "get_messages": return reply(cmd.id, "get_messages", { messages: [] });
    case "get_state": return reply(cmd.id, "get_state", {});
    case "trig_ui_input": out({ type: "extension_ui_request", id: "ui-1", method: "input", title: "T" }); return reply(cmd.id, "trig_ui_input", {});
    case "trig_ui_notify": out({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "hi" }); return reply(cmd.id, "trig_ui_notify", {});
    case "get_ui_responses": return reply(cmd.id, "get_ui_responses", { count: uiResponses });
    case "ui_ack": return reply(cmd.id, "ui_ack", { ok: true });
    case "prompt": reply(cmd.id, "prompt", {}); return out({ type: "agent_settled" });
    case "get_last_assistant_text": return reply(cmd.id, "get_last_assistant_text", { text: "OK" });
    case "abort": return reply(cmd.id, "abort", {});
    case "die": setTimeout(() => process.exit(1), 20); return; // no reply, then exit
    default: return reply(cmd.id, cmd.type, { echo: cmd.type });
  }
});
`;

function fakeRpc(overrides: Partial<{ requestTimeoutMs: number }> = {}) {
  return new RpcProcess({
    command: process.execPath,
    args: ["-e", FAKE_CHILD],
    requestTimeoutMs: overrides.requestTimeoutMs,
  });
}

describe("RpcProcess protocol client", () => {
  it("round-trips a request/response", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    try {
      const data = await rpc.request<{ echo: string }>("ping");
      expect(data).toEqual({ echo: "ping" });
    } finally {
      await rpc.stop();
    }
  });

  it("rejects a response whose command does not match the request", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    try {
      await expect(rpc.request("mismatch")).rejects.toThrow(/command mismatch.*mismatch.*wrong/);
    } finally {
      await rpc.stop();
    }
  });

  it("surfaces success:false as a rejection with the worker error", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    try {
      await expect(rpc.request("fail")).rejects.toThrow(/boom/);
    } finally {
      await rpc.stop();
    }
  });

  it("times out a request the worker never answers", async () => {
    const rpc = fakeRpc({ requestTimeoutMs: 50 });
    await rpc.start();
    try {
      await expect(rpc.request("never")).rejects.toThrow(/Timed out waiting for never response/);
    } finally {
      await rpc.stop();
    }
  });

  it("ignores stray non-JSON stdout lines", async () => {
    const rpc = fakeRpc();
    const onError = vi.fn();
    rpc.onError(onError);
    await rpc.start();
    try {
      const data = await rpc.request<{ echo: string }>("garbage");
      expect(data).toEqual({ echo: "garbage" });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await rpc.stop();
    }
  });

  it("default-cancels an extension_ui_request input and answers it", async () => {
    const rpc = fakeRpc();
    const events: RpcRecord[] = [];
    rpc.onEvent((e) => events.push(e));
    await rpc.start();
    try {
      await rpc.request("trig_ui_input");
      const ui = events.find((e) => e.type === "extension_ui_request") as ExtensionUiRequest;
      expect(ui).toBeDefined();
      expect(ui.method).toBe("input");
      // The worker sees exactly one extension_ui_response: the default cancel.
      const ack = await rpc.request<{ count: number }>("get_ui_responses");
      expect(ack.count).toBe(1);
      const reply = await rpc.request<{ ok: boolean }>("ui_ack");
      expect(reply.ok).toBe(true);
    } finally {
      await rpc.stop();
    }
  });

  it("sends no reply for fire-and-forget UI methods like notify", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    try {
      await rpc.request("trig_ui_notify");
      const ack = await rpc.request<{ count: number }>("get_ui_responses");
      expect(ack.count).toBe(0);
    } finally {
      await rpc.stop();
    }
  });

  it("prompt() resolves when agent_settled arrives", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    try {
      await rpc.prompt("hello");
      expect(await rpc.getLastAssistantText()).toBe("OK");
    } finally {
      await rpc.stop();
    }
  });

  it("exposes deltas as events: get_messages and get_state helpers hit the wire", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    try {
      // Default branch echoes the command name back, so both helpers resolve.
      const messages = await rpc.getMessages();
      expect(Array.isArray(messages)).toBe(true);
      const state = await rpc.getState();
      expect(state.sessionFile).toBeUndefined();
    } finally {
      await rpc.stop();
    }
  });

  it("stop() sends abort, then closes stdin (worker sees CMD:abort before EOF)", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    await rpc.stop();
    const stderr = rpc.getStderr();
    expect(stderr).toContain("CMD:abort");
  });

  it("rejects an in-flight request when the child exits", async () => {
    const rpc = fakeRpc();
    await rpc.start();
    try {
      await expect(rpc.request("die")).rejects.toThrow(/exited with code 1/);
    } finally {
      await rpc.stop();
    }
  });
});