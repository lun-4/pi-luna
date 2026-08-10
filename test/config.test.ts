import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tempDir } from "./temp.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeTiers, landstripPolicy, loadConfig, type SandboxConfig } from "../src/parts/sandbox.js";
import { binaryPath } from "@landstrip/landstrip";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const basePath = join(here, "..", "src", "parts", "sandbox.json");
const base = JSON.parse(readFileSync(basePath, "utf8")) as SandboxConfig;

describe("bundled base policy", () => {
  it("passes landstrip policy validate once unsandboxedAllow is stripped", () => {
    const dir = tempDir("luna-policy-");
    const f = join(dir, "policy.json");
    writeFileSync(f, JSON.stringify(landstripPolicy(base)));
    const out = execFileSync(binaryPath(), ["policy", "validate", "-p", f], { encoding: "utf8" });
    expect(JSON.parse(out)).toMatchObject({ valid: true });
  });
});

describe("mergeTiers", () => {
  it("later scalars win, arrays concatenate, objects merge", () => {
    const a: SandboxConfig = { filesystem: { allowRead: ["."], denyRead: [] }, network: { allowNetwork: true } };
    const b: SandboxConfig = { filesystem: { allowRead: ["/extra"] }, network: { allowNetwork: false } };
    const merged = mergeTiers([a, b]);
    expect(merged.filesystem?.allowRead).toEqual([".", "/extra"]);
    expect(merged.filesystem?.denyRead).toEqual([]);
    expect(merged.network?.allowNetwork).toBe(false);
  });

  it("concatenates unsandboxedAllow across tiers", () => {
    const merged = mergeTiers([
      { unsandboxedAllow: ["git"] },
      { unsandboxedAllow: ["make", "ssh"] },
      { unsandboxedAllow: ["git"] },
    ]);
    expect(merged.unsandboxedAllow).toEqual(["git", "make", "ssh", "git"]);
  });

  it("ignores undefined tiers", () => {
    expect(mergeTiers([{ enabled: true }, undefined, { enabled: false }]).enabled).toBe(false);
  });
});

describe("landstripPolicy", () => {
  it("strips unsandboxedAllow and enabled", () => {
    const p = landstripPolicy({ enabled: true, unsandboxedAllow: ["git"], filesystem: { allowRead: ["."] } });
    expect(p).not.toHaveProperty("unsandboxedAllow");
    expect(p).not.toHaveProperty("enabled");
    expect(p).toHaveProperty("filesystem");
  });
});

describe("loadConfig", () => {
  it("defaults Auto availability on", () => {
    const loaded = loadConfig({ baseDir: join(here, "..", "src", "parts"), homeDir: tempDir("luna-empty-home-"), cwd: "/tmp", trusted: false });
    expect(loaded.config.autoMode?.enabled).toBe(true);
  });

  it("loads base+global, skips project when untrusted, concatenates allow", () => {
    const root = tempDir("luna-cfg-");
    const home = join(root, "home");
    const proj = join(root, "proj");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "luna-sandbox.json"), JSON.stringify({ unsandboxedAllow: ["ssh"] }));
    // project file
    writeFileSync(join(proj, ".pi", "sandbox.json"), JSON.stringify({ unsandboxedAllow: ["make"] }));
    const loaded = loadConfig({ baseDir: join(here, "..", "src", "parts"), homeDir: home, cwd: proj, trusted: false });
    expect(loaded.config.unsandboxedAllow).toEqual(["ssh"]); // project skipped
    const loadedTrusted = loadConfig({ baseDir: join(here, "..", "src", "parts"), homeDir: home, cwd: proj, trusted: true });
    expect(loadedTrusted.config.unsandboxedAllow).toEqual(["ssh", "make"]);
  });
});
