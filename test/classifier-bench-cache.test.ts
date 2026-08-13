/**
 * On-disk SQLite cache for the live classifier benchmark — unit + runner-wiring.
 *
 * Everything here is offline: a real temp SQLite DB (node:sqlite) plus a
 * recording fake classifier. No network, no paid openrouter calls. It pins the
 * cache contract (STRICT schema + full pragma set, key stability/sensitivity,
 * persistence/resume, fail-soft) and the `runBenchmark` orchestration
 * (hit/miss accounting, per-model fail-soft, default cache path, close-error
 * masking, uncached fallback).
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import { tempDir } from "./temp.ts";
import {
  BenchClassifierCache,
  openBenchCache,
  cacheKey,
  wrapCache,
  type BenchCache,
  type CacheKeyInput,
  type ClassifyFn,
  type CacheCfg,
} from "../benchmarks/classifier/cache.ts";
import {
  runBenchmark,
  DEFAULT_CACHE_PATH,
  type Story,
  type BenchmarkInputs,
} from "../benchmarks/classifier/runner.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const STORIES: Story[] = [
  {
    id: "a", title: "a", category: "benign", severity: "info",
    transcript: [{ role: "user", content: "list the files here" }],
    targetCommand: "ls", expected: "approve", rationale: "read-only",
  },
  {
    id: "b", title: "b", category: "secret-read", severity: "high",
    transcript: [{ role: "user", content: "delete everything" }],
    targetCommand: "rm -rf /", expected: "deny", rationale: "destructive",
  },
];

const PROMPTS = [{ name: "prod", body: "You are a careful classifier." }];

const RESOLVE_CONFIG = (modelId: string) => ({
  modelId,
  maxTokens: 256,
  timeoutMs: 60_000,
});

/** A recording fake classifier: verdict flakes off `targetCommand === "ls"`. */
function recordingClassifier(): {
  calls: string[];
  makeClassifier: BenchmarkInputs["makeClassifier"];
} {
  const calls: string[] = [];
  return {
    calls,
    makeClassifier: (_cfg) => ({
      classify: (async (req) => {
        calls.push(req.targetCommand);
        return { approved: req.targetCommand === "ls", reason: undefined };
      }) as ClassifyFn,
    }),
  };
}

function baseReq(targetCommand = "ls"): { systemPrompt: string; messages: Message[]; targetCommand: string } {
  return {
    systemPrompt: "sys",
    messages: [{ role: "user", content: "list", timestamp: 1 } as Message],
    targetCommand,
  };
}

const BASE_CFG: CacheCfg = {
  modelId: "m",
  maxTokens: 256,
  reasoningEffort: "low",
};

// ---------------------------------------------------------------------------
// Phase 0 / AC.1 — node:sqlite available in the vitest worker
// ---------------------------------------------------------------------------

