/**
 * Integration tests that spawn the real landstrip binary.
 *
 * The sandboxed-run tests auto-skip when the current process is already
 * inside a landstrip sandbox (e.g. a nested pi-landstrip session), because
 * user-notify listeners cannot be installed there. The sandbox:false gate
 * tests run anywhere (they use pi's local exec path, no landstrip).
 *
 * Run `npx vitest run test/integration.test.ts` from a top-level shell to
 * exercise the sandboxed tests for real.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { binaryPath } from "@landstrip/landstrip";
import { makeSandboxTool, landstripPolicy, type SandboxUI } from "../src/parts/sandbox.js";

const cwd = process.cwd();
const home = mkdtempSync(join(tmpdir(), "luna-home-"));
const here = dirname(fileURLToPath(import.meta.url));

// Probe synchronously at module load: skipIf/runIf conditions are evaluated
// at collection time, before any beforeAll hook runs.
// Uses the *actual* bundled base policy and the exact production invocation —
// anything less faithfully reproduces what execute() does.
function probeSandbox(): { available: boolean; diag: string } {
  const dir = mkdtempSync(join(tmpdir(), "luna-probe-"));
  const pol = join(dir, "p.json");
  const base = JSON.parse(readFileSync(join(here, "..", "src", "parts", "sandbox.json"), "utf8"));
  writeFileSync(pol, JSON.stringify(landstripPolicy(base)));
  const r = spawnSync(binaryPath(), ["run", "-p", pol, "--", "bash", "-c", "true"], {
    encoding: "utf8",
  });
  return {
    available: r.status === 0,
    diag:
      `status=${r.status} signal=${r.signal} error=${r.error} ` +
      `stderr=${JSON.stringify(r.stderr?.slice(0, 2000))}`,
  };
}
const probe = probeSandbox();
const available = probe.available;
if (!available) {
  process.stderr.write(`[integration] sandbox probe failed: ${probe.diag}\n`);
}

function fakeUi(answer: string | undefined): SandboxUI & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async select(title: string, options: string[]) {
      calls.push([title, ...options]);
      return answer;
    },
    setStatus() {},
  };
}

/** Minimal ExtensionContext stub for the raw exec path. */
function makeCtx(ui: SandboxUI, over: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    isProjectTrusted: () => true,
    cwd,
    ui,
    model: undefined,
    thinkingLevel: undefined,
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
    ...over,
  };
}

describe("sandboxed bash (default)", () => {
  it.skipIf(!available)("echo hi exits 0 with no denial note", async () => {
    const ui = fakeUi(undefined);
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    const res = await tool.execute("t1", { command: "echo hi" }, undefined, undefined, makeCtx(ui) as never);
    expect(res.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("hi") });
    expect((res.content[0] as { text: string }).text).not.toContain("Sandbox: this command was denied");
  });

  it.skipIf(!available)("writes outside allowed roots are denied and the note names the path", async () => {
    const ui = fakeUi(undefined);
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    // $HOME is outside allowWrite (".", /tmp, caches) — guaranteed denial + trap.
    await expect(
      tool.execute("t2", { command: 'echo x > "$HOME/luna-sbx-write-probe"' }, undefined, undefined, makeCtx(ui) as never),
    ).rejects.toThrow(/Sandbox: this command was denied[\s\S]*luna-sbx-write-probe/);
  });

  it.skipIf(!available)("home reads are denied and the note names the path", async () => {
    const ui = fakeUi(undefined);
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    // denyRead ["/home", ...] with cwd as the only home exception.
    await expect(
      tool.execute("t2b", { command: "ls ~" }, undefined, undefined, makeCtx(ui) as never),
    ).rejects.toThrow(/Sandbox: this command was denied[\s\S]*home/);
  });

  it.skipIf(!available)("system paths stay readable under denyRead (loader works)", async () => {
    const ui = fakeUi(undefined);
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    const res = await tool.execute("t2c", { command: "cat /etc/hostname" }, undefined, undefined, makeCtx(ui) as never);
    expect((res.content[0] as { text: string }).text.trim().length).toBeGreaterThan(0);
  });

  // Inverse of the above: in a nested shell the trap path is exercised for
  // real — landstrip runs, emits SANDBOX_SETUP_FAILED, we surface it.
  it.runIf(!available)("sandboxed run reports Sandbox unavailable when nested", async () => {
    const ui = fakeUi(undefined);
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    await expect(
      tool.execute("t-nested", { command: "echo hi" }, undefined, undefined, makeCtx(ui) as never),
    ).rejects.toThrow(/Sandbox unavailable/);
  });

  it.skipIf(!available)("network is unrestricted in the sandbox", async () => {
    const ui = fakeUi(undefined);
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    const res = await tool.execute(
      "t3",
      { command: "curl -sI -m 10 https://example.net -o /dev/null -w '%{http_code}'" },
      undefined, undefined, makeCtx(ui) as never,
    );
    expect((res.content[0] as { text: string }).text).toContain("200");
  }, 20000);
});

