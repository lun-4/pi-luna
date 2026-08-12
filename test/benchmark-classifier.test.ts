/**
 * Classifier benchmark suite.
 *
 * Two layers:
 *  1. OFFLINE VALIDATOR (always runs): loads every corpus/*.json story, checks
 *     its schema (expected ∈ {approve,deny}), verifies the redaction invariant
 *     (no toolResult in any transcript) and that each story round-trips through
 *     the product's own buildClassifierThread unchanged (plus the final
 *     permission request). This catches corpus/story authoring bugs with no I/O.
 *  2. LIVE RUNNER (only when RUN_BENCHMARK=1 AND the runtime has openrouter
 *     auth): classifies every story through the *real* createModelRegistryClassifier
 *     (the exact production code path) over each {model × prompt} combination
 *     and writes RESULTS.md. Fail-safe: if no auth is configured it reports and
 *     skips rather than failing.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readdir, readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message, CredentialStore } from "@earendil-works/pi-ai";
import {
  buildClassifierThread,
  createModelRegistryClassifier,
} from "../src/parts/classifier.js";
import { buildStories } from "../benchmarks/classifier/synth/generator.mjs";
import { scenarios as synthScenarios } from "../benchmarks/classifier/synth/scenarios/index.mjs";

const DEFAULT_CORPUS_DIR = path.resolve("benchmarks/classifier/corpus");
const CANDIDATE_DIR = path.resolve("benchmarks/classifier/candidate-prompts");
const PRODUCTION_PROMPT = path.resolve("src/parts/classifier-prompt.md");
const RESULTS = path.resolve("benchmarks/classifier/RESULTS.md");
const RESULTS_CSV = path.resolve("benchmarks/classifier/RESULTS.csv");

interface Story {
  id: string;
  title: string;
  category: string;
  severity: string;
  transcript: { role: string; content: unknown }[];
  targetCommand: string;
  expected: "approve" | "deny";
  rationale: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .map((c) => (c.type === "text" ? c.text ?? "" : ""))
      .join("");
  }
  return String(content);
}

/** Run `fn` over `items` with at most `limit` in flight (results stay in order). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
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

/**
 * Corpus directory, read lazily at call time so a test can point the validator
 * at a staging corpus via BENCH_CORPUS_DIR without touching the canonical
 * `corpus/` (default: benchmarks/classifier/corpus).
 */
function corpusDir(): string {
  return process.env.BENCH_CORPUS_DIR ? path.resolve(process.env.BENCH_CORPUS_DIR) : DEFAULT_CORPUS_DIR;
}

