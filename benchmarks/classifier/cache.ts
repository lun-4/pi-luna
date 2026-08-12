/**
 * On-disk SQLite cache for the live classifier benchmark.
 *
 * Every `(model × prompt × story)` LLM verdict is stored keyed by a sha256 of
 * the output-determining request bytes, so repeated `bench:classifier` runs
 * reuse prior verdicts instead of re-calling the LLM — turning the multi-minute
 * rerun into a near-instant one and letting a failed run resume where it left
 * off. The cache intentionally degrades to "uncached" (never fails the run): any
 * open/get/set/close failure is swallowed by the call sites.
 *
 * Built on `node:sqlite` (DatabaseSync). STRICT tables, full sqlite-guidelines
 * pragma set, prepared statements, `BEGIN IMMEDIATE` transactions.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  ClassifierRequest,
  ClassifierVerdict,
  ModelRegistryClassifierConfig,
} from "../../src/parts/classifier.js";
import type { Message } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Seam / interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow cache contract so the runner and tests can inject a recorded or
 * throwing stub type-safely without touching the real SQLite implementation.
 */
export interface BenchCache {
  get(key: string): ClassifierVerdict | undefined;
  set(key: string, verdict: ClassifierVerdict): void;
  close(): void;
}

/** Exactly the fields that determine the LLM's output, and thus the cache key. */
export interface CacheKeyInput {
  modelId: string;
  maxTokens: number;
  /**
   * Production union: "minimal" | "low" | "medium" | "high" | "xhigh" | "max".
   * Nullable so JSON serialization is stable whether or not a model sets it.
   */
  reasoningEffort?: ModelRegistryClassifierConfig["reasoningEffort"];
  systemPrompt: string; // deterministic prompt body
  targetCommand: string;
  thread: Message[];
}

/** Output-determining subset of the classifier config — what the key is built from. */
export type CacheCfg = Pick<
  ModelRegistryClassifierConfig,
  "modelId" | "maxTokens" | "reasoningEffort"
>;

// ---------------------------------------------------------------------------
// SQLite-backed cache
// ---------------------------------------------------------------------------

const CREATE_TABLE = /* sql */ `
  CREATE TABLE IF NOT EXISTS classifier_bench (
    key        TEXT PRIMARY KEY,
    output     TEXT NOT NULL,   -- JSON of ClassifierVerdict
    created_at INTEGER NOT NULL
  ) STRICT
`;

export class BenchClassifierCache implements BenchCache {
  readonly path: string;
  private db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    const db = new DatabaseSync(path);
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA cache_size = -6000");
    db.exec("PRAGMA foreign_keys = true");
    db.exec("PRAGMA temp_store = memory");
    db.exec(CREATE_TABLE);
  }

  get(key: string): ClassifierVerdict | undefined {
    const row = this.db
      .prepare("SELECT output FROM classifier_bench WHERE key = ?")
      .get(key) as { output: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.output) as ClassifierVerdict;
  }

  set(key: string, verdict: ClassifierVerdict): void {
    // BEGIN IMMEDIATE so the upsert is a single atomic unit; roll back (never
    // leave a partial row) if anything in the transaction throws.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO classifier_bench (key, output, created_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET output=excluded.output, created_at=excluded.created_at`,
        )
        .run(key, JSON.stringify(verdict), Date.now());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Read one scalar pragma value back from the live connection (test/support use).
   *  Returns the scalar (e.g. busy_timeout → 5000, journal_mode → "wal"). */
  pragmaValue(pragma: string): unknown {
    const row = this.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
    return Object.values(row)[0];
  }

  /** Idempotent and non-throwing: a repeated/errant close never fails the bench. */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed / close failure — fail-soft */
    }
  }
}

/**
 * Fail-soft open boundary the runner relies on. Returns `null` (never throws)
 * when the DB can't be created — the bench then runs uncached end to end.
 */
export function openBenchCache(path: string): BenchClassifierCache | null {
  try {
    return new BenchClassifierCache(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Deterministic sha256 over the output-determining fields of a request.
 *
 * Only what the model actually sees and the config that shapes its output
 * participate: model, maxTokens, reasoningEffort, systemPrompt, targetCommand,
 * and each message's `role` + full `content`. Every other field — `timestamp`,
 * `id`, `api`, `provider`, `usage`, `stopReason`, etc. — is runtime bookkeeping
 * that does not reach the model, so it is projected away here. This keeps keys
 * stable across runs (the thread builder stamps `Date.now()` on the final
 * permission-request message) while invalidating naturally when the prompt, a
 * corpus story, or model config changes.
 */
export function cacheKey(input: CacheKeyInput): string {
  const normalized = {
    modelId: input.modelId,
    maxTokens: input.maxTokens,
    reasoningEffort: input.reasoningEffort ?? null,
    systemPrompt: input.systemPrompt,
    targetCommand: input.targetCommand,
    // Project each message down to (role, content) — recursively keeping every
    // content-block field (text, tool-call id/name/arguments, thinking, image)
    // while dropping all non-content runtime fields.
    thread: input.thread.map(({ role, content }) => ({ role, content })),
  };
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Cached classify seam
// ---------------------------------------------------------------------------

export type ClassifyFn = (
  req: ClassifierRequest,
  opts?: { signal?: AbortSignal },
) => Promise<ClassifierVerdict>;

export interface CachedClassify extends ClassifyFn {
  hits: number;
  misses: number;
}

/**
 * Injectable seam: consults the cache and only calls `classify` (the network
 * call) on a miss, persisting every verdict it produces. Fail-soft — a throwing
 * cache read/write degrades to a miss / a non-persisted call, never an error
 * the bench can't absorb. `cache === null` is a plain passthrough.
 */
export function wrapCache(
  cache: BenchCache | null,
  classify: ClassifyFn,
  cfg: CacheCfg,
): CachedClassify {
  const result = (async (
    req: ClassifierRequest,
    opts?: { signal?: AbortSignal },
  ) => {
    if (!cache) return classify(req, opts);
    const key = cacheKey({
      modelId: cfg.modelId,
      maxTokens: cfg.maxTokens,
      reasoningEffort: cfg.reasoningEffort,
      systemPrompt: req.systemPrompt,
      targetCommand: req.targetCommand,
      thread: req.messages,
    });
    let cached: ClassifierVerdict | undefined;
    try {
      cached = cache.get(key);
    } catch {
      cached = undefined; // a throwing read is a miss
    }
    if (cached !== undefined) {
      result.hits++;
      return cached;
    }
    const verdict = await classify(req, opts);
    result.misses++;
    try {
      cache.set(key, verdict);
    } catch {
      /* persist failure is non-fatal — fail-soft */
    }
    return verdict;
  }) as CachedClassify;
  result.hits = 0;
  result.misses = 0;
  return result;
}
