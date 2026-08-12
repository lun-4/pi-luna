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
 *
 * The live orchestration itself lives in `benchmarks/classifier/runner.ts`
 * (`runBenchmark`); its hit/miss/resume/fail-soft behavior is unit-tested
 * offline with a fake classifier + a real temp SQLite DB in
 * `test/classifier-bench-cache.test.ts` — the `it` below is just the real,
 * registry-backed wiring into that orchestration.
 *
 * CACHE: verdicts are stored on-disk keyed by a hash of the request input
 * (see `benchmarks/classifier/cache.ts`), so reruns reuse prior LLM verdicts
 * instead of re-calling the model. The cache DB lives at
 * `benchmarks/classifier/cache.sqlite3` by default, overridable via
 * `BENCH_CACHE_PATH`. The runner logs `[bench] cache: N hits, M misses` after
 * the run.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readdir, readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import {
  buildClassifierThread,
  createModelRegistryClassifier,
} from "../src/parts/classifier.js";
import { buildStories } from "../benchmarks/classifier/synth/generator.mjs";
import { scenarios as synthScenarios } from "../benchmarks/classifier/synth/scenarios/index.mjs";
import {
  runBenchmark,
  benchOutputDir,
  toolCallsPerStory,
  shouldRequireToolCalls,
  DEFAULT_CORPUS_DIR,
  type Story,
} from "../benchmarks/classifier/runner.js";
const CANDIDATE_DIR = path.resolve("benchmarks/classifier/candidate-prompts");
const PRODUCTION_PROMPT = path.resolve("src/parts/classifier-prompt.md");
const RESULTS = path.resolve("benchmarks/classifier/RESULTS.md");
const RESULTS_CSV = path.resolve("benchmarks/classifier/RESULTS.csv");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .map((c) => (c.type === "text" ? c.text ?? "" : ""))
      .join("");
  }
  return String(content);
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
 * at a staging corpus via BENCH_CORPUS_DIR **or** BENCH_DIRECTORY (the kara
 * alias) without touching the canonical `corpus/`. BENCH_CORPUS_DIR wins when
 * both are set (default: benchmarks/classifier/corpus).
 */
function corpusDir(): string {
  const dir = process.env.BENCH_CORPUS_DIR ?? process.env.BENCH_DIRECTORY;
  return dir ? path.resolve(dir) : DEFAULT_CORPUS_DIR;
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
    // Data-adaptive toolCall guarantee: strictly required for the canonical dir
    // (a canonical corpus with zero tool calls must fail — it cannot silently
    // regress to all-text), and required in every story whenever ANY story in
    // the corpus already carries a toolCall. A legitimately text-only corpus
    // (kara's source format has no tool calls) passes without fabrication.
    if (shouldRequireToolCalls(corpusDir(), stories)) {
      expect(toolCallsPerStory(stories).every((n) => n >= 1)).toBe(true);
    }
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

  it("honors BENCH_DIRECTORY as an alias for BENCH_CORPUS_DIR", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "bench-dir-"));
    const story = {
      id: "dir-alias-probe",
      title: "probe",
      category: "benign",
      severity: "info",
      transcript: [{ role: "user", content: "probe" }],
      targetCommand: "true",
      expected: "approve",
      rationale: "probe",
    };
    await writeFile(path.join(tmp, "dir-alias-probe.json"), JSON.stringify(story));
    vi.stubEnv("BENCH_DIRECTORY", tmp);
    // Clear BENCH_CORPUS_DIR (undefined removes the var) so the alias fallback is
    // actually exercised regardless of any externally-set BENCH_CORPUS_DIR.
    vi.stubEnv("BENCH_CORPUS_DIR", undefined);
    try {
      const loaded = await loadStories();
      expect(loaded.map((s) => s.id)).toEqual(["dir-alias-probe"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives BENCH_CORPUS_DIR precedence over BENCH_DIRECTORY (a precedence regression must fail)", async () => {
    const a = await mkdtemp(path.join(os.tmpdir(), "bench-cd-"));
    const b = await mkdtemp(path.join(os.tmpdir(), "bench-dir-"));
    const mk = (dir: string, id: string) =>
      writeFile(path.join(dir, `${id}.json`), JSON.stringify({
        id, title: "probe", category: "benign", severity: "info",
        transcript: [{ role: "user", content: "probe" }],
        targetCommand: "true", expected: "approve", rationale: "probe",
      }));
    await mk(a, "from-corpus-dir");
    await mk(b, "from-directory");
    vi.stubEnv("BENCH_CORPUS_DIR", a);
    vi.stubEnv("BENCH_DIRECTORY", b);
    try {
      const loaded = await loadStories();
      expect(loaded.map((s) => s.id)).toEqual(["from-corpus-dir"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses benchOutputDir() for the live runner so BENCH_OUTPUT_DIR is honored", () => {
    vi.stubEnv("BENCH_OUTPUT_DIR", "benchmarks/classifier/kara-results");
    try {
      expect(benchOutputDir()).toBe(path.resolve("benchmarks/classifier/kara-results"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Live runner (gated) — thin wiring into runBenchmark()
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
  // 5s default. Give it generous headroom. The on-disk cache makes reruns fast.
  it("classifies every story over each model × prompt and writes RESULTS.md (cached)", async () => {
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

    // Auth diagnostic — confirms which env var / credential the provider is using.
    const hasKeyEnv = !!process.env.OPENROUTER_API_KEY;
    log(`auth source: ${hasKeyEnv ? "env-first: OPENROUTER_API_KEY (stored pi auth.json credential bypassed)" : "pi's stored credential (auth.json), env var absent"}`);
    for (const modelId of models) {
      const m = registry.find("openrouter", modelId);
      log(`model ${modelId}: ${m ? "found" : "NOT FOUND"} | hasConfiguredAuth=${m ? registry.hasConfiguredAuth(m) : false}`);
    }

    const result = await runBenchmark({
      stories,
      models,
      prompts,
      outputDir: benchOutputDir(),
      concurrency: Math.max(1, Number(process.env.BENCH_CONCURRENCY ?? 8)),
      cachePath: process.env.BENCH_CACHE_PATH ?? "benchmarks/classifier/cache.sqlite3",
      resolveConfig: (modelId) => {
        const isGptOss = modelId === "openai/gpt-oss-120b" || modelId === "openai/gpt-oss-20b";
        return {
          modelId,
          maxTokens: isGptOss ? 1_024 : 256,
          timeoutMs: 60_000,
          ...(isGptOss ? { reasoningEffort: "low" as const } : {}),
        };
      },
      makeClassifier: (cfg) => createModelRegistryClassifier(cfg)(registry, "/proj"),
      log,
    });
    log(`cache: ${result.hits} hits, ${result.misses} misses`);
  }, 600_000);
});
