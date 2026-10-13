// Fidelity portfolio-position exports -> the four reports of the old scio-examples pipelines
// (BuildFidelityAccountsWatchlistScioApp, ...InvestmentsScioApp, ...DividendsScioApp, ...DRIPsScioApp).
// Pure code, no DOM: the web worker runs it in the background and `bun test` checks it.
// Money math uses decimal.js with 34 significant digits and HALF_EVEN, the MathContext of
// Scala's BigDecimal (DECIMAL128), so every printed cent matches the Scala output.
import Decimal from 'decimal.js';

const D = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 60 });
type Dec = InstanceType<typeof D>;

const ZERO = new D(0);

// ---- reading files --------------------------------------------------------------------

/** Same quote-aware split as Commons.CsvSplit: a comma followed by an even number of quotes. */
const CSV_SPLIT = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;

export function normalizeRow(row: string): string {
  return row.replace(/﻿/g, '').trim();
}

export function isFidelityHeaderRow(row: string): boolean {
  return normalizeRow(row).toLowerCase().startsWith('account number,');
}

/** Java String.split drops trailing empty strings; the Scala length checks depend on it. */
function javaSplit(row: string): string[] {
  const parts = row.split(CSV_SPLIT);
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 1 && parts[0] === '') return [''];
  return parts;
}

