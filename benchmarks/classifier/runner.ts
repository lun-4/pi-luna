/**
 * Cache-aware orchestration for the live classifier benchmark.
 *
 * Extraction of the orchestration that used to live inline in
 * `test/benchmark-classifier.test.ts`: classify every corpus story through the
 * real classifier over each `{model × prompt}` combination and write
 * `RESULTS.md` / `RESULTS.csv`. Every dependency is injectable so the whole
 * thing (resume, fail-soft, defaulting, cache failure) is unit-tested offline
 * with a recording fake classifier + a real temp SQLite DB — no network, no
 * paid openrouter calls required to exercise the wiring.
 */

import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ModelRegistryClassifierConfig } from "../../src/parts/classifier.js";
import { buildClassifierThread } from "../../src/parts/classifier.js";
import {
  openBenchCache,
  wrapCache,
  type BenchCache,
  type CacheCfg,
  type ClassifyFn,
} from "./cache.js";

/** Default on-disk cache location (overridable via `BENCH_CACHE_PATH` / inputs.cachePath). */
export const DEFAULT_CACHE_PATH = "benchmarks/classifier/cache.sqlite3";

/** Canonical corpus dir — the only dir that strictly requires a toolCall per story. */
export const DEFAULT_CORPUS_DIR = path.resolve("benchmarks/classifier/corpus");

/** Default RESULTS dir (overridable via `BENCH_OUTPUT_DIR`). */
export const DEFAULT_OUTPUT_DIR = "benchmarks/classifier";

/** A single corpus story — moved here so it's a module-owned, typecheckable contract. */
export interface Story {
  id: string;
  title: string;
  category: string;
  severity: string;
  transcript: { role: string; content: unknown }[];
  targetCommand: string;
  expected: "approve" | "deny";
  rationale: string;
}

export interface PromptSpec {
  name: string;
  body: string;
}

/** Shared (model-agnostic) shape of the config the runner needs to derive a client. */
export interface BenchmarkInputs {
  stories: Story[]; // corpus stories
  models: string[];
  prompts: PromptSpec[];
  /** Full production classifier config per model (modelId, maxTokens, timeoutMs, reasoningEffort?). */
  resolveConfig: (modelId: string) => ModelRegistryClassifierConfig;
  /** The ONE network seam: build a real/fake ClassifierClient for a full config. */
  makeClassifier: (
    cfg: ModelRegistryClassifierConfig,
  ) => { classify: ClassifyFn };
  /** Optional cache opener (default `openBenchCache`) so close-failure/default can be injected. */
  openCache?: (path: string) => BenchCache | null;
  /** Cache DB path. Default: `BENCH_CACHE_PATH` env, else `DEFAULT_CACHE_PATH`. */
  cachePath?: string;
  outputDir: string; // RESULTS.md / RESULTS.csv written here
  concurrency?: number; // default 8
  log?: (line: string) => void;
}

export interface BenchmarkResult {
  hits: number;
  misses: number;
}

// ---------------------------------------------------------------------------
// Small helpers (shared by runner + benchmark test + tests)
// ---------------------------------------------------------------------------

/**
 * Number of `toolCall` blocks each story carries in its (assistant) turns.
 * Pure, so the validator can apply its toolCall guarantee per-story. A story
 * with no assistant turns (like kara's user-only transcripts) yields `0`.
 */
export function toolCallsPerStory(stories: Story[]): number[] {
  return stories.map(
    (s) =>
      s.transcript
        .filter((m) => m.role === "assistant")
        .reduce(
          (n, m) =>
            n +
            (Array.isArray(m.content)
              ? (m.content as { type: string }[]).filter((b) => b.type === "toolCall").length
              : 0),
          0,
        ),
  );
}

/**
 * Should this corpus be required to carry >=1 `toolCall` in every story?
 * Data-adaptive: strictly true for the canonical dir (the synth guarantee stays
 * airtight — a canonical corpus with zero tool calls fails), and true for any
 * corpus in which at least one story already carries a toolCall (so a partially
 * tool-bearing corpus can't go text-only for the rest). A legitimately
 * text-only corpus (kara's source format has no tool calls) passes.
 */
export function shouldRequireToolCalls(corpusDir: string, stories: Story[]): boolean {
  return corpusDir === DEFAULT_CORPUS_DIR || toolCallsPerStory(stories).some((n) => n >= 1);
}

/**
 * RESULTS output dir: `BENCH_OUTPUT_DIR` when set (resolved), else the default
 * `benchmarks/classifier`. Lets kara runs land in their own results dir instead
 * of clobbering the committed canonical `RESULTS.md`/`RESULTS.csv`.
 */
