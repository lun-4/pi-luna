import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SandboxAutoModeConfig {
  enabled?: boolean;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fallback?: "prompt" | "deny" | "sandbox";
  maxTranscriptChars?: number;
  bypassAllowlist?: boolean;
  systemPromptFile?: string;
  interpreterPrograms?: string[];
}

export interface SandboxConfig {
  enabled?: boolean;
  unsandboxedAllow?: string[];
  autoMode?: SandboxAutoModeConfig;
  shell?: Record<string, unknown>;
  network?: Record<string, unknown>;
  filesystem?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoadOpts { baseDir?: string; homeDir?: string; cwd: string; trusted: boolean }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function mergeTwo(a: SandboxConfig, b: SandboxConfig): SandboxConfig {
  const out: SandboxConfig = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (Array.isArray(av) && Array.isArray(v)) out[k] = [...av, ...v];
    else if (isPlainObject(av) && isPlainObject(v)) out[k] = mergeTwo(av, v);
    else out[k] = v;
  }
  return out;
}
export function mergeTiers(tiers: (SandboxConfig | undefined)[]): SandboxConfig {
  let out: SandboxConfig = {};
  for (const tier of tiers) if (tier) out = mergeTwo(out, tier);
  return out;
}
function readJsonIfExists(file: string): SandboxConfig | undefined {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined; }
  catch { return undefined; }
}
export function loadConfig(opts: LoadOpts): { config: SandboxConfig } {
  const home = opts.homeDir ?? homedir();
  const base = readJsonIfExists(join(opts.baseDir ?? new URL(".", import.meta.url).pathname, "sandbox.json"));
  const global = readJsonIfExists(join(home, ".pi", "agent", "luna-sandbox.json"));
  const project = opts.trusted ? readJsonIfExists(join(opts.cwd, ".pi", "sandbox.json")) : undefined;
  return { config: mergeTiers([base, global, project]) };
}