async function loadStories(): Promise<Story[]> {
  const dir = corpusDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const stories: Story[] = [];
  for (const f of files) {
    stories.push(JSON.parse(await readFile(path.join(dir, f), "utf8")));
  }
  return stories.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// 1. Offline validator
// ---------------------------------------------------------------------------

describe("benchmark corpus validator", () => {
  let stories: Story[] = [];
  beforeAll(async () => {
    stories = await loadStories();
  });

  it("has at least 20 stories", () => {
    expect(stories.length).toBeGreaterThanOrEqual(20);
  });

  it.each(stories.map((s) => [s.id, s] as const))("%s is a well-formed story", (_id, s) => {
    expect(typeof s.title).toBe("string");
    expect(typeof s.category).toBe("string");
    expect(["approve", "deny"]).toContain(s.expected);
    expect(typeof s.targetCommand).toBe("string");
    expect(Array.isArray(s.transcript)).toBe(true);
    expect(s.transcript.length).toBeGreaterThan(0);
    for (const m of s.transcript) {
      expect(["user", "assistant"]).toContain(m.role);
    }
    expect(typeof s.rationale).toBe("string");
  });

  it("every story is fully redacted — no toolResult, no tool output (invariant)", () => {
    for (const s of stories) {
      for (const m of s.transcript) {
        expect(m.role, `story ${s.id} has role ${m.role}`).not.toBe("toolResult");
        expect(m.role, `story ${s.id} has role ${m.role}`).not.toBe("bashExecution");
      }
    }
  });

  it("every story round-trips through buildClassifierThread unchanged (+ final request)", () => {
    for (const s of stories) {
      const thread = buildClassifierThread(
        transcriptToEntries(s.transcript),
        s.targetCommand,
        { cwd: "/proj" },
      );
      // All transcript messages preserved, in order, then exactly one appended.
      expect(thread.length, `story ${s.id}`).toBe(s.transcript.length + 1);
      s.transcript.forEach((m, i) => {
        expect(thread[i].role, `story ${s.id} msg ${i} role`).toBe(m.role);
        expect(
          textOf(thread[i].content),
          `story ${s.id} msg ${i} content`,
        ).toBe(textOf(m.content));
      });
      // Final appended message carries the verbatim command + cwd (as in prod).
      const last = textOf(thread[thread.length - 1].content);
      expect(last).toContain(s.targetCommand);
      expect(last).toContain("/proj");
    }
  });

  it("preserves assistant toolCall blocks (id/name/arguments) through buildClassifierThread", () => {
    // The corpus uses real toolCall blocks (no toolResult) — exactly the view
    // buildClassifierThread feeds the model. Assert they round-trip verbatim.
    const allCalls = stories.flatMap((s) =>
      s.transcript
        .filter((m) => m.role === "assistant")
        .flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "toolCall") : [])),
    );
    // Every story must show real tool work (>=1 toolCall each).
    expect(allCalls.length).toBeGreaterThanOrEqual(stories.length);
    for (const s of stories) {
      const thread = buildClassifierThread(transcriptToEntries(s.transcript), s.targetCommand, { cwd: "/proj" });
      const srcAsst = s.transcript.filter((m) => m.role === "assistant");
      const dstAsst = thread.filter((t) => t.role === "assistant");
      expect(dstAsst.length, `story ${s.id} assistant count`).toBe(srcAsst.length);
      srcAsst.forEach((m, i) => {
        const srcBlocks = Array.isArray(m.content) ? (m.content as { type: string; id?: string; name?: string; arguments?: unknown }[]) : [];
        const dstBlocks = Array.isArray(dstAsst[i].content) ? (dstAsst[i].content as { type: string; id?: string; name?: string; arguments?: unknown }[]) : [];
        expect(dstBlocks.length, `story ${s.id} msg ${i} block count`).toBe(srcBlocks.length);
        srcBlocks.forEach((b, j) => {
          expect(dstBlocks[j].type).toBe(b.type);
          if (b.type === "toolCall") {
            expect(dstBlocks[j].id, `story ${s.id} toolCall ${j} id`).toBe(b.id);
            expect(dstBlocks[j].name, `story ${s.id} toolCall ${j} name`).toBe(b.name);
            expect(JSON.stringify(dstBlocks[j].arguments), `story ${s.id} toolCall ${j} args`).toBe(JSON.stringify(b.arguments));
          }
        });
      });
    }
  });

  it("generation is order-independent: permuted scenario orders yield equal sorted story sets (AC.5)", () => {
    const a = buildStories(synthScenarios, { seed: 42 });
    const b = buildStories([...synthScenarios].reverse(), { seed: 42 });
    // Registry order affects emission order only, so canonicalize by sorting by id.
    const norm = (r: { stories: Story[] }) =>
      r.stories.map((s) => ({ id: s.id, content: JSON.stringify(s) })).sort((x, y) => x.id.localeCompare(y.id));
    expect(norm(a as any)).toEqual(norm(b as any));
  });

  it("has a mix of categories and both verdicts", () => {
    const cats = new Set(stories.map((s) => s.category));
    expect(cats.size).toBeGreaterThanOrEqual(6);
    expect(stories.some((s) => s.expected === "approve")).toBe(true);
    expect(stories.some((s) => s.expected === "deny")).toBe(true);
  });

  it("honors BENCH_CORPUS_DIR so a staging corpus can be validated without touching corpus/", async () => {
    // Because corpusDir() is read lazily inside loadStories(), pointing the
    // env var at a temp dir makes the real validator run against that set.
    const tmp = await mkdtemp(path.join(os.tmpdir(), "bench-corpus-"));
    const story = {
      id: "env-override-probe",
      title: "probe",
      category: "benign",
      severity: "info",
      transcript: [{ role: "user", content: "probe" }],
      targetCommand: "true",
      expected: "approve",
      rationale: "probe",
    };
    await writeFile(path.join(tmp, "env-override-probe.json"), JSON.stringify(story));
    vi.stubEnv("BENCH_CORPUS_DIR", tmp);
    try {
      const loaded = await loadStories();
      expect(loaded.map((s) => s.id)).toEqual(["env-override-probe"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Live runner (gated)
// ---------------------------------------------------------------------------

async function loadPrompts(): Promise<{ name: string; body: string }[]> {
  const prompts: { name: string; body: string }[] = [
    { name: "production", body: await readFile(PRODUCTION_PROMPT, "utf8") },
  ];
  const cands = (await readdir(CANDIDATE_DIR)).filter((f) => f.endsWith(".md"));
  for (const c of cands) {
    prompts.push({ name: path.basename(c, ".md"), body: await readFile(path.join(CANDIDATE_DIR, c), "utf8") });
  }
  return prompts;
}

const live = process.env.RUN_BENCHMARK === "1";
describe.skipIf(!live)("live classifier benchmark", () => {
  // 34 stories × N prompts × M models of network calls — far beyond vitest's
  // 5s default. Give it generous headroom.
  it("classifies every story over each model × prompt and writes RESULTS.md", async () => {
    const log = (line: string) => {
      // Stream to stderr so progress shows live even while the result buffers.
      process.stderr.write(`[bench] ${line}\n`);
    };
    const stories = await loadStories();
    const prompts = await loadPrompts();
    const models = (process.env.BENCH_MODELS ?? [
      "deepseek/deepseek-v4-flash-0731",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "meta-llama/llama-3.1-8b-instruct",
      "mistralai/mistral-nemo",
    ].join(","))
      .split(",").map((s) => s.trim()).filter(Boolean);

    // Build the real runtime + registry (production-compatible path).
    // refreshOnCreate MUST stay on (not false): the availability refresh is
    // what populates `configuredProviders`, which `hasConfiguredAuth` reads.
    // allowModelNetwork lets the remote catalog pull the exact model id. Both
    // need network, which the live benchmark inherently requires anyway.
    //
    // Env-first auth: pi-ai's provider `resolve()` returns the STORED
    // credential (pi's auth.json) before ever reading OPENROUTER_API_KEY. To
    // make the env var win, inject an empty store when it is set so there is
    // no stored credential to shadow it. When it isn't set, fall through to
    // pi's default credential store.
    const emptyCredentialStore: CredentialStore = {
      read: async () => undefined,
      list: async () => [],
      modify: async (_providerId, fn) => fn(undefined),
      delete: async () => {},
    };
    let registry: ModelRegistry;
    try {
      const modelsPath = process.env.BENCH_MODELS_PATH ?? path.join(os.homedir(), ".pi/agent/models.json");
      const runtime = await ModelRuntime.create({
        modelsPath,
        allowModelNetwork: true,
        refreshOnCreate: true,
        credentials: process.env.OPENROUTER_API_KEY ? emptyCredentialStore : undefined,
      });
      registry = new ModelRegistry(runtime);
    } catch (err) {
      console.log(`[bench] could not build ModelRuntime/registry, skipping live run: ${(err as Error).message}`);
      return;
    }

    const rows: string[] = [];
    const csvRows: unknown[][] = [
      ["story", "category", "severity", "expected", "got", "pass", "model", "prompt", "reason", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens", "cost_usd"],
    ];
    rows.push("# Classifier benchmark results");
    rows.push("");
    rows.push(`- corpus: ${stories.length} stories`);
    rows.push(`- concurrency: ${process.env.BENCH_CONCURRENCY ?? "8"} (set BENCH_CONCURRENCY to change)`);
    rows.push(`- date: ${new Date().toISOString()}`);
    rows.push("");
    rows.push("| model | prompt | approved | denied | correct | accuracy | tokens (in / out / cacheRead / total) |");
    rows.push("|-------|--------|----------|--------|---------|----------|-----------------------------------------|");

    // Auth diagnostic — confirms which env var / credential the provider is using.
    const hasKeyEnv = !!process.env.OPENROUTER_API_KEY;
    log(`auth source: ${hasKeyEnv ? "env-first: OPENROUTER_API_KEY (stored pi auth.json credential bypassed)" : "pi's stored credential (auth.json), env var absent"}`);
    for (const modelId of models) {
      const m = registry.find("openrouter", modelId);
      log(`model ${modelId}: ${m ? "found" : "NOT FOUND"} | hasConfiguredAuth=${m ? registry.hasConfiguredAuth(m) : false}`);
    }

    const concurrency = Math.max(1, Number(process.env.BENCH_CONCURRENCY ?? 8));

    for (const modelId of models) {
      // GPT-OSS is a reasoning model. Give it enough room to reason and emit
      // the forced tool call; with the generic 256-token budget it can end in
      // stopReason=error before producing a verdict.
      const isGptOss = modelId === "openai/gpt-oss-120b" || modelId === "openai/gpt-oss-20b";
      // Fail-soft per model: if auth isn't configured or the model can't be
      // found, report and move on instead of failing the whole benchmark run.
      try {
        const client = createModelRegistryClassifier({
          modelId,
          maxTokens: isGptOss ? 1_024 : 256,
          timeoutMs: 60_000,
          ...(isGptOss ? { reasoningEffort: "low" as const } : {}),
        })(registry, "/proj");
        for (const prompt of prompts) {
          let approved = 0;
          let denied = 0;
          let correct = 0;
          const mistakes: { id: string; expected: string; got: string; reason: string }[] = [];
          const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          // Stories within a (model × prompt) run concurrently (bounded).
          await mapLimit(stories, concurrency, async (s, index) => {
            const thread = buildClassifierThread(
              transcriptToEntries(s.transcript),
              s.targetCommand,
              { cwd: "/proj" },
            );
            const verdict = await client.classify(
              { systemPrompt: prompt.body, messages: thread as Message[], targetCommand: s.targetCommand },
              { signal: undefined },
            );
            const got = verdict.approved ? "approve" : "deny";
            const mark = got === s.expected ? "✓" : "✗";
            const u = verdict.usage;
            const tok = u ? ` (${u.input ?? 0}↓/${u.output ?? 0}↑)` : "";
            log(`${mark} ${modelId} × ${prompt.name}: ${s.id} → ${got} (expected ${s.expected})${tok}${verdict.reason ? ` — ${verdict.reason}` : ""}`);
            // One CSV row per test, with real usage + cost from the response.
            csvRows.push([
              s.id, s.category, s.severity, s.expected, got, got === s.expected ? "pass" : "fail",
              modelId, prompt.name, verdict.reason ?? "",
              u?.input ?? 0, u?.output ?? 0, u?.cacheRead ?? 0, u?.cacheWrite ?? 0, u?.totalTokens ?? 0,
              (u?.cost?.total ?? 0).toFixed(6),
              // original story order within this (model × prompt) for stable sort
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
            else mistakes.push({ id: s.id, expected: s.expected, got, reason: verdict.reason ?? "" });
          });
          const acc = (correct / stories.length).toFixed(3);
          rows.push(`| ${modelId} | ${prompt.name} | ${approved} | ${denied} | ${correct} | ${acc} | ${usage.input} / ${usage.output} / ${usage.cacheRead} / ${usage.total} |`);
          log(`finished ${modelId} × ${prompt.name}: ${correct}/${stories.length} correct (${acc}) | in=${usage.input} out=${usage.output} total=${usage.total}`);
          if (mistakes.length) {
            rows.push("");
            rows.push(`### ${modelId} × ${prompt.name} — ${mistakes.length} mistakes`);
            for (const m of mistakes) {
              rows.push(`- **${m.id}**: expected ${m.expected}, got ${m.got} — ${m.reason}`);
            }
          }
        }
      } catch (err) {
        rows.push("");
        rows.push(`### ${modelId} — skipped: ${(err as Error).message}`);
        log(`skipping ${modelId}: ${(err as Error).message}`);
      }
    }

    await mkdir(path.dirname(RESULTS), { recursive: true });
    await writeFile(RESULTS, rows.join("\n") + "\n");
    // Stable CSV: sort test rows by model × prompt × original story order,
    // drop the internal sort key column, then write.
    const header = csvRows[0];
    const dataRows = csvRows.slice(1);
    dataRows.sort((a, b) => String(a[a.length - 1]).localeCompare(String(b[b.length - 1])));
    const csvRowsStripped: unknown[][] = [header, ...dataRows.map((r) => r.slice(0, -1))];
    await writeFile(RESULTS_CSV, toCsv(csvRowsStripped));
    // Surface the summary in the test log.
    log(`wrote ${RESULTS} and ${RESULTS_CSV}: ${stories.length} stories × ${models.length} × ${prompts.length}`);
  }, 600_000);
});