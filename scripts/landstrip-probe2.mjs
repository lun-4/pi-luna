#!/usr/bin/env node
//  1. Do glob denyWrite rules (**/dotenv, **/dotpem) fire inside allowed roots?
// 2. Does a targeted denyRead (~/dotssh) deny + emit a trap?
//  3. Does non-empty denyRead make ALL reads broker-mediated (perf check)?
//  4. Does curl to example.net work in the sandbox (network + DNS)?
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { binaryPath } from "@landstrip/landstrip";

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, "..", "src", "parts", "sandbox.json"), "utf8"));
delete base.enabled;
delete base.unsandboxedAllow;

const scratch = mkdtempSync(join(tmpdir(), "ls-probe2-"));
mkdirSync(join(scratch, "sub"));

const policyA = join(scratch, "A.json"); // base as-is
const policyC = join(scratch, "C.json"); // base + targeted denyRead
writeFileSync(policyA, JSON.stringify(base));
writeFileSync(policyC, JSON.stringify({
  ...base,
  filesystem: {
    ...base.filesystem,
    denyRead: ["~/.ssh", "~/.gnupg", "~/.aws", "~/.netrc"],
  },
}));

const bin = binaryPath();

function run(name, policy, cmd, opts = {}) {
  const start = performance.now();
  const r = spawnSync(bin, ["run", "-p", policy, "--", "bash", "-c", cmd], {
    encoding: "utf8",
    cwd: scratch,
    timeout: 30000,
    ...opts,
  });
  const ms = Math.round(performance.now() - start);
  const stderr = (r.stderr ?? "").trim();
  const traps = stderr
    .split("\n")
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((o) => o && typeof o.kind === "string" && typeof o.code === "string");
  console.log(`\n== ${name}  [${ms}ms]`);
  console.log(`   exit=${r.status}`);
  if (r.stdout?.trim()) console.log(`   stdout: ${r.stdout.trim().slice(0, 200)}`);
  const plain = stderr
    .split("\n")
    .filter((l) => !l.startsWith("{"))
    .join("\n")
    .trim();
  if (plain) console.log(`   stderr: ${plain.slice(0, 300)}`);
  console.log(
    `   traps: ${traps.length ? traps.map((t) => `${t.code}:${t.operation ?? ""}:${t.path ?? t.target ?? t.message}`).join(" | ").slice(0, 400) : "(none)"}`,
  );
  return r;
}

// 1. glob denyWrite inside an allowed root (scratch is cwd → allowWrite ".")
run("write ./.env (glob deny)", policyA, "echo x > ./.env");
run("write ./cert.pem (glob deny)", policyA, "echo x > ./cert.pem");
run("write ./sub/.env (glob deny, nested)", policyA, "echo x > ./sub/.env");
run("write ./normal.txt (should succeed)", policyA, "echo x > ./normal.txt");

// 2. targeted denyRead
run("ls ~/.ssh under denyRead (expect denial+trap)", policyC, `ls ${homedir()}/.ssh`);
run("read /etc/hostname under denyRead (still allowed)", policyC, "cat /etc/hostname");

// 3. perf: read-heavy workload, A (no denyRead) vs C (targeted denyRead)
run("perf baseline A: find /usr/share", policyA, "find /usr/share -type f | wc -l");
run("perf denyRead  C: find /usr/share", policyC, "find /usr/share -type f | wc -l");

// 4. network under A
run("curl example.net (network open)", policyA, "curl -sI -m 8 https://example.net -o /dev/null -w '%{http_code}\\n'");

rmSync(scratch, { recursive: true, force: true });