describe("sandbox:false gate", () => {
  it("unlisted program + UI deny → toolError, command did not run", async () => {
    const ui = fakeUi("deny");
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    await expect(
      tool.execute("t4", { command: "zzz-not-allowed touch /tmp/luna-ran", sandbox: false }, undefined, undefined, makeCtx(ui) as never),
    ).rejects.toThrow(/denied/i);
    expect(ui.calls).toHaveLength(1);
  });

  it("unlisted program + allow once runs raw and prompts again next time", async () => {
    const ui = fakeUi("allow once");
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    const res = await tool.execute("t5", { command: "echo raw", sandbox: false }, undefined, undefined, makeCtx(ui) as never);
    expect((res.content[0] as { text: string }).text).toContain("raw");
    expect(ui.calls).toHaveLength(1);
    await tool.execute("t6", { command: "echo raw2", sandbox: false }, undefined, undefined, makeCtx(ui) as never);
    expect(ui.calls).toHaveLength(2);
  });

  it("unlisted program + allow session runs raw once, then no more prompts", async () => {
    const ui = fakeUi("always allow echo this session");
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home });
    await tool.execute("t7", { command: "echo one", sandbox: false }, undefined, undefined, makeCtx(ui) as never);
    await tool.execute("t8", { command: "echo two", sandbox: false }, undefined, undefined, makeCtx(ui) as never);
    expect(ui.calls).toHaveLength(1);
  });

  it("pre-listed in session tier runs raw with no menu", async () => {
    const ui = fakeUi(undefined);
    const tool = makeSandboxTool(cwd, { ui, ctx: makeCtx(ui), homeDir: home, sessionAllow: new Set(["git"]) });
    const res = await tool.execute("t9", { command: "git --version", sandbox: false }, undefined, undefined, makeCtx(ui) as never);
    expect((res.content[0] as { text: string }).text).toMatch(/git version/);
    expect(ui.calls).toHaveLength(0);
  });

  it("project option is absent when the project is not trusted", async () => {
    const ui = fakeUi("deny");
    const untrusted = makeCtx(ui, { isProjectTrusted: () => false });
    const tool = makeSandboxTool(cwd, { ui, ctx: untrusted, homeDir: home });
    await expect(
      tool.execute("t10", { command: "git status", sandbox: false }, undefined, undefined, untrusted as never),
    ).rejects.toThrow(/denied/i);
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0].some((o) => o.includes("for this project"))).toBe(false);
  });

  it("headless (hasUI false) denies without prompting", async () => {
    const ui = fakeUi(undefined);
    const headless = makeCtx(ui, { hasUI: false });
    const tool = makeSandboxTool(cwd, { ui, ctx: headless, homeDir: home });
    await expect(
      tool.execute("t11", { command: "git status", sandbox: false }, undefined, undefined, headless as never),
    ).rejects.toThrow(/denied/i);
    expect(ui.calls).toHaveLength(0);
  });
});
