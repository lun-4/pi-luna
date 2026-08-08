#!/usr/bin/env node
/**
 * Empirical probe of landstrip's policy semantics + trap emission.
 * Run from a top-level shell:  node scripts/landstrip-probe.mjs
 *
 * Prints exit status and stderr for each case so we can see:
 *  - whether allowRead alone confines reads (README says NO)
 *  - whether Landlock denials emit trap JSON or fail silently
 *  - whether glob denyWrite hits emit traps (broker-mediated)
 *  - whether denyRead ["/"] + allowRead exceptions is viable
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { binaryPath } from "@landstrip/landstrip";

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, "..", "src", "parts", "sandbox.json"), "utf8"));
delete base.enabled;
delete base.unsandboxedAllow;

const scratch = mkdtempSync(join(tmpdir(), "ls-probe-"));
const policyA = join(scratch, "A.json"); // base as-is (denyRead: [])
const policyB = join(scratch, "B.json"); // base + denyRead ["/"]
writeFileSync(policyA, JSON.stringify(base));
writeFileSync(policyB, JSON.stringify({
  ...base,
  filesystem: { ...base.filesystem, denyRead: ["/"] },
}));

const bin = binaryPath();

function run(name, policy, argv, cwd = scratch) {
  const r = spawnSync(bin, ["run", "-p", policy, "--", ...argv], {
    encoding: "utf8",
    cwd,
    timeout: 15000,
  });
  const stderr = (r.stderr ?? "").trim();
  const trapLines = stderr
    .split("\n")
    .filter((l) => {
      try {
        const o = JSON.parse(l);
        return o && typeof o.kind === "string" && typeof o.code === "string";
      } catch {
        return false;
      }
    });
  console.log(`\n== ${name}`);
  console.log(`   exit=${r.status} signal=${r.signal} error=${r.error ?? "no"}`);
  if (r.stdout?.trim()) console.log(`   stdout: ${r.stdout.trim().slice(0, 300)}`);
  if (stderr) console.log(`   stderr: ${stderr.slice(0, 600)}`);
  console.log(`   traps: ${trapLines.length ? trapLines.join(" | ").slice(0, 600) : "(none)"}`);
}

console.log(`binary: ${bin}`);
console.log(`scratch cwd: ${scratch}`);

// --- Policy A: current base (denyRead empty) --------------------------------
run("A: read /etc/hostname (world-readable, outside allowRead)", policyA, ["cat", "/etc/hostname"]);
run("A: read ~/.gitconfig (in allowRead)", policyA, ["cat", `${homedir()}/.gitconfig`]);
run("A: write ~/ls-probe-write (outside allowWrite)", policyA, ["bash", "-c", `echo x > ${homedir()}/ls-probe-write`]);
run("A: write ./secret.env (glob denyWrite)", policyA, ["bash", "-c", "echo x > ./secret.env"]);
run("A: write ./ok.txt (allowed)", policyA, ["bash", "-c", "echo x > ./ok.txt"]);
run("A: bash works at all", policyA, ["bash", "-c", "echo alive"]);

// --- Policy B: denyRead ["/"] + allowRead exceptions -------------------------
run("B: bash works under denyRead /", policyB, ["bash", "-c", "echo alive"]);
run("B: read /etc/hostname (should be denied)", policyB, ["cat", "/etc/hostname"]);
run("B: read ./ok.txt relative (allowRead . exception)", policyB, ["cat", "./ok.txt"]);
run("B: read ~/.gitconfig (allowRead exception)", policyB, ["cat", `${homedir()}/.gitconfig`]);
run("B: curl example.net (network open)", policyB, ["bash", "-c", "curl -sI -m 8 https://example.net -o /dev/null -w '%{http_code}\\n'"]);

rmSync(join(homedir(), "ls-probe-write"), { force: true });
rmSync(scratch, { recursive: true, force: true });
