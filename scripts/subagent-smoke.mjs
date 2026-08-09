#!/usr/bin/env node
/**
 * Standalone smoke test for process-backed subagents.
 *
 * Run manually (needs API keys for the default model):
 *
 *   node scripts/subagent-smoke.mjs
 *
 * Exercises the real worker loop against a real pi RPC worker: spawn an
 * explore-tooled worker, prompt → agent_settled → get_last_assistant_text,
 * follow_up → settle → text again, then abort + close stdin + exit.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../src/parts/rpc-process.ts";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures++;
  console.log(`  ✗ ${name}\n    ${detail}`);
};

// --- CLI entry resolution (same logic as subagents.ts piInvocation) ---------
console.log("pi CLI entry:");
function resolveCliEntry() {
  const argvEntry = process.argv[1];
  if (argvEntry && /(?:^|[/\\])cli\.(?:js|mjs|cjs|ts)$/.test(argvEntry)) {
    return { command: process.execPath, args: [argvEntry] };
  }
  // Same as subagents.ts: pi's own getPackageDir() (no import.meta.resolve —
  // that breaks under pi's jiti extension loader).
  const pkgPath = join(getPackageDir(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (!bin) throw new Error("Unable to determine the running Pi CLI entry");
  return { command: process.execPath, args: [join(dirname(pkgPath), bin)] };
}

const invocation = resolveCliEntry();
console.log(`  command=${invocation.command}`);
console.log(`  args=${JSON.stringify(invocation.args)}`);

const sessionDir = mkdtempSync(join(tmpdir(), "luna-subagent-smoke-"));
const rpc = new RpcProcess({
  command: invocation.command,
  args: [
    ...invocation.args,
    "--mode", "rpc",
    "--no-extensions",
    "--session-dir", sessionDir,
    "--thinking", "minimal",
    "--system-prompt", "You are a smoke-test worker; keep answers to one line.",
    "--no-approve",
    "--tools", "read,grep,find,ls",
  ],
  cwd: process.cwd(),
  env: process.env,
  requestTimeoutMs: 120_000,
  settleTimeoutMs: 120_000,
});

try {
  console.log("1. spawn worker:");
  await rpc.start();
  ok("rpc.start()");

  console.log("2. prompt → settle → get_last_assistant_text:");
  await rpc.prompt("Reply with exactly: OK");
  const text1 = (await rpc.getLastAssistantText())?.trim();
  if (text1 === "OK") ok(`prompt roundtrip (${JSON.stringify(text1)})`);
  else bad("prompt roundtrip", `expected "OK", got ${JSON.stringify(text1)}`);

  console.log("3. follow_up → drained by the next turn → settle → get_last_assistant_text:");
  // pi RPC semantics: follow_up only QUEUES when the agent is idle (verified
  // in agent-session.js followUp/_queueFollowUp); the queue is drained at the
  // next run's turn boundary (agent-loop.js getFollowUpMessages). So: queue
  // the follow-up, then prompt — the drained follow-up produces the final
  // assistant message and agent_settled fires once at the very end.
  await rpc.request("follow_up", { message: "Reply with exactly: OK2" });
  await rpc.prompt("Reply with exactly: OK2");
  const text2 = (await rpc.getLastAssistantText())?.trim();
  if (text2 === "OK2") ok(`follow_up roundtrip (${JSON.stringify(text2)})`);
  else bad("follow_up roundtrip", `expected "OK2", got ${JSON.stringify(text2)}`);
} catch (e) {
  bad("worker", e instanceof Error ? e.message : String(e));
} finally {
  console.log("4. abort → close stdin → wait exit:");
  try {
    await rpc.stop();
    ok("clean stop");
  } catch (e) {
    bad("stop", e instanceof Error ? e.message : String(e));
  }
}

rmSync(sessionDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);