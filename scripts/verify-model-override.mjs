#!/usr/bin/env node
/**
 * Manual verification for configurable subagent models
 * (subagent_architecture.md → "Configurable subagent models").
 *
 *   node scripts/verify-model-override.mjs
 *
 * Run unsandboxed (reads ~/.pi/agent). Two checks:
 *
 * 1. Registry gate — builds a real ModelRuntime/ModelRegistry from ~/.pi/agent
 *    (models.json + models-store.json, exactly the files the running pi loads)
 *    and exercises ctx.modelRegistry.find(provider, id) — the up-front spawn
 *    gate in subagents.ts. Positive: the override model resolves. Negative:
 *    an unknown id returns undefined (would throw the "not in the model
 *    registry" error).
 * 2. Worker resolve — spawns a real explore-tooled pi RPC worker with
 *    --model <provider>/<id> --thinking <level> (the spawnArgs shape) and
 *    checks get_state reports the configured model. Then a
 *    prompt → agent_settled → get_last_assistant_text roundtrip (the report
 *    path; needs the provider's API key — reported, not failed, when absent).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime, getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../src/parts/rpc-process.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const OVERRIDE = process.env.SUBAGENT_OVERRIDE_MODEL ?? "openrouter/deepseek/deepseek-v4-flash-0731";
const OVERRIDE_THINKING = process.env.SUBAGENT_OVERRIDE_THINKING ?? "xhigh";

let failures = 0;
const ok = (name, detail = "") => console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
const bad = (name, detail) => {
  failures++;
  console.log(`  ✗ ${name}\n    ${detail}`);
};

// --- 1. registry gate (ctx.modelRegistry.find) --------------------------------
console.log(`Registry gate (model = ${OVERRIDE}):`);
try {
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const slash = OVERRIDE.indexOf("/");
  const provider = OVERRIDE.slice(0, slash);
  const id = OVERRIDE.slice(slash + 1);
  const found = registry.find(provider, id);
  if (found) {
    ok(`find("${provider}", "${id}")`, `→ provider=${found.provider} id=${found.id}`);
  } else {
    bad(`find("${provider}", "${id}")`, `returned undefined — the spawn gate would throw "model ... is not in the model registry"`);
  }
  const unknown = registry.find("openrouter", "nope/nope");
  if (!unknown) ok("unknown id → undefined (spawn-throw branch)");
  else bad("unknown id", `unexpectedly resolved ${unknown.provider}/${unknown.id}`);
} catch (err) {
  bad("registry construction", String(err));
}

// --- 2. worker resolve + report path ------------------------------------------
console.log(`Worker resolve (--model ${OVERRIDE} --thinking ${OVERRIDE_THINKING}):`);
function resolveCliEntry() {
  const argvEntry = process.argv[1];
  if (argvEntry && /(?:^|[/\\])cli\.(?:js|mjs|cjs|ts)$/.test(argvEntry)) {
    return { command: process.execPath, args: [argvEntry] };
  }
  const pkgPath = join(getPackageDir(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (!bin) throw new Error("Unable to determine the running Pi CLI entry");
  return { command: process.execPath, args: [join(dirname(pkgPath), bin)] };
}

const sessionDir = mkdtempSync(join(tmpdir(), "luna-model-override-"));
const rpc = new RpcProcess({
  command: resolveCliEntry().command,
  args: [
    ...resolveCliEntry().args,
    "--mode", "rpc",
    "--no-extensions",
    "--session-dir", sessionDir,
    "--model", OVERRIDE,
    "--thinking", OVERRIDE_THINKING,
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
  await rpc.start();
  const state = await rpc.getState();
  const m = state.model;
  if (m && m.provider === OVERRIDE.slice(0, OVERRIDE.indexOf("/")) && m.id === OVERRIDE.slice(OVERRIDE.indexOf("/") + 1)) {
    ok("get_state.model", `${m.provider}/${m.id}`);
  } else {
    bad("get_state.model", `expected ${OVERRIDE}, got ${m ? `${m.provider}/${m.id}` : JSON.stringify(state.model)}`);
  }
  if (state.thinkingLevel === OVERRIDE_THINKING) {
    ok("get_state.thinkingLevel", String(state.thinkingLevel));
  } else {
    bad("get_state.thinkingLevel", `expected ${OVERRIDE_THINKING}, got ${String(state.thinkingLevel)}`);
  }

  console.log("  prompt → settle → get_last_assistant_text (report path):");
  try {
    await rpc.prompt("Reply with exactly: OK");
    const text = (await rpc.getLastAssistantText())?.trim();
    if (text === "OK") ok("prompt roundtrip", JSON.stringify(text));
    else bad("prompt roundtrip", `expected "OK", got ${JSON.stringify(text)}`);
  } catch (err) {
    console.log(`    (skipped: LLM roundtrip unavailable — ${String(err).split("\n")[0]})`);
  }
} catch (err) {
  bad("worker", String(err));
} finally {
  await rpc.stop().catch(() => {});
  rmSync(sessionDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);