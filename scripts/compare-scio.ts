#!/usr/bin/env bun
/// <reference types="bun" />
// Compares the web reports with the outputs of the old scio-examples Scala jobs.
// Usage: bun scripts/compare-scio.ts <scio-examples dir> [runDate yyyy-MM-dd]
// runDate is the day the Scala job ran (DRIPs show only dates after it); default: the mtime of target/DRIPs/1.csv.
// Beam gives no order for rows with equal sort keys, so rows are compared as a set plus the order of the sort keys.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFidelityAccounts, buildReport, reportText, todayIso, type ReportKind } from '../src/fidelity';

const scio = process.argv[2];
if (!scio) {
  console.error('usage: bun scripts/compare-scio.ts <scio-examples dir> [runDate]');
  process.exit(2);
}
const inputDir = join(scio, 'src/main/resources/input');
const target = join(scio, 'target');
const runDate = process.argv[3] ?? todayIso(statSync(join(target, 'DRIPs/1.csv')).mtime);

const files = readdirSync(inputDir).filter(f => !f.startsWith('.') && f.toLowerCase().endsWith('.csv')).sort();
const accounts = files.flatMap(f => readFidelityAccounts(f, readFileSync(join(inputDir, f), 'utf8')) ?? []);
const WATCHLIST_NAMES: Record<number, string> = { 1: 'Stocks', 2: 'Max Roth', 3: 'Elena', 4: 'Elena Roth', 5: 'ETFs', 6: 'Ameliia', 7: 'Martin' };

let failed = 0;
let passed = 0;

function compare(label: string, expected: string, actual: string, ordered: boolean): void {
  const e = expected.split('\n').filter(Boolean);
  const a = actual.split('\n').filter(Boolean);
  const same = ordered ? e.join('\n') === a.join('\n') : e[0] === a[0] && [...e].sort().join('\n') === [...a].sort().join('\n');
  if (same) { passed += 1; return; }
  failed += 1;
  const missing = e.filter(l => !a.includes(l));
  const extra = a.filter(l => !e.includes(l));
  console.log(`FAIL ${label}: expected ${e.length} lines, got ${a.length}`);
  if (e[0] !== a[0]) console.log(`  header expected: ${e[0]}\n  header actual:   ${a[0]}`);
  missing.slice(0, 5).forEach(l => console.log(`  - ${l}`));
  extra.slice(0, 5).forEach(l => console.log(`  + ${l}`));
}

for (const kind of ['investments', 'dividends', 'drips'] as ReportKind[]) {
  const folder = kind === 'drips' ? 'DRIPs' : kind;
  const sheets = buildReport(kind, accounts, runDate);
  sheets.forEach((sheet, i) => {
    const file = join(target, folder, `${i + 1}.csv`);
    if (sheet.error) { failed += 1; console.log(`FAIL ${folder}/${i + 1}: ${sheet.error}`); return; }
    // Same multiset of rows; the order is checked by the sort keys inside the report (stable sort of equal keys)
    compare(`${folder}/${i + 1}.csv (${sheet.title})`, readFileSync(file, 'utf8'), reportText(kind, sheet.table), false);
  });
}

const watch = buildReport('watchlists', accounts, runDate);
// The Scala All lists read every file with the header of ONE file (take(1) over the union), so files whose
// header has other columns (Sleeve name, 38/39/41 columns) lose their tickers there. The web report reads each
// file with its own header: All must be the union of the per-account lists, sorted by market cap.
const perAccount = watch.slice(3).flatMap((_, i) => readFileSync(join(target, 'watchlist', `${WATCHLIST_NAMES[i + 1]}.txt`), 'utf8').split('\n').filter(Boolean));
watch.slice(0, 3).forEach(sheet => {
  const got = sheet.table.rows.map(r => r[0]);
  const want = new Set(perAccount.filter(t => sheet.title === 'All' || watch[sheet.title === 'All Stocks' ? 1 : 2].table.rows.some(r => r[0] === t)));
  const sorted = sheet.table.rows.every((r, j, rows) => j === 0 || parseCap(rows[j - 1][1]) >= parseCap(r[1]));
  if (sheet.title === 'All' && (got.length !== want.size || got.some(t => !want.has(t)))) { failed += 1; console.log(`FAIL watchlist/All: not the union of the account lists`); }
  else if (!sorted) { failed += 1; console.log(`FAIL watchlist/${sheet.title}: not sorted by market cap`); }
  else passed += 1;
});
function parseCap(text: string): number { const m = /^([\d.]+)([TBM]?)$/.exec(text ?? ''); return m ? Number(m[1]) * ({ T: 1e12, B: 1e9, M: 1e6 }[m[2]] ?? 1) : 0; }

watch.forEach((sheet, i) => {
  if (i < 3) return;
  const name = WATCHLIST_NAMES[i - 2];
  for (const ext of ['csv', 'txt']) {
    const file = join(target, 'watchlist', `${name}.${ext}`);
    if (!existsSync(file)) { failed += 1; console.log(`FAIL missing ${file}`); continue; }
    const expected = readFileSync(file, 'utf8');
    const actual = reportText('watchlists', sheet.table);
    // Equal market caps have no defined order in Beam: compare the set, then the order outside ties
    compare(`watchlist/${name}.${ext}`, `H\n${expected}`, `H\n${actual}`, false);
    const caps = new Map(sheet.table.rows.map(r => [r[0], r[1]]));
    const exp = expected.split('\n').filter(Boolean);
    const act = actual.split('\n').filter(Boolean);
    if (exp.some((t, j) => t !== act[j] && caps.get(t) !== caps.get(act[j]))) {
      failed += 1;
      console.log(`FAIL watchlist/${name}.${ext}: order differs outside equal market caps`);
    }
  }
});

console.log(`runDate ${runDate}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
