#!/usr/bin/env node

const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731";
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const includeRouting = args.includes("--include-routing");
const concurrencyArg = args.find((arg) => arg.startsWith("--concurrency="));
const concurrency = Math.max(1, Number(concurrencyArg?.split("=")[1]) || 8);
const modelArg = args.find((arg) => !arg.startsWith("--"));
const baselineId = modelArg || DEFAULT_MODEL;

function price(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function endpointCost(endpoint) {
  const prompt = price(endpoint.pricing?.prompt);
  const completion = price(endpoint.pricing?.completion);
  if (prompt === null || completion === null) return null;
  return { prompt, completion, total: prompt + completion };
}

async function getJson(path) {
  const url = path.startsWith("/api/v1/") ? `https://openrouter.ai${path}` : `${BASE_URL}${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function mapConcurrent(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        console.error(`warning: ${items[index].id}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results.filter(Boolean);
}

function dollarsPerMillion(value) {
  return `$${(value * 1e6).toFixed(value < 0.000001 ? 3 : 2)}`;
}

const { data: models } = await getJson("/models");
const baseline = models.find((model) => model.id === baselineId);
if (!baseline) {
  console.error(`Model not found: ${baselineId}`);
  process.exit(1);
}

const baselineDetails = await getJson(
  baseline.links?.details || `/models/${encodeURIComponent(baseline.canonical_slug || baseline.id)}/endpoints`,
);
const baselineEndpoints = (baselineDetails.data?.endpoints || [])
  .map((endpoint) => ({ endpoint, cost: endpointCost(endpoint) }))
  .filter(({ cost }) => cost);
const baselineCost = baselineEndpoints.sort((a, b) => a.cost.total - b.cost.total)[0]?.cost;
if (!baselineCost) throw new Error(`No usable pricing endpoints for ${baselineId}`);

const candidates = models.filter((model) => {
  if (model.id === baselineId) return false;
  if (!includeRouting && model.id.startsWith("openrouter/")) return false;
  return model.architecture?.modality === "text->text";
});

const detailed = await mapConcurrent(candidates, async (model) => {
  const details = await getJson(
    model.links?.details || `/models/${encodeURIComponent(model.canonical_slug || model.id)}/endpoints`,
  );
  const endpoints = (details.data?.endpoints || [])
    .map((endpoint) => ({ endpoint, cost: endpointCost(endpoint) }))
    .filter(({ cost }) => cost);
  const cheaper = endpoints
    .filter(({ cost }) => cost.prompt < baselineCost.prompt && cost.completion < baselineCost.completion)
    .sort((a, b) => a.cost.total - b.cost.total);
  if (!cheaper.length) return null;
  const providers = new Set(endpoints.map(({ endpoint }) => endpoint.provider_name).filter(Boolean));
  const best = cheaper[0];
  return {
    id: model.id,
    name: model.name,
    providers: providers.size,
    providerNames: [...providers].sort(),
    prompt: best.cost.prompt,
    completion: best.cost.completion,
    total: best.cost.total,
    provider: best.endpoint.provider_name || best.endpoint.tag || "?",
    contextLength: model.context_length,
  };
});

detailed.sort((a, b) => b.providers - a.providers || a.total - b.total || a.id.localeCompare(b.id));

if (jsonOutput) {
  console.log(JSON.stringify({ baseline: { id: baselineId, ...baselineCost }, models: detailed }, null, 2));
} else {
  console.log(`Baseline: ${baselineId} (best endpoint ${dollarsPerMillion(baselineCost.prompt)} input + ${dollarsPerMillion(baselineCost.completion)} output per 1M tokens)`);
  console.log(`Found ${detailed.length} cheaper text models. Sorted by provider count (desc), then blended cost (asc).`);
  console.log("\n| model | providers | input / 1M | output / 1M | blended / 1M | cheapest provider |");
  console.log("|---|---:|---:|---:|---:|---|");
  for (const model of detailed) {
    console.log(`| ${model.id} | ${model.providers} | ${dollarsPerMillion(model.prompt)} | ${dollarsPerMillion(model.completion)} | ${dollarsPerMillion(model.total)} | ${model.provider} |`);
  }
}
