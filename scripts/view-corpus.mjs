#!/usr/bin/env node
/**
 * Render every transcript in a classifier corpus dir into a single, self-
 * contained HTML file for quick eyeballing (no browser dev server needed).
 *
 * Usage:
 *   node scripts/view-corpus.mjs [--dir <corpus-dir>] [--out <html-path>]
 *
 * Defaults:
 *   --dir  benchmarks/classifier/corpus   (the canonical generated corpus)
 *   --out  benchmarks/classifier/corpus-view.html
 *
 * Each story is rendered as a card with: a verdict/category/severity header,
 * the full transcript (user messages vs. assistant tool-call blocks, with the
 * toolCall arguments highlighted), the target command being classified, and
 * its rationale. Filtering (verdict/category), a "tool calls only" toggle, and
 * free-text search happen client-side with zero dependencies.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const corpusDir = path.resolve(arg("--dir") ?? path.join(REPO_ROOT, "benchmarks/classifier/corpus"));
const outPath = path.resolve(arg("--out") ?? path.join(REPO_ROOT, "benchmarks/classifier/corpus-view.html"));

const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".json"));
const stories = [];
for (const f of files) {
  stories.push(JSON.parse(await readFile(path.join(corpusDir, f), "utf8")));
}
stories.sort((a, b) => a.id.localeCompare(b.id));

// Escape for embedding inside a <script> block (< & > only; quotes are safe there).
const json = JSON.stringify(stories)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Classifier corpus viewer — ${stories.length} stories</title>
<style>
  :root {
    --bg: #12141a; --panel: #1b1e27; --line: #2a2e3b; --text: #e6e8ee; --muted: #9aa0b0;
    --approve: #2e9e5b; --deny: #d64541; --accent: #7aa2f7; --tool-border: #374a9e;
    --user-bg: #232838;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
  header { position: sticky; top: 0; z-index: 5; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 12px 20px; }
  header h1 { margin: 0; font-size: 15px; }
  header .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .controls { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
  .controls input, .controls select, .controls label {
    background: var(--panel); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 8px; font-size: 13px; font-family: inherit; }
  .controls input { flex: 1 1 240px; }
  .controls label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  main { padding: 16px 20px 60px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    margin-bottom: 16px; overflow: hidden; }
  .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .card-head .id { font-weight: 700; font-size: 13px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; text-transform: uppercase; }
  .b-approve { background: var(--approve); color: #fff; }
  .b-deny { background: var(--deny); color: #fff; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); color: var(--muted); }
  .card-body { padding: 12px 14px; }
  .cmd { background: #0e1016; border: 1px solid var(--accent); border-radius: 8px;
    padding: 8px 12px; margin-bottom: 12px; font-size: 13px; }
  .cmd .lbl { color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin-right: 8px; }
  .msgs { display: flex; flex-direction: column; gap: 6px; }
  .msg { margin: 0; padding: 8px 10px; border-radius: 8px; }
  .msg .who { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; display: block; }
  .msg.user { background: var(--user-bg); }
  .msg.user .who { color: var(--accent); }
  .msg.asst { background: transparent; border-left: 2px solid var(--tool-border); }
  .msg.asst .who { color: var(--muted); }
  .tool { font-size: 12px; }
  .tool .tname { color: #ffd75e; font-weight: 700; }
  .rationale { margin-top: 10px; color: var(--muted); font-size: 12px; font-style: italic; }
  details.raw { margin-top: 12px; }
  details.raw summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  details.raw pre { background: #0e1016; border-radius: 8px; padding: 10px; overflow-x: auto;
    color: var(--muted); font-size: 11px; display: none; }
  details.raw[open] pre { display: block; }
</style>
</head>
<body>
<header>
  <h1>Classifier corpus viewer</h1>
  <div class="meta" id="meta"></div>
  <div class="controls">
    <input id="search" type="search" placeholder="Search stories (id, text, tool, command, category)…" autofocus>
    <select id="verdict">
      <option value="">verdict: all</option>
      <option value="approve">approve only</option>
      <option value="deny">deny only</option>
    </select>
    <select id="category"><option value="">category: all</option></select>
    <label><input type="checkbox" id="onlyTools"> tool calls only?</label>
    <label><input type="checkbox" id="expandJson"> show all JSON?</label>
  </div>
</header>
<main id="main"></main>
<script>
const STORIES = ${json};
const $ = (sel) => document.querySelector(sel);

// Escape for HTML text and attribute context (quotes included so this is safe
// inside data-* attribute values too).
const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function argsInline(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'edits' && Array.isArray(v)) {
      parts.push('edits=[' + v.map(e => esc(e.oldText) + ' \\u2192 ' + esc(e.newText)).join('; ') + ']');
    } else {
      parts.push(k + '=' + esc(typeof v === 'object' ? JSON.stringify(v) : v));
    }
  }
  return parts.join(' ');
}

function renderCard(st) {
  const head = '<div class="card-head">'
    + '<span class="id">' + esc(st.id) + '</span>'
    + '<span class="badge b-' + st.expected + '">' + st.expected + '</span>'
    + '<span class="pill">' + esc(st.category) + '</span>'
    + '<span class="pill">' + esc(st.severity) + '</span>'
    + '<span class="pill">' + esc(st.title) + '</span>'
    + '</div>';
  const msgs = st.transcript.map(m => {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    if (m.role === 'user') {
      const txt = blocks.map(b => b.type === 'text' ? esc(b.text) : '').join('<br>');
      return '<div class="msg user"><span class="who">user</span>' + txt + '</div>';
    }
    const parts = blocks.map(b => {
      if (b.type === 'toolCall') {
        return '<div class="tool"><span class="tname">' + esc(b.name) + '</span>(' + argsInline(b.arguments)
          + ') <span style="color:var(--muted)">[' + esc(b.id) + ']</span></div>';
      }
      return esc(b.text ?? '');
    }).join('');
    return '<div class="msg asst"><span class="who">assistant</span>' + parts + '</div>';
  }).join('');

  const raw = '<details class="raw"><summary>raw JSON</summary><pre>' + esc(JSON.stringify(st, null, 2)) + '</pre></details>';
  const search = (st.id + ' ' + st.title + ' ' + st.category + ' ' + JSON.stringify(st.transcript) + ' ' + st.targetCommand).toLowerCase();
  return '<section class="card" data-expected="' + st.expected + '" data-category="' + esc(st.category) + '" data-search="' + esc(search) + '">'
    + head
    + '<div class="card-body">'
    // transcript first, then the command being classified, then rationale —
    // matching the real thread where the permission request comes last.
    + '<div class="msgs">' + msgs + '</div>'
    + '<div class="cmd"><span class="lbl">command to classify</span><code>' + esc(st.targetCommand) + '</code></div>'
    + '<div class="rationale">rationale: ' + esc(st.rationale) + '</div>'
    + raw
    + '</div></section>';
}

function apply() {
  const q = ($('#search').value || '').toLowerCase();
  const v = $('#verdict').value;
  const c = $('#category').value;
  const onlyTools = $('#onlyTools').checked;
  const expandJson = $('#expandJson').checked;
  const cards = document.querySelectorAll('.card');
  let shown = 0, toolCount = 0;
  for (const card of cards) {
    const hidden = (v && card.dataset.expected !== v)
      || (c && card.dataset.category !== c)
      || (q && !card.dataset.search.includes(q));
    card.style.display = hidden ? 'none' : '';
    if (hidden) continue;
    shown++;
    const raw = card.querySelector('details.raw');
    if (raw) raw.open = expandJson;
    if (onlyTools) {
      card.querySelectorAll('.msg.user').forEach(m => m.style.display = 'none');
      card.querySelectorAll('.msg.asst').forEach(m => m.style.display = 'block');
    } else {
      card.querySelectorAll('.msg').forEach(m => m.style.display = 'block');
    }
    toolCount += card.querySelectorAll('.tool').length;
  }
  $('#meta').textContent = shown + '/' + STORIES.length + ' stories · ' + toolCount + ' tool calls';
}

function init() {
  const cats = Array.from(new Set(STORIES.map(s => s.category))).sort();
  const sel = $('#category');
  for (const cat of cats) {
    const o = document.createElement('option');
    o.value = cat; o.textContent = cat; sel.appendChild(o);
  }
  $('#main').innerHTML = STORIES.map(renderCard).join('');
  $('#search').addEventListener('input', apply);
  $('#verdict').addEventListener('change', apply);
  $('#category').addEventListener('change', apply);
  $('#onlyTools').addEventListener('change', apply);
  $('#expandJson').addEventListener('change', apply);
  apply();
}
init();
</script>
</body>
</html>
`;

await writeFile(outPath, html, "utf8");
process.stdout.write(`wrote ${outPath}\n(${stories.length} stories from ${files.length} json files)\n`);