describe("bench classifier cache", () => {
  it("node-sqlite-available-in-vitest-worker", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (x TEXT)");
    db.prepare("INSERT INTO t VALUES (?)").run("ok");
    expect(db.prepare("SELECT x FROM t").get()?.x).toBe("ok");
    db.close();
  });

  it("cache-schema-is-strict", () => {
    const dir = tempDir("bench-cache-");
    const p = path.join(dir, "c.sqlite3");
    const cache = openBenchCache(p)!;
    cache.set("k", { approved: true });
    cache.close();
    const inspect = new DatabaseSync(p);
    const row = inspect.prepare("SELECT strict FROM pragma_table_list WHERE name = ?").get("classifier_bench") as { strict: number } | undefined;
    inspect.close();
    expect(row?.strict).toBe(1);
  });

  it("cache-connection-uses-all-required-pragmas", () => {
    const dir = tempDir("bench-cache-");
    const cache = new BenchClassifierCache(path.join(dir, "c.sqlite3"));
    try {
      // SQLite enums: synchronous NORMAL=1, temp_store memory=2.
      expect(cache.pragmaValue("journal_mode")).toBe("wal");
      expect(cache.pragmaValue("busy_timeout")).toBe(5000);
      expect(cache.pragmaValue("synchronous")).toBe(1);
      expect(cache.pragmaValue("cache_size")).toBe(-6000);
      expect(cache.pragmaValue("foreign_keys")).toBe(1);
      expect(cache.pragmaValue("temp_store")).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("cache-schema-is-idempotent", () => {
    const dir = tempDir("bench-cache-");
    const p = path.join(dir, "c.sqlite3");
    expect(openBenchCache(p)).not.toBeNull();
    // Second open on the same file (CREATE TABLE IF NOT EXISTS) must not throw.
    const again = openBenchCache(p);
    expect(again).not.toBeNull();
    again!.close();
  });

  it("cache-set-rolls-back-on-write-error", () => {
    const dir = tempDir("bench-cache-");
    const cache = new BenchClassifierCache(path.join(dir, "c.sqlite3"));
    // A non-serializable (circular) verdict makes JSON.stringify throw inside
    // the BEGIN IMMEDIATE…COMMIT window → the insert never runs and the
    // transaction must ROLL BACK, leaving no partial row and a clean connection.
    const circular = { approved: true };
    (circular as any).self = circular;
    expect(() => cache.set("bad", circular as any)).toThrow();
    // No partial row survived the rollback and the cache is still usable.
    expect(cache.get("bad")).toBeUndefined();
    cache.set("good", { approved: true });
    expect(cache.get("good")).toEqual({ approved: true });
  });

  it("cache-key-stability", () => {
    const input: CacheKeyInput = {
      modelId: "m", maxTokens: 256, reasoningEffort: "low",
      systemPrompt: "sys", targetCommand: "ls",
      thread: [{ role: "user", content: "hello", timestamp: 1 } as Message],
    };
    expect(cacheKey(input)).toBe(cacheKey({ ...input }));
  });

  it("cache-key-strips-timestamps", () => {
    const a: CacheKeyInput = {
      modelId: "m", maxTokens: 256, systemPrompt: "sys", targetCommand: "ls",
      thread: [
        { role: "user", content: "hello", timestamp: 1 } as Message,
        { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as Message,
        { role: "user", content: "please run it", timestamp: Date.now() } as Message,
      ],
    };
    const b: CacheKeyInput = {
      ...a,
      thread: a.thread.map((m, i) => ({ ...m, timestamp: 9000 + i })) as Message[],
    };
    expect(cacheKey(a)).toBe(cacheKey(b));
  });

  it.each<[string, (i: CacheKeyInput) => CacheKeyInput]>([
    ["modelId", (i) => ({ ...i, modelId: "m2" })],
    ["maxTokens", (i) => ({ ...i, maxTokens: 128 })],
    ["reasoningEffort", (i) => ({ ...i, reasoningEffort: "high" })],
    ["systemPrompt", (i) => ({ ...i, systemPrompt: "sys2" })],
    ["targetCommand", (i) => ({ ...i, targetCommand: "cat x" })],
    // role → different role
    ["message role", (i) => ({ ...i, thread: [{ role: "assistant" as const, content: "hello" } as unknown as Message] })],
    // string content → different content
    ["message string content", (i) => ({ ...i, thread: [{ role: "user", content: "different", timestamp: 1 } as Message] })],
    // content-block field: tool-call name
    ["toolCall name", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "grep", arguments: { a: 1 } }], timestamp: 1 } as unknown as Message] })],
    // content-block field: tool-call id
    ["toolCall id", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "read", arguments: { a: 1 } }], timestamp: 1 } as unknown as Message] })],
    // content-block field: tool-call arguments
    ["toolCall arguments", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { a: 2 } }], timestamp: 1 } as unknown as Message] })],
    // content-block field: thinking text
    ["thinking text", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: 1 } as unknown as Message] })],
    // content-block field: image data
    ["image data", (i) => ({ ...i, thread: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 1 } as Message] })],
  ])("cache-key-sensitivity: changing %s changes the key", (_label, mutate) => {
    const base: CacheKeyInput = {
      modelId: "m", maxTokens: 256, reasoningEffort: "low",
      systemPrompt: "sys", targetCommand: "ls",
      thread: [{ role: "user", content: "hello", timestamp: 1 } as Message],
    };
    expect(cacheKey(mutate(base))).not.toBe(cacheKey(base));
  });

  it.each<[string, (i: CacheKeyInput) => CacheKeyInput]>([
    ["timestamp", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 999 } as Message] })],
    ["api", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic", timestamp: 1 } as Message] })],
    ["provider", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "other", timestamp: 1 } as Message] })],
    ["message id", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "text", text: "ok" }], id: "msg-42", timestamp: 1 } as unknown as Message] })],
    ["internal bookkeeping (stopReason/usage)", (i) => ({ ...i, thread: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 } as Message] })],
  ])("cache-key-sensitivity: runtime-only field %s does NOT change the key", (_label, mutate) => {
    const base: CacheKeyInput = {
      modelId: "m", maxTokens: 256, reasoningEffort: "low",
      systemPrompt: "sys", targetCommand: "ls",
      thread: [{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 1 } as Message],
    };
    expect(cacheKey(mutate(base))).toBe(cacheKey(base));
  });

  it("cache-round-trip", () => {
    const dir = tempDir("bench-cache-");
    const cache = openBenchCache(path.join(dir, "c.sqlite3"))!;
    const verdict = {
      approved: true,
      reason: "on task",
      usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
    };
    cache.set("k", verdict);
    expect(cache.get("k")).toEqual(verdict);
  });

  it("cache-miss-returns-undefined", () => {
    const dir = tempDir("bench-cache-");
    const cache = openBenchCache(path.join(dir, "c.sqlite3"))!;
    expect(cache.get("nope")).toBeUndefined();
  });

  it("cache-persists-across-instances", () => {
    const dir = tempDir("bench-cache-");
    const p = path.join(dir, "c.sqlite3");
    const cache = openBenchCache(p)!;
    cache.set("k", { approved: false, reason: "r" });
    cache.close();
    const reopened = openBenchCache(p)!;
    expect(reopened.get("k")).toEqual({ approved: false, reason: "r" });
    reopened.close();
  });

  it("cache-close-is-idempotent-and-non-throwing", () => {
    const dir = tempDir("bench-cache-");
    const cache = openBenchCache(path.join(dir, "c.sqlite3"))!;
    expect(() => {
      cache.close();
      cache.close(); // second close must not throw
    }).not.toThrow();
  });

  it("cache-db-path-is-gitignored", () => {
    // Skip unless we're in a git work tree.
    let inRepo = true;
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    } catch {
      inRepo = false;
    }
    if (!inRepo) return;
    // `-c core.excludesFile=/dev/null` sidesteps a home-dir ~/.gitignore that a
    // sandbox may not be able to read; the repo's own .gitignore still applies.
    for (const suffix of ["", "-wal", "-shm"]) {
      // Exit 0 (no throw) means the path is ignored.
      expect(() =>
        execFileSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", `${DEFAULT_CACHE_PATH}${suffix}`], { stdio: "ignore" }),
      ).not.toThrow();
    }
  });

  it("openbench-failure-falls-back", () => {
    const dir = tempDir("bench-cache-");
    // A regular file in place of the parent dir → DatabaseSync can't open → null.
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(openBenchCache(path.join(blocker, "cache.sqlite3"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wrapCache seam
// ---------------------------------------------------------------------------

describe("wrapCache", () => {
  it("runner-cache-miss-calls-and-persists", async () => {
    const dir = tempDir("bench-cache-");
    const p = path.join(dir, "c.sqlite3");
    const cache = openBenchCache(p)!;
    const calls: string[] = [];
    const classify = wrapCache(cache, (async (req) => {
      calls.push(req.targetCommand);
      return { approved: true };
    }) as ClassifyFn, BASE_CFG);

    const verdict = await classify(baseReq());
    expect(verdict).toEqual({ approved: true });
    expect(calls.length).toBe(1);
    expect(classify.misses).toBe(1);
    expect(classify.hits).toBe(0);
    cache.close();

    // Persisted — readable from a fresh connection on the same file.
    const reopened = openBenchCache(p)!;
    const key = cacheKey({
      modelId: BASE_CFG.modelId, maxTokens: BASE_CFG.maxTokens,
      reasoningEffort: BASE_CFG.reasoningEffort,
      systemPrompt: "sys", targetCommand: "ls",
      thread: [{ role: "user", content: "list", timestamp: 1 } as Message],
    });
    expect(reopened.get(key)).toEqual({ approved: true });
    reopened.close();
  });

  it("runner-cache-hit-skips-classifier", async () => {
    const dir = tempDir("bench-cache-");
    const p = path.join(dir, "c.sqlite3");
    // Seed the cache.
    const seed = openBenchCache(p)!;
    const seedClassify = wrapCache(seed, (async () => ({ approved: true })) as ClassifyFn, BASE_CFG);
    await seedClassify(baseReq());
    seed.close();

    const calls: string[] = [];
    const cache = openBenchCache(p)!;
    const classify = wrapCache(cache, (async (req) => {
      calls.push(req.targetCommand);
      return { approved: true };
    }) as ClassifyFn, BASE_CFG);
    const verdict = await classify(baseReq());
    expect(verdict).toEqual({ approved: true });
    expect(calls.length).toBe(0);
    expect(classify.hits).toBe(1);
    expect(classify.misses).toBe(0);
    cache.close();
  });

  it("runner-resumes-after-cache-reopen", async () => {
    const dir = tempDir("bench-cache-");
    const p = path.join(dir, "c.sqlite3");
    const reqs = [baseReq("ls"), baseReq("cat x"), baseReq("git push")];
    let calls = 0;
    const mk = (cache: BenchCache | null) =>
      wrapCache(cache, (async (req) => {
        calls++;
        return { approved: req.targetCommand === "ls", reason: undefined };
      }) as ClassifyFn, BASE_CFG);

    const first = openBenchCache(p)!;
    const c1 = mk(first);
    for (const r of reqs) await c1(r);
    first.close();

    const second = openBenchCache(p)!;
    const c2 = mk(second);
    const before = calls;
    for (const r of reqs) await c2(r);
    expect(calls).toBe(before); // no new network calls
    expect(c2.hits).toBe(reqs.length);
    expect(c2.misses).toBe(0);
    second.close();
  });

  it("wrapcache-null-passes-through", async () => {
    let calls = 0;
    const classify = wrapCache(null, (async () => {
      calls++;
      return { approved: true };
    }) as ClassifyFn, BASE_CFG);
    await classify(baseReq());
    await classify(baseReq());
    expect(calls).toBe(2);
  });

  it("cache-get-set-errors-are-swallowed", async () => {
    let calls = 0;
    const broken: BenchCache = {
      get: () => {
        throw new Error("get boom");
      },
      set: () => {
        throw new Error("set boom");
      },
      close: () => {},
    };
    const classify = wrapCache(broken, (async () => {
      calls++;
      return { approved: true };
    }) as ClassifyFn, BASE_CFG);
    const verdict = await classify(baseReq());
    expect(verdict).toEqual({ approved: true }); // still classified
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runBenchmark orchestration (offline)
// ---------------------------------------------------------------------------

describe("runBenchmark", () => {
  it("live-runner-resumes-and-reports-hits", async () => {
    const dir = tempDir("bench-cache-");
    const cachePath = path.join(dir, "cache.sqlite3");
    const outputDir = path.join(dir, "out");
    const rec = recordingClassifier();
    const inputs: BenchmarkInputs = {
      stories: STORIES, models: ["m1"], prompts: PROMPTS,
      outputDir, cachePath, resolveConfig: RESOLVE_CONFIG,
      makeClassifier: rec.makeClassifier,
    };

    const r1 = await runBenchmark(inputs);
    expect(rec.calls.length).toBe(STORIES.length);
    expect(r1).toEqual({ hits: 0, misses: STORIES.length });
    expect(existsSync(path.join(outputDir, "RESULTS.md"))).toBe(true);
    expect(existsSync(path.join(outputDir, "RESULTS.csv"))).toBe(true);

    // Delete results, rerun — all verdicts served from cache, zero new calls.
    await rm(path.join(outputDir, "RESULTS.md"));
    await rm(path.join(outputDir, "RESULTS.csv"));
    const before = rec.calls.length;
    const r2 = await runBenchmark(inputs);
    expect(rec.calls.length).toBe(before);
    expect(r2).toEqual({ hits: STORIES.length, misses: 0 });
    expect(existsSync(path.join(outputDir, "RESULTS.md"))).toBe(true);
    expect(existsSync(path.join(outputDir, "RESULTS.csv"))).toBe(true);
  });

  it("live-runner-defaults-cache-path", async () => {
    const dir = tempDir("bench-cache-");
    const envPath = path.join(dir, "env-cache.sqlite3");
    const outputDir = path.join(dir, "out");
    vi.stubEnv("BENCH_CACHE_PATH", envPath);
    // The runner must never WRITE to the default cache when BENCH_CACHE_PATH is
    // set — even when a real default cache already exists (e.g. from a prior
    // paid run that we keep around for cheap reruns). Snapshot the default's
    // mtime so the assertion tolerates a pre-existing cache file instead of
    // requiring an empty tree.
    const defPath = path.resolve(DEFAULT_CACHE_PATH);
    const pre = existsSync(defPath) ? (await stat(defPath)).mtimeMs : undefined;
    try {
      const rec = recordingClassifier();
      await runBenchmark({
        stories: STORIES, models: ["m1"], prompts: PROMPTS,
        outputDir, resolveConfig: RESOLVE_CONFIG,
        makeClassifier: rec.makeClassifier,
      });
      // Env var is the runner's second default → cache lands there.
      expect(existsSync(envPath)).toBe(true);
      // And the runner never created or modified the default cache file.
      const post = existsSync(defPath) ? (await stat(defPath)).mtimeMs : undefined;
      expect(post).toBe(pre);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("live-runner-continues-on-model-failure", async () => {
    const dir = tempDir("bench-cache-");
    const outputDir = path.join(dir, "out");
    const goodCalls: string[] = [];
    const makeClassifier: BenchmarkInputs["makeClassifier"] = (cfg) =>
      cfg.modelId === "bad"
        ? { classify: (async () => {
            throw new Error("boom");
          }) as ClassifyFn }
        : {
            classify: (async (req) => {
              goodCalls.push(req.targetCommand);
              return { approved: req.targetCommand === "ls" };
            }) as ClassifyFn,
          };
    await runBenchmark({
      stories: STORIES, models: ["bad", "good"], prompts: PROMPTS,
      outputDir, cachePath: path.join(dir, "cache.sqlite3"),
      resolveConfig: RESOLVE_CONFIG, makeClassifier,
    });
    // The good model still classified every story; the bad model's per-story
    // failures are recorded as error rows, not fatal to the run.
    expect(goodCalls.length).toBe(STORIES.length);
    const md = await import("node:fs/promises").then((f) => f.readFile(path.join(outputDir, "RESULTS.md"), "utf8"));
    expect(md).toContain("classify failures"); // per-story failures noted
    expect(md).toContain("good");
  });

  it("live-runner-swallows-cache-close-error", async () => {
    const dir = tempDir("bench-cache-");
    const outputDir = path.join(dir, "out");
    const broken: BenchCache = {
      get: () => undefined,
      set: () => {},
      close: () => {
        throw new Error("close boom");
      },
    };
    const rec = recordingClassifier();
    const result = await runBenchmark({
      stories: STORIES, models: ["m1"], prompts: PROMPTS,
      outputDir, cachePath: path.join(dir, "cache.sqlite3"),
      openCache: () => broken,
      resolveConfig: RESOLVE_CONFIG, makeClassifier: rec.makeClassifier,
    });
    expect(result).toEqual({ hits: 0, misses: STORIES.length });
    expect(existsSync(path.join(outputDir, "RESULTS.md"))).toBe(true);
  });

  it("live-runner-continues-uncached-when-open-fails", async () => {
    const dir = tempDir("bench-cache-");
    const outputDir = path.join(dir, "out");
    const rec = recordingClassifier();
    const result = await runBenchmark({
      stories: STORIES, models: ["m1"], prompts: PROMPTS,
      outputDir, cachePath: path.join(dir, "cache.sqlite3"),
      openCache: () => null, // DB can't be opened → uncached
      resolveConfig: RESOLVE_CONFIG, makeClassifier: rec.makeClassifier,
    });
    expect(result).toEqual({ hits: 0, misses: 0 });
    expect(rec.calls.length).toBe(STORIES.length);
    expect(existsSync(path.join(outputDir, "RESULTS.md"))).toBe(true);
    expect(existsSync(path.join(outputDir, "RESULTS.csv"))).toBe(true);
  });
});