export function benchOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BENCH_OUTPUT_DIR ? path.resolve(env.BENCH_OUTPUT_DIR) : DEFAULT_OUTPUT_DIR;
}

/** Run `fn` over `items` with at most `limit` in flight (results stay in order). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/** Escape one CSV field (quote only when needed). */
function csvField(v: unknown): string {
  const s = String(v ?? "");
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
}

function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

function transcriptToEntries(t: Story["transcript"]): SessionEntry[] {
  return t.map((m, i) => ({
    type: "message",
    id: `s${i}`,
    parentId: i === 0 ? null : `s${i - 1}`,
    timestamp: new Date(i).toISOString(),
    message: { ...m, timestamp: i },
  })) as unknown as SessionEntry[];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Classify every story over each `{model × prompt}` and write
 * `RESULTS.md` / `RESULTS.csv` into `inputs.outputDir`.
 *
 * Cache behavior:
 *  - resolves the cache path as `inputs.cachePath ?? BENCH_CACHE_PATH ?? DEFAULT_CACHE_PATH`
 *    and opens it via `inputs.openCache ?? openBenchCache`; a `null` opener ⇒
 *    uncached.
 *  - each `(model × prompt)` verdict is served from the cache on a hit, and
 *    persisted on a miss, so a rerun reuses prior verdicts (near-zero LLM calls)
 *    and a failed run can resume.
 *  - per-model/per-prompt fail-soft: an unavailable/botched model is reported as
 *    a `### <modelId> — skipped` row and the run continues.
 *  - the whole loop is wrapped so a mid-run failure checkpoints computed entries
 *    and a cache `close()` error never masks results.
 * Returns a `{ hits, misses }` total across all models.
 */
export async function runBenchmark(
  inputs: BenchmarkInputs,
): Promise<BenchmarkResult> {
  const log = inputs.log ?? (() => {});
  const outputDir = inputs.outputDir;
  const outputPath = outputDir.endsWith("/")
    ? `${outputDir}RESULTS.md`
    : `${outputDir}/RESULTS.md`;
  const csvPath = outputDir.endsWith("/")
    ? `${outputDir}RESULTS.csv`
    : `${outputDir}/RESULTS.csv`;

  const cachePath =
    inputs.cachePath ??
    process.env.BENCH_CACHE_PATH ??
    DEFAULT_CACHE_PATH;
  const openCache = inputs.openCache ?? openBenchCache;
  const cache = openCache(cachePath); // null ⇒ uncached
  log(cache ? `cache enabled: ${cachePath}` : `cache disabled (unopenable): ${cachePath}`);

  const stories = inputs.stories;
  const prompts = inputs.prompts;
  const concurrency = Math.max(1, inputs.concurrency ?? 8);

  const rows: string[] = [
    "# Classifier benchmark results",
    "",
    `- corpus: ${stories.length} stories`,
    `- concurrency: ${concurrency} (set BENCH_CONCURRENCY to change)`,
    `- date: ${new Date().toISOString()}`,
    "",
    "| model | prompt | approved | denied | correct | accuracy | tokens (in / out / cacheRead / total) |",
    "|-------|--------|----------|--------|---------|----------|-----------------------------------------|",
  ];
  const csvRows: unknown[][] = [
    [
      "story", "category", "severity", "expected", "got", "pass", "model", "prompt",
      "reason", "input_tokens", "output_tokens", "cache_read_tokens",
      "cache_write_tokens", "total_tokens", "cost_usd",
    ],
  ];

  let totalHits = 0;
  let totalMisses = 0;

  try {
    for (const modelId of inputs.models) {
      const classifierCfg = inputs.resolveConfig(modelId);
      const cacheCfg: CacheCfg = {
        modelId,
        maxTokens: classifierCfg.maxTokens,
        reasoningEffort: classifierCfg.reasoningEffort,
      };
      // Per-model fail-soft: one unavailable/botched model reports a
      // `### <modelId> — skipped` row (checkpointing any verdicts already
      // cached) and the run continues — exactly the current live-bench behavior.
      try {
        const client = inputs.makeClassifier(classifierCfg);
        const classify = wrapCache(
          cache,
          (req, opts) => client.classify(req, opts),
          cacheCfg,
        );

        for (const prompt of prompts) {
          let approved = 0;
          let denied = 0;
          let correct = 0;
          let failed = 0;
          const mistakes: {
            id: string;
            expected: string;
            got: string;
            reason: string;
          }[] = [];
          const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          const reasonOf = (cr: { reason?: string }) => cr.reason ?? "";
          await mapLimit(stories, concurrency, async (s, index) => {
            // A single story must never abort the whole (model × prompt) run.
            // Fail-soft per story: log + record an error row, keep going.
            try {
              const thread = buildClassifierThread(
                transcriptToEntries(s.transcript),
                s.targetCommand,
                { cwd: "/proj" },
              );
              const verdict = await classify(
                {
                  systemPrompt: prompt.body,
                  messages: thread as Message[],
                  targetCommand: s.targetCommand,
                },
                { signal: undefined },
              );
              const got = verdict.approved ? "approve" : "deny";
              const mark = got === s.expected ? "✓" : "✗";
              const u = verdict.usage;
              const tok = u ? ` (${u.input ?? 0}↓/${u.output ?? 0}↑)` : "";
              log(
                `${mark} ${modelId} × ${prompt.name}: ${s.id} → ${got} (expected ${s.expected})${tok}${reasonOf(verdict) ? ` — ${reasonOf(verdict)}` : ""}`,
              );
              csvRows.push([
                s.id, s.category, s.severity, s.expected, got, got === s.expected ? "pass" : "fail",
                modelId, prompt.name, reasonOf(verdict),
                u?.input ?? 0, u?.output ?? 0, u?.cacheRead ?? 0, u?.cacheWrite ?? 0,
                u?.totalTokens ?? 0, (u?.cost?.total ?? 0).toFixed(6),
                `${modelId}|${prompt.name}|${String(index).padStart(3, "0")}`,
              ]);
              if (verdict.approved) approved++;
              else denied++;
              if (u) {
                usage.input += u.input ?? 0;
                usage.output += u.output ?? 0;
                usage.cacheRead += u.cacheRead ?? 0;
                usage.cacheWrite += u.cacheWrite ?? 0;
                usage.total += u.totalTokens ?? 0;
              }
              if (got === s.expected) correct++;
              else mistakes.push({ id: s.id, expected: s.expected, got, reason: reasonOf(verdict) });
            } catch (err) {
              failed++;
              const msg = (err as Error).message ?? String(err);
              log(`✗ ${modelId} × ${prompt.name}: ${s.id} → ERROR — ${msg}`);
              csvRows.push([
                s.id, s.category, s.severity, s.expected, "error", "error",
                modelId, prompt.name, `classify failed: ${msg}`,
                0, 0, 0, 0, 0, "0",
                `${modelId}|${prompt.name}|${String(index).padStart(3, "0")}`,
              ]);
            }
          });
          const acc = (correct / stories.length).toFixed(3);
          const failNote = failed > 0 ? ` (${failed} classify failures)` : "";
          rows.push(
            `| ${modelId} | ${prompt.name} | ${approved} | ${denied} | ${correct} | ${acc}${failNote} | ${usage.input} / ${usage.output} / ${usage.cacheRead} / ${usage.total} |`,
          );
          log(
            `finished ${modelId} × ${prompt.name}: ${correct}/${stories.length} correct (${acc})${failNote} | in=${usage.input} out=${usage.output} total=${usage.total}`,
          );
          if (mistakes.length) {
            rows.push("");
            rows.push(`### ${modelId} × ${prompt.name} — ${mistakes.length} mistakes`);
            for (const m of mistakes) {
              rows.push(`- **${m.id}**: expected ${m.expected}, got ${m.got} — ${m.reason}`);
            }
          }
        }
        totalHits += classify.hits;
        totalMisses += classify.misses;
      } catch (err) {
        rows.push("");
        rows.push(`### ${modelId} — skipped: ${(err as Error).message}`);
        log(`skipping ${modelId}: ${(err as Error).message}`);
      }
    }
  } finally {
    try {
      cache?.close();
    } catch {
      /* close error never masks results */
    }
  }

  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, rows.join("\n") + "\n");
  // Stable CSV: sort test rows by model × prompt × original story order, drop the
  // internal sort key column, then write.
  const header = csvRows[0];
  const dataRows = csvRows.slice(1);
  dataRows.sort((a, b) => String(a[a.length - 1]).localeCompare(String(b[b.length - 1])));
  const csvRowsStripped: unknown[][] = [header, ...dataRows.map((r) => r.slice(0, -1))];
  await writeFile(csvPath, toCsv(csvRowsStripped));
  log(
    `wrote ${outputPath} and ${csvPath}: ${stories.length} stories × ${inputs.models.length} × ${prompts.length}`,
  );

  return { hits: totalHits, misses: totalMisses };
}