/** Commons.splitRow: split, trim, drop every quote. */
export function splitRow(row: string): string[] {
  return javaSplit(row).map(part => part.trim().replace(/"/g, ''));
}

export type FidelitySchema = {
  commas: number;
  symbol: number;
  costBasisTotal: number;
  currentValue: number;
  lastPrice: number;
  distYield: number;
  paymentFrequency: number;
  marketCap: number;
  exDate: number;
  payDate: number;
  sector: number;
};

export function schemaFromHeader(headerRow: string): FidelitySchema {
  const headers = javaSplit(normalizeRow(headerRow)).map(h => h.trim().replace(/"/g, ''));
  const col = (name: string): number => {
    const exact = headers.indexOf(name);
    return exact >= 0 ? exact : headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
  };
  const col2 = (preferred: string, fallback: string): number => {
    const p = col(preferred);
    return p >= 0 ? p : col(fallback);
  };
  return {
    commas: Math.max(headers.length - 1, 0),
    symbol: col('Symbol'),
    costBasisTotal: col('Cost basis total'),
    currentValue: col('Current value'),
    lastPrice: col('Last price'),
    distYield: col2('Dist. rate', 'Dist. yield'),
    paymentFrequency: col('Payment frequency'),
    marketCap: col('Market cap'),
    exDate: col('Ex-date'),
    payDate: col('Pay date'),
    sector: col('Sector'),
  };
}

/** One account of one imported Fidelity export: the header line and the account's own lines. */
export type Account = {
  id: string;
  fileName: string;
  number: string;
  name: string;
  header: string;
  lines: string[];
};

/** Lines like Beam's TextIO reads them: \n, \r\n and \r all end a line. */
export function textLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The accounts inside a Fidelity positions export (one file per account, or an all-accounts file).
 * Null when the file has no Fidelity header row. Lines that do not reach the Symbol column
 * (blank lines, the quoted disclaimers at the end) belong to no account: every report drops them anyway.
 */
export function readFidelityAccounts(fileName: string, text: string): Account[] | null {
  const lines = textLines(text);
  const header = lines.find(isFidelityHeaderRow);
  if (header === undefined) return null;
  const schema = schemaFromHeader(header);
  const nameIndex = javaSplit(normalizeRow(header)).findIndex(h => h.trim().replace(/"/g, '').toLowerCase() === 'account name');
  const accounts = new Map<string, Account>();
  for (const raw of lines) {
    const row = raw.trim();
    if (!row || isFidelityHeaderRow(row)) continue;
    const parts = splitRow(row);
    if (schema.symbol < 0 || parts.length <= schema.symbol) continue;
    const number = parts[0];
    let account = accounts.get(number);
    if (!account) {
      const name = nameIndex >= 0 && parts.length > nameIndex && parts[nameIndex] ? parts[nameIndex] : number;
      account = { id: `${fileName}#${number}`, fileName, number, name, header, lines: [] };
      accounts.set(number, account);
    }
    account.lines.push(row);
  }
  return [...accounts.values()];
}

// ---- Commons helpers --------------------------------------------------------------------

const DECIMAL_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** BigDecimal(text) or null when Java would throw. */
export function parseDecimal(text: string): Dec | null {
  return DECIMAL_TEXT.test(text) ? new D(text) : null;
}

export function parseMoney(raw: string | undefined, fallback: Dec = ZERO): Dec {
  if (raw == null || raw.trim() === '') return fallback;
  return parseDecimal(raw.trim().replace(/\$/g, '').replace(/,/g, '')) ?? fallback;
}

/** BigDecimalOps.toMoney + toString: two decimals, HALF_UP. */
export function money(value: Dec): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function isExcludedTicker(ticker: string): boolean {
  const t = ticker.trim();
  return t === '' || t === 'SPAXX' || t === 'Pending activity';
}

/** Mega cap ($401.47B) -> 401.47B */
export function formatMarketCap(raw: string | undefined): string {
  if (raw == null || raw === '' || raw === '--') return '';
  const start = raw.indexOf('($');
  const end = raw.indexOf(')');
  if (start !== -1 && end !== -1) return raw.substring(start + 2, end).trim();
  return raw.trim();
}

const CAP_SCALE: Record<string, string> = { t: '1000000000000', b: '1000000000', m: '1000000' };

export function parseMarketCap(raw: string | undefined): number {
  const content = formatMarketCap(raw);
  if (content === '') return 0;
  const suffix = content[content.length - 1].toLowerCase();
  const value = parseDecimal(content.slice(0, -1));
  if (!value) return 0;
  const scaled = CAP_SCALE[suffix] ? value.times(CAP_SCALE[suffix]) : value;
  return scaled.toDecimalPlaces(0, Decimal.ROUND_DOWN).toNumber();
}

/**
 * Commons.activeColumnLabels: walk the ordered labels, keep active ones, stop after the first kept
 * column without a zero (columns to its right would only repeat zeros); inactive ones are skipped.
 */
export function activeColumnLabels(ordered: string[], info: Map<string, [boolean, boolean]>): Set<string> {
  const kept: string[] = [];
  for (const label of ordered) {
    const [hasActive, hasAnyZero] = info.get(label) ?? [false, false];
    if (hasActive) {
      kept.push(label);
      if (!hasAnyZero) break;
    }
  }
  return new Set(kept);
}

/** Header -> schema, the trimmed data lines (no header), split. Throws like the Scala job when there is no header. */
function parsedRows(account: Account, report: string): { schema: FidelitySchema; rows: string[][] } {
  if (!isFidelityHeaderRow(account.header)) throw new Error(`Fidelity header row not found; cannot determine column indices (${report}).`);
  const schema = schemaFromHeader(account.header);
  const rows = account.lines
    .map(line => line.trim())
    .filter(line => line !== '' && !isFidelityHeaderRow(line))
    .map(splitRow);
  return { schema, rows };
}

/** Stable sort that keeps input order for ties (Beam gives no tie order, the comparison treats ties as a set). */
function sortBy<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  return items.map((item, i) => ({ item, i })).sort((a, b) => compare(a.item, b.item) || a.i - b.i).map(x => x.item);
}

export type ReportTable = {
  columns: string[];
  rows: string[][];
};

// ---- watchlist ----------------------------------------------------------------------------

export type Security = 'Stock' | 'ETF';

const TICKER_ALIASES: Record<string, string[]> = {
  BRKB: ['BRKB', 'BRK.B'], 'BRK.B': ['BRKB', 'BRK.B'],
  TTE: ['TTE', 'NYSE:TTE'], 'NYSE:TTE': ['TTE', 'NYSE:TTE'],
  BNS: ['BNS', 'NYSE:BNS'], 'NYSE:BNS': ['BNS', 'NYSE:BNS'],
  PTC: ['PTC', 'NASDAQ:PTC'], 'NASDAQ:PTC': ['PTC', 'NASDAQ:PTC'],
  OR: ['OR', 'NYSE:OR'], 'NYSE:OR': ['OR', 'NYSE:OR'],
  MC: ['MC', 'NYSE:MC'], 'NYSE:MC': ['MC', 'NYSE:MC'],
  AMP: ['AMP', 'NYSE:AMP'], 'NYSE:AMP': ['AMP', 'NYSE:AMP'],
};

function securityOf(sector: string): Security {
  const s = sector == null || sector.trim() === '' ? '--' : sector.trim();
  return s === '--' ? 'ETF' : 'Stock';
}

/** Watchlist over one or more accounts: tickers by market cap, largest first. Columns: Symbol, Market cap. */
export function watchlistReport(accounts: Account[], securities: Security[]): ReportTable {
  const seen = new Map<string, { cap: number; capText: string }>();
  for (const account of accounts) {
    const { schema: idx, rows } = parsedRows(account, 'Watchlist');
    for (const parts of rows) {
      if (idx.symbol < 0 || parts.length <= idx.symbol) continue;
      if (parts.length < idx.commas && parts.length <= Math.max(idx.marketCap, idx.sector)) continue;
      const sector = idx.sector >= 0 && parts.length > idx.sector ? parts[idx.sector] : '--';
      if (!securities.includes(securityOf(sector))) continue;
      const ticker = parts[idx.symbol].trim();
      if (!/^[A-Z0-9.:]+$/.test(ticker)) continue;
      const capRaw = idx.marketCap >= 0 && parts.length > idx.marketCap ? parts[idx.marketCap] : '';
      const cap = parseMarketCap(capRaw);
      for (const t of TICKER_ALIASES[ticker] ?? [ticker]) {
        if (!seen.has(t)) seen.set(t, { cap, capText: formatMarketCap(capRaw) });
      }
    }
  }
  const sorted = sortBy([...seen.entries()], (a, b) => b[1].cap - a[1].cap);
  return { columns: ['Symbol', 'Market cap'], rows: sorted.map(([t, v]) => [t, v.capText]) };
}

// ---- investments ----------------------------------------------------------------------

const INVESTMENT_THRESHOLDS: [string, Dec][] = [
  ...Array.from({ length: 39 }, (_, i) => i + 2),
  45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
].map(n => [`$${n} Diff`, new D(n)]);

const MIN_FIDELITY_ORDER = new D('1.00');

export function investmentsReport(account: Account): ReportTable {
  const { schema: idx, rows } = parsedRows(account, 'Investments');
  const positions: { ticker: string; currentValue: Dec; costBasis: Dec; rawCap: string; diffs: Map<string, Dec> }[] = [];
  for (const parts of rows) {
    if (idx.symbol < 0 || idx.marketCap < 0 || idx.costBasisTotal < 0 || idx.currentValue < 0) continue;
    if (parts.length <= idx.symbol || parts.length <= idx.marketCap || parts.length <= idx.costBasisTotal || parts.length <= idx.currentValue) continue;
    const ticker = parts[idx.symbol].trim();
    if (ticker === 'SPAXX**' || isExcludedTicker(ticker)) continue;
    const costBasis = parseMoney(parts[idx.costBasisTotal]);
    const currentValue = parseMoney(parts[idx.currentValue]);
    const diffs = new Map(INVESTMENT_THRESHOLDS.map(([label, target]) => [label, D.max(target.minus(costBasis), ZERO)]));
    if ([...diffs.values()].every(v => v.isZero())) continue;
    positions.push({ ticker, currentValue, costBasis, rawCap: parts[idx.marketCap].trim(), diffs });
  }

  const labels = INVESTMENT_THRESHOLDS.map(([label]) => label);
  let active = new Set<string>();
  if (positions.length) {
    const info = new Map<string, [boolean, boolean]>();
    for (const label of labels) {
      const values = positions.map(p => p.diffs.get(label) ?? ZERO);
      info.set(label, [values.some(v => v.gte(MIN_FIDELITY_ORDER)), values.some(v => v.isZero())]);
    }
    active = activeColumnLabels(labels, info);
  }
  const activeLabels = labels.filter(l => active.has(l));
  const lastActive = activeLabels[activeLabels.length - 1] ?? '';
  const body = positions.map(p => ({
    cap: parseMarketCap(p.rawCap),
    key: p.diffs.get(lastActive) ?? ZERO,
    row: [p.ticker, money(p.currentValue), money(p.costBasis), formatMarketCap(p.rawCap), ...activeLabels.map(l => money(p.diffs.get(l) ?? ZERO))],
  }));
  const sorted = sortBy(body, (a, b) => a.key.comparedTo(b.key) || b.cap - a.cap);
  return { columns: ['Symbol', 'Current $', 'Costs $', 'Market cap', ...activeLabels], rows: sorted.map(x => x.row) };
}

// ---- dividends ----------------------------------------------------------------------------

const DIVIDEND_MULTIPLIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 30000, 50000, 100000];
const DIVIDEND_THRESHOLDS: [string, Dec][] = DIVIDEND_MULTIPLIERS.map(n => [`${n}x Diff $`, new D(n)]);

const DIVIDEND_FREQUENCY: Record<string, string> = { Annually: '1.0', 'Semi-annually': '2.0', Quarterly: '4.0', Monthly: '12.0' };

function parsePercent(raw: string): Dec | null {
  return parseDecimal(raw.trim().replace(/%/g, '').replace(/,/g, ''));
}

export function dividendsReport(account: Account): ReportTable {
  const { schema: idx, rows } = parsedRows(account, 'Dividends');
  const positions: { symbol: string; yieldPercent: Dec; currentValue: Dec; minValue: Dec; baseValue: Dec; diffs: Map<string, Dec> }[] = [];
  for (const parts of rows) {
    if (idx.symbol < 0 || idx.distYield < 0 || idx.paymentFrequency < 0 || idx.lastPrice < 0 || idx.costBasisTotal < 0 || idx.currentValue < 0) continue;
    if (parts.length <= idx.symbol || parts.length <= idx.distYield || parts.length <= idx.paymentFrequency
      || parts.length <= idx.lastPrice || parts.length <= idx.costBasisTotal || parts.length <= idx.currentValue) continue;
    const yieldPercent = parsePercent(parts[idx.distYield]);
    if (!yieldPercent || !yieldPercent.gt(0)) continue;
    const frequencyText = DIVIDEND_FREQUENCY[parts[idx.paymentFrequency].trim()];
    if (!frequencyText) continue;
    const frequency = new D(frequencyText);
    const lastPrice = parseMoney(parts[idx.lastPrice]);
    if (!lastPrice.gt(0)) continue;
    const ticker = parts[idx.symbol].trim();
    if (isExcludedTicker(ticker)) continue;
    const costBasis = parseMoney(parts[idx.costBasisTotal]);
    const currentValue = parseMoney(parts[idx.currentValue]);
    if (costBasis.isZero() || currentValue.isZero()) continue;
    const minValue = lastPrice.times('0.001');
    const neededValue = minValue.times(frequency).div(yieldPercent.div('100.0'));
    const diffs = new Map(DIVIDEND_THRESHOLDS.map(([label, multiplier]) => [label, D.max(neededValue.times(multiplier).minus(currentValue), ZERO)]));
    if ([...diffs.values()].every(v => v.isZero())) continue;
    positions.push({ symbol: ticker, yieldPercent, currentValue, minValue, baseValue: D.min(currentValue, costBasis), diffs });
  }

  const labels = DIVIDEND_THRESHOLDS.map(([label]) => label);
  let active = new Set<string>();
  if (positions.length) {
    const info = new Map<string, [boolean, boolean]>();
    for (const label of labels) {
      const values = positions.map(p => p.diffs.get(label) ?? ZERO);
      info.set(label, [values.some(v => v.gt(0)), values.some(v => v.isZero())]);
    }
    active = activeColumnLabels(labels, info);
  }
  const activeLabels = labels.filter(l => active.has(l));
  const firstActive = activeLabels[0] ?? '';
  const body = positions.map(p => ({
    key: p.diffs.get(firstActive) ?? ZERO,
    row: [p.symbol, money(p.yieldPercent), money(p.currentValue), money(p.minValue), money(p.baseValue), ...activeLabels.map(l => money(p.diffs.get(l) ?? ZERO))],
  }));
  const sorted = sortBy(body, (a, b) => a.key.comparedTo(b.key));
  return { columns: ['Symbol', 'Yield %', 'Value', '0.001 Costs $', 'Baseline $', ...activeLabels], rows: sorted.map(x => x.row) };
}

// ---- DRIPs ------------------------------------------------------------------------------

export function parseFrequency(raw: string): [string, Dec] | null {
  switch (raw.trim()) {
    case 'Annually': case 'Annual': return ['Annually', new D('1.0')];
    case 'Semi-annually': case 'Semi-Annual': case 'Semiannually': case 'Semi Annually': return ['Semi-annually', new D('2.0')];
    case 'Quarterly': return ['Quarterly', new D('4.0')];
    case 'Monthly': return ['Monthly', new D('12.0')];
    default: return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Fidelity `MMM-dd-yyyy` (Sep-10-2026) -> ISO yyyy-MM-dd, null when it is not a date. */
export function parseFidelityDate(raw: string | undefined): string | null {
  const m = /^([A-Z][a-z]{2})-(\d{2})-(\d{4})$/.exec((raw ?? '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]) + 1;
  const day = Number(m[2]);
  if (month === 0 || day < 1 || day > 31) return null;
  // Java's SMART resolver moves 29-31 past the month end to the last day of the month.
  const last = new Date(Date.UTC(Number(m[3]), month, 0)).getUTCDate();
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Today in the local time zone as yyyy-MM-dd (LocalDate.now()). */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Positions that still need more money so one dividend payout reinvests at least 0.001 share.
 * Date columns show only dates strictly after `runDate` (yyyy-MM-dd), like the Scala job run on that day.
 */
export function dripsReport(account: Account, runDate: string = todayIso()): ReportTable {
  const { schema: idx, rows } = parsedRows(account, 'DRIPs');
  const out: { ppy: Dec; minimalDrip: Dec; row: string[] }[] = [];
  for (const parts of rows) {
    if (idx.symbol < 0 || idx.currentValue < 0 || idx.lastPrice < 0 || idx.distYield < 0 || idx.paymentFrequency < 0 || idx.exDate < 0) continue;
    if (parts.length <= idx.symbol || parts.length <= idx.currentValue || parts.length <= idx.lastPrice
      || parts.length <= idx.distYield || parts.length <= idx.paymentFrequency || parts.length <= idx.exDate) continue;
    const ticker = parts[idx.symbol].trim();
    if (isExcludedTicker(ticker)) continue;
    const yieldPercent = parsePercent(parts[idx.distYield]);
    if (!yieldPercent || !yieldPercent.gt(0)) continue;
    const frequency = parseFrequency(parts[idx.paymentFrequency]);
    if (!frequency) continue;
    const [frequencyLabel, ppy] = frequency;
    const lastPrice = parseDecimal(parts[idx.lastPrice].trim().replace(/\$/g, '').replace(/,/g, ''));
    if (!lastPrice || !lastPrice.gt(0)) continue;
    const ex = parseFidelityDate(parts[idx.exDate]);
    if (!ex) continue;
    let payRaw = idx.payDate >= 0 && parts.length > idx.payDate ? parts[idx.payDate].trim() : '';
    if (payRaw === '--') payRaw = '';
    const pay = parseFidelityDate(payRaw);
    const currentValue = parseMoney(parts[idx.currentValue]);

    const annYield = yieldPercent.div('100.0');
    const minShareCost = lastPrice.times('0.001');
    const minimalDrip = annYield.lte(0) ? ZERO : minShareCost.times(ppy).div(annYield);
    const amountNeeded = D.max(minimalDrip.minus(currentValue), ZERO);
    if (!(minimalDrip.gt(0) && amountNeeded.gt(0))) continue;
    const shares = (value: Dec, rounding: Decimal.Rounding): string => value.div(lastPrice).toDecimalPlaces(3, rounding).toFixed(3);
    const future = (iso: string | null): string => (iso && iso > runDate ? iso : '');
    out.push({
      ppy,
      minimalDrip,
      row: [
        ticker, money(yieldPercent), money(currentValue), money(minimalDrip), money(amountNeeded),
        shares(currentValue, Decimal.ROUND_HALF_UP), shares(minimalDrip, Decimal.ROUND_CEIL), shares(amountNeeded, Decimal.ROUND_CEIL),
        frequencyLabel, String(ppy.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()).padStart(2, '0'),
        future(ex), future(pay),
      ],
    });
  }
  const sorted = sortBy(out, (a, b) => b.ppy.comparedTo(a.ppy) || a.minimalDrip.comparedTo(b.minimalDrip));
  return {
    columns: ['Symbol', 'Yield %', 'Value $', 'Minimal DRIP $', 'Amount Needed $', 'Value Shares', 'Minimal DRIP Shares', 'Amount Needed Shares', 'Frequency', 'Payments/Year', 'Ex. Dividend Date', 'Payment Date'],
    rows: sorted.map(x => x.row),
  };
}

// ---- all reports ----------------------------------------------------------------------------

export type ReportKind = 'watchlists' | 'investments' | 'dividends' | 'drips';

export const REPORT_KINDS: { kind: ReportKind; label: string; folder: string }[] = [
  { kind: 'watchlists', label: 'Watchlists', folder: 'watchlist' },
  { kind: 'investments', label: 'Investments', folder: 'investments' },
  { kind: 'dividends', label: 'Dividends', folder: 'dividends' },
  { kind: 'drips', label: 'DRIPs', folder: 'DRIPs' },
];

/** One tab of a report: a whole-portfolio list (watchlists) or one account. */
export type ReportSheet = { id: string; title: string; table: ReportTable; error?: string };

function guarded(id: string, title: string, run: () => ReportTable): ReportSheet {
  try {
    return { id, title, table: run() };
  } catch (e) {
    return { id, title, table: { columns: [], rows: [] }, error: e instanceof Error ? e.message : String(e) };
  }
}

export function buildReport(kind: ReportKind, accounts: Account[], runDate: string = todayIso()): ReportSheet[] {
  if (kind === 'watchlists') {
    const all: ReportSheet[] = [
      guarded('all', 'All', () => watchlistReport(accounts, ['Stock', 'ETF'])),
      guarded('all-stocks', 'All Stocks', () => watchlistReport(accounts, ['Stock'])),
      guarded('all-etfs', 'All ETFs', () => watchlistReport(accounts, ['ETF'])),
    ];
    return all.concat(accounts.map(a => guarded(a.id, a.name, () => watchlistReport([a], ['Stock', 'ETF']))));
  }
  const run = kind === 'investments' ? investmentsReport : kind === 'dividends' ? dividendsReport : (a: Account) => dripsReport(a, runDate);
  return accounts.map(a => guarded(a.id, a.name, () => run(a)));
}

/** Report text in the Scala output format: watchlists are one ticker per line, the others CSV with a header. */
export function reportText(kind: ReportKind, table: ReportTable): string {
  const lines = kind === 'watchlists' ? table.rows.map(r => r[0]) : [table.columns.join(','), ...table.rows.map(r => r.join(','))];
  return lines.map(l => `${l}\n`).join('');
}

// ---- any CSV as a table (the Files tab) -------------------------------------------------------

/**
 * RFC 4180 rows: a quote opens a quoted field only as the first character of a field (a bare " inside
 * a value stays text), "" is a quote, quoted fields may hold commas and newlines; \n, \r\n and \r end a row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.trim() === '') { quoted = true; started = true; field = ''; }
    else if (c === ',') { row.push(field.trim()); field = ''; started = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field.trim());
      rows.push(row);
      row = []; field = ''; started = false;
    } else { field += c; started = true; }
  }
  if (started || field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

/**
 * The table inside a CSV export: rows are cut into blocks at blank lines, the block with the most
 * multi-column rows wins (preambles, totals and quoted disclaimers fall away), its first row is the header.
 * Columns that are empty in every row (the trailing comma of Fidelity data rows) are dropped.
 */
export function readTable(text: string): ReportTable {
  const blocks: string[][][] = [[]];
  for (const r of parseCsv(text)) {
    if (r.every(f => f === '')) { if (blocks[blocks.length - 1].length) blocks.push([]); }
    else blocks[blocks.length - 1].push(r);
  }
  const score = (b: string[][]) => b.filter(r => r.length >= 2).length;
  const best = blocks.reduce((a, b) => (score(b) > score(a) ? b : a), blocks[0]).filter(r => r.length >= 2);
  if (!best.length) return { columns: [], rows: [] };
  const [header, ...body] = best;
  const lastFilled = (r: string[]) => { let n = r.length; while (n > 0 && r[n - 1] === '') n -= 1; return n; };
  const width = Math.max(lastFilled(header), ...body.map(lastFilled));
  const columns = Array.from({ length: width }, (_, i) => header[i] || `Column ${i + 1}`);
  const rows = body.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { columns, rows };
}
