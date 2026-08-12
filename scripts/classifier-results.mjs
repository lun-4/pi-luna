#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultResults = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks/classifier/RESULTS.csv",
);
const filename = process.argv[2] ? path.resolve(process.argv[2]) : defaultResults;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const numericFields = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_usd",
];

const rows = parseCsv(await readFile(filename, "utf8"));
if (rows.length < 2) {
  console.error(`No benchmark results found in ${filename}`);
  process.exitCode = 1;
} else {
  const header = rows[0];
  const records = rows.slice(1).map((values) =>
    Object.fromEntries(header.map((name, i) => [name, values[i] ?? ""])),
  );
  const groups = new Map();

  for (const record of records) {
    const key = `${record.model}\0${record.prompt}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: record.model,
        prompt: record.prompt,
        tests: 0,
        approved: 0,
        denied: 0,
        correct: 0,
        expApprove: 0,
        expDeny: 0,
        acceptCorrect: 0,
        refusalCorrect: 0,
        ...Object.fromEntries(numericFields.map((field) => [field, 0])),
      };
      groups.set(key, group);
    }
    group.tests++;
    group[record.got === "approve" ? "approved" : "denied"]++;
    group.correct += record.pass === "pass" ? 1 : 0;
    if (record.expected === "approve") {
      group.expApprove++;
      if (record.got === "approve") group.acceptCorrect++;
    } else {
      group.expDeny++;
      if (record.got === "deny") group.refusalCorrect++;
    }
    for (const field of numericFields) group[field] += Number(record[field]) || 0;
  }

  const table = [...groups.values()].map((group) => ({
    model: group.model,
    prompt: group.prompt,
    tests: String(group.tests),
    approved: String(group.approved),
    denied: String(group.denied),
    correct: `${group.correct}/${group.tests}`,
    accuracy: `${((group.correct / group.tests) * 100).toFixed(1)}%`,
    acceptCrct: `${group.acceptCorrect}/${group.expApprove}`,
    acceptRate: `${(group.expApprove ? (group.acceptCorrect / group.expApprove) * 100 : 0).toFixed(1)}%`,
    refusalCrct: `${group.refusalCorrect}/${group.expDeny}`,
    slipped: String(group.expDeny - group.refusalCorrect),
    refusalRate: `${(group.expDeny ? (group.refusalCorrect / group.expDeny) * 100 : 0).toFixed(1)}%`,
    tokens: group.total_tokens.toLocaleString("en-US"),
    cost: `$${group.cost_usd.toFixed(6)}`,
  }));
  table.sort((a, b) =>
    Number.parseInt(b.tests, 10) - Number.parseInt(a.tests, 10) ||
    Number.parseFloat(b.accuracy) - Number.parseFloat(a.accuracy) ||
    a.model.localeCompare(b.model) ||
    a.prompt.localeCompare(b.prompt),
  );
  const columns = ["model", "prompt", "tests", "approved", "denied", "correct", "accuracy", "acceptCrct", "acceptRate", "refusalCrct", "slipped", "refusalRate", "tokens", "cost"];
  const headerNames = {
    model: "model", prompt: "prompt", tests: "tests", approved: "approved", denied: "denied",
    correct: "correct", accuracy: "accuracy", acceptCrct: "acceptCrct", acceptRate: "acceptRate",
    refusalCrct: "refusalCrct", slipped: "slipped", refusalRate: "refusalRate",
    tokens: "tokens", cost: "cost",
  };
  const widths = Object.fromEntries(
    columns.map((column) => [column, Math.max(headerNames[column].length, ...table.map((row) => row[column].length))]),
  );
  const line = (row) => `| ${columns.map((column) => row[column].padEnd(widths[column])).join(" | ")} |`;
  console.log(line(Object.fromEntries(columns.map((column) => [column, headerNames[column]]))));
  console.log(`|${columns.map((column) => ` ${"-".repeat(widths[column])} `).join("|")}|`);
  for (const row of table) console.log(line(row));
}
