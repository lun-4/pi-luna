#!/usr/bin/env node
/**
 * Standalone smoke test for the sandbox part.
 *
 * Run from a TOP-LEVEL shell (not inside a pi-landstrip session):
 *
 *   node scripts/sandbox-smoke.mjs
 *
 * Exercises: landstrip probe, sandboxed echo, sandboxed denial of
 * /etc/shadow, and network access from inside the sandbox. Uses the real
 * landstrip binary and the real bundled base policy; no test framework.
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { binaryPath } from "@landstrip/landstrip";
import { makeSandboxTool, landstripPolicy } from "../src/parts/sandbox.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cwd = process.cwd();
const home = mkdtempSync(join(tmpdir(), "luna-smoke-home-"));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures++;
  console.log(`  ✗ ${name}\n    ${detail}`);
};

// --- probe ---------------------------------------------------------------
console.log("probe:");
const dir = mkdtempSync(join(tmpdir(), "luna-probe-"));
const pol = join(dir, "p.json");
const base = JSON.parse(readFileSync(join(root, "src", "parts", "sandbox.json"), "utf8"));
writeFileSync(pol, JSON.stringify(landstripPolicy(base)));
const probe = spawnSync(binaryPath(), ["run", "-p", pol, "--", "bash", "-c", "true"], {
  encoding: "utf8",
});
console.log(`  status=${probe.status} signal=${probe.signal} error=${probe.error}`);
if (probe.stdout) console.log(`  stdout=${JSON.stringify(probe.stdout)}`);
if (probe.stderr) console.log(`  stderr=${JSON.stringify(probe.stderr.slice(0, 2000))}`);

if (probe.status !== 0) {
  bad("probe", "landstrip cannot run here — nested sandbox or missing kernel features.");
  console.log("\nSkipping sandboxed scenario tests.");
  process.exit(1);
}
ok("probe (landstrip runs)");

// --- tool harness --------------------------------------------------------
const ui = {
  async select() {
    throw new Error("no UI in smoke test");
  },
  setStatus() {},
};
const ctx = {
  hasUI: false,
  isProjectTrusted: () => false,
  cwd,
  ui,
  model: undefined,
  thinkingLevel: undefined,
  sessionManager: { getSessionId: () => "smoke", getSessionFile: () => undefined },
};
const tool = makeSandboxTool(cwd, { ui, ctx, homeDir: home });
const exec = (command, extra = {}) =>
  tool.execute("smoke", { command, ...extra }, undefined, undefined, ctx);

// --- scenario 1: echo ----------------------------------------------------
console.log("sandboxed echo:");
try {
  const res = await exec("echo hi");
  const text = res.content[0].text;
  if (text.includes("hi") && !text.includes("Sandbox: this command was denied")) ok("echo hi");
  else bad("echo hi", `unexpected output: ${JSON.stringify(text)}`);
} catch (e) {
  bad("echo hi", e.message);
}

// --- scenario 2: write outside allowed roots denied ----------------------
console.log("sandboxed write to $HOME (outside allowWrite):");
try {
  const res = await exec('echo x > "$HOME/luna-smoke-write"');
  bad("home write", `expected denial, got success: ${JSON.stringify(res.content[0].text)}`);
} catch (e) {
  if (/Sandbox: this command was denied/.test(e.message) && e.message.includes("luna-smoke-write")) {
    ok("denied, note names the path");
  } else {
    bad("home write", `wrong failure: ${e.message}`);
  }
}

// --- scenario 3: home reads denied, system paths fine --------------------
console.log("sandboxed ls ~ (denyRead home roots):");
try {
  const res = await exec("ls ~");
  bad("ls ~", `expected denial, got success: ${JSON.stringify(res.content[0].text.slice(0, 200))}`);
} catch (e) {
  if (/Sandbox: this command was denied/.test(e.message) && e.message.includes("home")) {
    ok("denied, note names the path");
  } else {
    bad("ls ~", `wrong failure: ${e.message}`);
  }
}

console.log("sandboxed cat /etc/hostname (system path stays readable):");
try {
  const res = await exec("cat /etc/hostname");
  if (res.content[0].text.trim().length > 0) ok("/etc/hostname readable");
  else bad("/etc/hostname", "empty output");
} catch (e) {
  bad("/etc/hostname", e.message);
}

// --- scenario 4: network open --------------------------------------------
console.log("sandboxed network:");
try {
  const res = await exec("curl -sI -m 10 https://example.net -o /dev/null -w '%{http_code}'", {
    timeout: 15,
  });
  if (res.content[0].text.includes("200")) ok("curl https://example.net → 200");
  else bad("curl", `unexpected output: ${JSON.stringify(res.content[0].text)}`);
} catch (e) {
  bad("curl", e.message);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
