#!/usr/bin/env node
// Merge raw bank exports (source/data/accountactivity*.csv) INTO the unified
// source the app imports: source/data/all-expenses-source.csv
//
//   Raw schema   : date(M/D/YYYY), description, debit, credit, running_balance
//   Output schema: date(YYYY-MM-DD),card,description,category,flow,debit,credit,running_balance
//
// ADDITIVE & non-destructive: every existing transaction is kept (with its
// curated category/card); only transactions found in the raw exports that aren't
// already present are appended (category "Uncategorized"). Matching is by
// date+description+amount. The previous file is backed up to .bak first.
//
//   npm run consolidate              # new rows get card label "Checking"
//   npm run consolidate -- --card="Visa"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve(fileURLToPath(new URL("../source/data", import.meta.url)));
const OUT = path.join(DATA_DIR, "all-expenses-source.csv");
const cardArg = (process.argv.find((a) => a.startsWith("--card=")) || "").split("=")[1];
const DEFAULT_CARD = cardArg || "Checking";

// --- tiny CSV helpers -------------------------------------------------------
function parseCsv(text) {
  const out = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line) continue;
    const f = [];
    let cur = "", q = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') { if (q && line[j + 1] === '"') { cur += '"'; j++; } else q = !q; }
      else if (ch === "," && !q) { f.push(cur); cur = ""; }
      else cur += ch;
    }
    f.push(cur);
    out.push(f);
  }
  return out;
}
const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const isDate = (s) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);
const toISO = (s) => {
  const [m, d, y] = s.split("/");
  const yy = y.length === 2 ? "20" + y : y;
  return `${yy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};
const num = (s) => (s && s.trim() ? parseFloat(s) : 0);
const sig = (date, desc, debit, credit) => `${date}|${desc}|${debit}|${credit}`;

// --- index existing transactions (preserved EXACTLY, dups and all) ----------
const seen = new Set();
let headerLine = "date,card,description,category,flow,debit,credit,running_balance";
let existingBody = "";
let existingCount = 0;
if (fs.existsSync(OUT)) {
  const text = fs.readFileSync(OUT, "utf8").replace(/\r/g, "");
  const rows = parseCsv(text);
  if (rows.length) headerLine = text.split("\n")[0];
  for (let i = 1; i < rows.length; i++) {
    const [date, , desc, , , debit, credit] = rows[i];
    if (!date) continue;
    seen.add(sig(date, desc, num(debit), num(credit)));
    existingCount++;
  }
  existingBody = text.replace(/\n+$/, "").split("\n").slice(1).join("\n"); // keep rows verbatim
}

// --- collect only NEW transactions from the raw exports ---------------------
const rawFiles = fs
  .readdirSync(DATA_DIR)
  .filter((f) => /^accountactivity.*\.csv$/i.test(f) && !f.startsWith("._"))
  .sort();

let parsed = 0;
const fresh = [];
for (const f of rawFiles) {
  const rows = parseCsv(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  for (const r of rows) {
    if (r.length < 5 || !isDate(r[0])) continue; // skip header / malformed lines
    parsed++;
    const date = toISO(r[0]);
    const desc = (r[1] || "").trim();
    const debit = num(r[2]);
    const credit = num(r[3]);
    const s = sig(date, desc, debit, credit);
    if (seen.has(s)) continue; // already in the source — leave curated version untouched
    seen.add(s);
    fresh.push({
      date,
      card: DEFAULT_CARD,
      desc,
      category: "Uncategorized",
      flow: debit ? "out" : credit ? "in" : "",
      debit: debit || "",
      credit: credit || "",
      balance: r[4]?.trim() ? num(r[4]) : "",
    });
  }
}

if (fresh.length === 0) {
  console.log(`✓ Up to date — ${existingCount} transactions, no new rows in ${rawFiles.length} raw export(s). Source left untouched.`);
  process.exit(0);
}

// append new rows after the existing (verbatim) ones, then stable-sort by date
const freshBody = fresh
  .map((r) => [r.date, r.card, r.desc, r.category, r.flow, r.debit, r.credit, r.balance].map(cell).join(","))
  .join("\n");
const allRows = [existingBody, freshBody].filter(Boolean).join("\n").split("\n");
allRows.sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10))); // by leading YYYY-MM-DD
if (fs.existsSync(OUT)) fs.copyFileSync(OUT, OUT + ".bak");
fs.writeFileSync(OUT, headerLine + "\n" + allRows.join("\n") + "\n");

console.log(
  `✓ Merged ${rawFiles.length} raw export(s) (${parsed} rows).\n` +
    `  kept ${existingCount} existing · added ${fresh.length} new (card="${DEFAULT_CARD}", category="Uncategorized") · ${existingCount + fresh.length} total\n` +
    `  → ${path.relative(process.cwd(), OUT)}  (previous saved to .bak)`,
);
