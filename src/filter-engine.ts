// Copied verbatim from the workspace block .claude/tools/etfs/ui-std/filter-engine.tsx (ETF apps, Stocks, gex);
// only the export line at the end is added. Change the block there first, then copy it here again.
// =========================================================================
// 3b. Column types, auto-detection and the column filter engine (pure, no DOM)
// =========================================================================

/**
 * Every column of a table has a type that decides how its cells are compared:
 * text, number, percentage, money, date, date and time, or time of day. The type
 * is detected from a sample of the cell texts (80% of the filled cells must
 * agree) and can be overridden per column with the badge in the header.
 *
 * Filter expressions (one input under every column header):
 *   - the same grammar in every mode: space = AND, comma = OR, a leading ! = NOT,
 *     ? = the value is empty or unavailable, !? = it has a value
 *   - text: word (contains), "two words", =exact, ^starts, ends$, /regex/
 *   - number, percentage, money: >10 >=10 <50 <=50 =22 !=22, ranges 10..50 / ..50 / 10..,
 *     K M B T suffixes (>10B), an optional $ or %
 *   - date, date and time: the same operators and ranges over dates written as 2024,
 *     2024-06, 2024-06-15 or 2024-06-15T14:30; a partial date is the whole period
 *     (=2024 is the whole year), keywords today, yesterday, tomorrow, now and relative
 *     offsets -7d, +2w, -3m, -1y
 *   - time: >09:30, 09:30..16:00, =12:00
 *   Values that are unavailable match only ? and negated conditions.
 */
type ColType = 'string' | 'number' | 'percent' | 'currency' | 'date' | 'datetime' | 'time';

const ALL_COL_TYPES: ColType[] = ['string', 'number', 'percent', 'currency', 'date', 'datetime', 'time'];

const COL_TYPE_LABELS: Record<ColType, string> = { string: 'ABC', number: '123', percent: '%', currency: '$', date: 'D', datetime: 'DT', time: 'T' };

const COL_TYPE_NAMES: Record<ColType, string> = { string: 'text', number: 'number', percent: 'percentage', currency: 'money', date: 'date', datetime: 'date and time', time: 'time of day' };

const COL_TYPE_CLASSES: Record<ColType, string> = {
  string: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  number: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
  percent: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300',
  currency: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
  date: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
  datetime: 'bg-fuchsia-100 dark:bg-fuchsia-900/50 text-fuchsia-700 dark:text-fuchsia-300',
  time: 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300',
};

const COL_TYPE_PLACEHOLDERS: Record<ColType, string> = {
  string: 'text, !not, "a b"', number: '>10 <50, =22', percent: '>5 <20, 10..15', currency: '>1B, ..500M', date: '>2024-01, -30d..', datetime: '>2024-06-01T09:30', time: '>09:30 <16:00',
};

const COL_TYPE_HELP: Record<ColType, string> = {
  string: 'Text filter: space = AND, comma = OR, !word = NOT, "two words" = phrase, =exact, ^starts, ends$, /regex/, ? = empty, !? = has a value.',
  number: 'Number filter: >10 >=10 <50 <=50 =22 !=22, ranges 10..50 / ..50 / 10.., suffixes K M B T, space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  percent: 'Percentage filter: >5 <20, 10..15, =12.5 (rounds like the shown value), space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  currency: 'Money filter: >1B, ..500M, 10..20, suffixes K M B T, an optional $, space = AND, comma = OR, ! = NOT, ? = unavailable, !? = available.',
  date: 'Date filter: >2024-06-01, 2024 (the whole year), 2024-06 (the whole month), 2024-01..2024-06, today, yesterday, -7d, +2w, -3m, -1y, space = AND, comma = OR, ! = NOT, ? = empty.',
  datetime: 'Date and time filter: >2024-06-01T09:30, 2024-06-01 (the whole day), 2024-01..2024-06, today, -7d.., space = AND, comma = OR, ! = NOT, ? = empty.',
  time: 'Time filter: >09:30, 09:30..16:00, =12:00 (the whole minute), space = AND, comma = OR, ! = NOT, ? = empty.',
};

const FILTER_DAY_MS = 86400000;
const EMPTY_CELLS = new Set(['', '-', '--', '–', '—', 'n/a', 'na', 'null', 'none', 'nan']);
const TYPE_SAMPLE_SIZE = 60;
const TYPE_AGREEMENT = 0.8;
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MAGNITUDES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

function isEmptyCell(value: string): boolean {
  return EMPTY_CELLS.has(value.trim().toLowerCase());
}

function monthFromName(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, '');
  const abbr = MONTH_ABBR.indexOf(lower === 'sept' ? 'sep' : lower);
  return abbr >= 0 ? abbr : MONTH_FULL.indexOf(lower);
}

/** UTC milliseconds of a calendar date; NaN when the date does not exist (2024-02-30). */
function utcMs(year: number, month: number, day: number): number {
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : NaN;
}

/** Date in one of the common written forms, as UTC midnight milliseconds; NaN when the text is not a date. */
function parseDatePart(text: string): number {
  const value = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (m) return utcMs(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value); // US month/day/year unless the first number cannot be a month
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    const year = m[3].length === 2 ? (Number(m[3]) < 70 ? 2000 : 1900) + Number(m[3]) : Number(m[3]);
    return first > 12 ? utcMs(year, second, first) : utcMs(year, first, second);
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (m) return utcMs(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]*(\d{4})$/.exec(value);
  if (m && monthFromName(m[2]) >= 0) return utcMs(Number(m[3]), monthFromName(m[2]) + 1, Number(m[1]));
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(value);
  if (m && monthFromName(m[1]) >= 0) return utcMs(Number(m[3]), monthFromName(m[1]) + 1, Number(m[2]));
  return NaN;
}

/** Time of day in seconds since midnight (24-hour or AM/PM); NaN when the text is not a time. */
function parseTimePart(text: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([AaPp][Mm])?$/.exec(text.trim());
  if (!m) return NaN;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = m[3] === undefined ? 0 : Number(m[3]);
  if (m[5]) {
    if (hours < 1 || hours > 12) return NaN;
    hours = (hours % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return NaN;
  return hours * 3600 + minutes * 60 + seconds + (m[4] ? Number(`0.${m[4]}`) : 0);
}

type Temporal = { kind: 'date' | 'datetime' | 'time'; value: number };

/** A date (UTC midnight ms), a date with a time (UTC ms, an offset such as Z or +02:00 is honored) or a time of day (seconds). */
function parseTemporal(raw: string): Temporal | null {
  const text = raw.trim();
  if (!text) return null;
  const time = parseTimePart(text);
  if (Number.isFinite(time)) return { kind: 'time', value: time };
  const date = parseDatePart(text);
  if (Number.isFinite(date)) return { kind: 'date', value: date };
  const m = /^(.+?)(?:T|\s+)(\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[AaPp][Mm])?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) return null;
  const day = parseDatePart(m[1]);
  const clock = parseTimePart(m[2]);
  if (!Number.isFinite(day) || !Number.isFinite(clock)) return null;
  let ms = day + clock * 1000;
  if (m[3] && m[3] !== 'Z') {
    const digits = m[3].slice(1).replace(':', '');
    ms -= (m[3][0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
  }
  return { kind: 'datetime', value: ms };
}

type Magnitude = { value: number; decimals: number; scale: number; percent: boolean; currency: boolean };

/** $1,234.50, (12.5), -3.2%, 5B, +1.2 pp, 12x: the number with the precision and the unit it was written with. */
function parseMagnitude(raw: string): Magnitude | null {
  let text = raw.trim();
  let negative = false;
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) { negative = true; text = paren[1].trim(); }
  const m = /^([+-]?)\s*([$€£¥]?)\s*([+-]?)\s*(\d[\d,]*(?:\.\d*)?|\.\d+)\s*([kmbtKMBT])?\s*(%|pp|bp|x)?$/.exec(text);
  if (!m) return null;
  if (m[1] === '-' || m[3] === '-') negative = !negative;
  const digits = m[4].replace(/,/g, '');
  const scale = m[5] ? MAGNITUDES[m[5].toLowerCase()] : 1;
  const value = Number(digits) * scale;
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, decimals: digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0, scale, percent: m[6] === '%', currency: m[2] !== '' };
}

/** The sortable and filterable number behind a cell text for its column type; NaN when there is none. */
function parseCellValue(text: string, type: ColType): number {
  if (type === 'string') return NaN;
  if (type === 'number' || type === 'percent' || type === 'currency') {
    const magnitude = parseMagnitude(text);
    return magnitude ? magnitude.value : NaN;
  }
  const temporal = parseTemporal(text);
  if (!temporal) return NaN;
  if (type === 'time') return temporal.kind === 'time' ? temporal.value : NaN;
  if (temporal.kind === 'time') return NaN;
  if (type === 'date') return Math.floor(temporal.value / 86400000) * 86400000;
  return temporal.value;
}

/** Detects the type of a column from sample cell texts: 80% of the filled cells must agree, otherwise text. */
function detectColType(samples: string[]): ColType {
  const values = samples.map(sample => String(sample ?? '').trim()).filter(value => !isEmptyCell(value)).slice(0, TYPE_SAMPLE_SIZE);
  if (!values.length) return 'string';
  const need = Math.ceil(values.length * TYPE_AGREEMENT);
  const count = { date: 0, datetime: 0, time: 0, percent: 0, currency: 0, number: 0 };
  values.forEach(value => {
    const temporal = parseTemporal(value);
    if (temporal) { count[temporal.kind] += 1; return; }
    const magnitude = parseMagnitude(value);
    if (!magnitude) return;
    if (magnitude.percent) count.percent += 1;
    else if (magnitude.currency) count.currency += 1;
    else count.number += 1;
  });
  if (count.date + count.datetime >= need) return count.datetime > 0 ? 'datetime' : 'date';
  if (count.time >= need) return 'time';
  if (count.percent >= need) return 'percent';
  if (count.currency >= need || count.currency + count.number >= need && count.currency > 0) return 'currency';
  if (count.number >= need) return 'number';
  return 'string';
}

// ---- filter expressions ---------------------------------------------------------

type FilterToken = { op: string; text: string; neg: boolean; quoted: boolean; regex: boolean; flags: string };

/** Splits an expression into AND tokens grouped by commas (OR groups); quotes keep spaces, !/>= prefixes may precede a quote. */
function tokenizeFilter(input: string): FilterToken[][] {
  const groups: FilterToken[][] = [[]];
  let i = 0;
  const length = input.length;
  while (i < length) {
    const char = input[i];
    if (char === ' ' || char === '\t') { i += 1; continue; }
    if (char === ',') { groups.push([]); i += 1; continue; }
    let neg = false;
    if (char === '!') { neg = true; i += 1; }
    let prefix = '';
    const op = /^(>=|<=|!=|==|=|>|<|\^)/.exec(input.slice(i));
    if (op) { prefix = op[1]; i += prefix.length; }
    let text = '';
    let quoted = false;
    let regex = false;
    let flags = '';
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      quoted = true;
      i += 1;
      while (i < length && input[i] !== quote) { text += input[i]; i += 1; }
      if (i < length) i += 1;
    } else if (input[i] === '/' && prefix === '') {
      const end = input.indexOf('/', i + 1);
      if (end > i) {
        regex = true;
        text = input.slice(i + 1, end);
        i = end + 1;
        while (i < length && /[a-z]/i.test(input[i])) { flags += input[i]; i += 1; }
      }
    }
    if (!quoted && !regex) {
      while (i < length && input[i] !== ' ' && input[i] !== '\t' && input[i] !== ',') { text += input[i]; i += 1; }
    }
    const token = { op: prefix, text, neg, quoted, regex, flags };
    if (token.text !== '' || token.op !== '' || token.neg || token.quoted || token.regex) groups[groups.length - 1].push(token);
  }
  return groups.filter(group => group.length > 0);
}

type Interval = { lo: number; hi: number };
type Condition =
  | { kind: 'empty'; neg: boolean }
  | { kind: 'text'; mode: 'contains' | 'exact' | 'starts' | 'ends' | 'regex'; value: string; re: RegExp | null; neg: boolean }
  | { kind: 'cmp'; op: '=' | '>' | '>=' | '<' | '<=' | 'range'; a: Interval | null; b: Interval | null; temporal: boolean; neg: boolean };

type CompiledFilter = { ok: true; test: (num: number, text: string) => boolean } | { ok: false; error: string };

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / FILTER_DAY_MS) * FILTER_DAY_MS;
}

/** A written date or time as the half-open interval [lo, hi) it denotes (2024 is the whole year); null when it is not valid for the column type. */
function temporalInterval(text: string, type: ColType, now: number): Interval | null {
  const word = text.trim().toLowerCase();
  if (type === 'time') {
    if (word === 'now') { const t = (now % FILTER_DAY_MS) / 1000; return { lo: t, hi: t + 1 }; }
    const t = parseTimePart(word);
    if (!Number.isFinite(t)) return null;
    return { lo: t, hi: t + (/^\d{1,2}:\d{2}(?:\s*[ap]m)?$/.test(word) ? 60 : 1) };
  }
  const today = startOfUtcDay(now);
  if (word === 'now') return { lo: now, hi: now + 1 };
  if (word === 'today') return { lo: today, hi: today + FILTER_DAY_MS };
  if (word === 'yesterday') return { lo: today - FILTER_DAY_MS, hi: today };
  if (word === 'tomorrow') return { lo: today + FILTER_DAY_MS, hi: today + 2 * FILTER_DAY_MS };
  const relative = /^([+-]?)(\d+)\s*([dwmy])$/.exec(word);
  if (relative) {
    const amount = (relative[1] === '-' ? -1 : 1) * Number(relative[2]);
    const base = new Date(today);
    if (relative[3] === 'd') base.setUTCDate(base.getUTCDate() + amount);
    else if (relative[3] === 'w') base.setUTCDate(base.getUTCDate() + amount * 7);
    else if (relative[3] === 'm') base.setUTCMonth(base.getUTCMonth() + amount);
    else base.setUTCFullYear(base.getUTCFullYear() + amount);
    const lo = base.getTime();
    return { lo, hi: lo + FILTER_DAY_MS };
  }
  let m = /^(\d{4})$/.exec(word);
  if (m) return { lo: utcMs(Number(m[1]), 1, 1), hi: utcMs(Number(m[1]) + 1, 1, 1) };
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(word);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { lo: utcMs(year, month, 1), hi: month === 12 ? utcMs(year + 1, 1, 1) : utcMs(year, month + 1, 1) };
  }
  const temporal = parseTemporal(text);
  if (!temporal || temporal.kind === 'time') return null;
  if (temporal.kind === 'date') return { lo: temporal.value, hi: temporal.value + FILTER_DAY_MS };
  if (type === 'date') { const day = startOfUtcDay(temporal.value); return { lo: day, hi: day + FILTER_DAY_MS }; }
  return { lo: temporal.value, hi: temporal.value + (/\d{1,2}:\d{2}:\d{2}/.test(text) ? 1000 : 60000) };
}

/** A written number as an interval: [value - half, value + half) for equality (matches the precision it was written with), the exact point otherwise. */
function numericInterval(text: string): Interval | null {
  const magnitude = parseMagnitude(text);
  if (!magnitude) return null;
  const half = 0.5 * 10 ** -magnitude.decimals * magnitude.scale;
  return { lo: magnitude.value - half, hi: magnitude.value + half };
}

function pointOf(interval: Interval): number {
  return (interval.lo + interval.hi) / 2;
}

function compileCondition(token: FilterToken, type: ColType, now: number): Condition | string {
  const text = token.text;
  if (!token.quoted && !token.regex && token.op === '' && text === '?') return { kind: 'empty', neg: token.neg };
  if (type === 'string') {
    if (token.regex) {
      try { return { kind: 'text', mode: 'regex', value: text, re: new RegExp(text, token.flags === '' ? 'i' : token.flags), neg: token.neg }; } catch { return `invalid regular expression /${text}/`; }
    }
    const lower = text.toLowerCase();
    if (token.op === '=' || token.op === '==') return { kind: 'text', mode: 'exact', value: lower, re: null, neg: token.neg };
    if (token.op === '^') return { kind: 'text', mode: 'starts', value: lower, re: null, neg: token.neg };
    if (token.op === '' && !token.quoted && lower.length > 1 && lower.endsWith('$')) return { kind: 'text', mode: 'ends', value: lower.slice(0, -1), re: null, neg: token.neg };
    return { kind: 'text', mode: 'contains', value: token.op + lower, re: null, neg: token.neg };
  }
  const temporal = type === 'date' || type === 'datetime' || type === 'time';
  const literal = (value: string): Interval | null => (temporal ? temporalInterval(value, type, now) : numericInterval(value));
  const range = token.op === '' ? /^(.*?)\.\.(.*)$/.exec(text) : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const a = range[1] === '' ? null : literal(range[1]);
    const b = range[2] === '' ? null : literal(range[2]);
    if (range[1] !== '' && !a) return `cannot read "${range[1]}" as ${COL_TYPE_NAMES[type]}`;
    if (range[2] !== '' && !b) return `cannot read "${range[2]}" as ${COL_TYPE_NAMES[type]}`;
    return { kind: 'cmp', op: 'range', a, b, temporal, neg: token.neg };
  }
  const interval = literal(text);
  if (!interval) return `cannot read "${text}" as ${COL_TYPE_NAMES[type]}`;
  const op = token.op === '' || token.op === '==' ? '=' : token.op;
  if (op === '=' || op === '>' || op === '>=' || op === '<' || op === '<=') return { kind: 'cmp', op, a: interval, b: null, temporal, neg: token.neg };
  return `unknown operator "${token.op}"`;
}

function evalCondition(condition: Condition, type: ColType, num: number, text: string): boolean {
  if (condition.kind === 'empty') {
    const empty = type === 'string' ? isEmptyCell(text) : Number.isNaN(num);
    return condition.neg ? !empty : empty;
  }
  if (condition.kind === 'text') {
    let hit: boolean;
    if (condition.mode === 'exact') hit = text === condition.value;
    else if (condition.mode === 'starts') hit = text.startsWith(condition.value);
    else if (condition.mode === 'ends') hit = text.endsWith(condition.value);
    else if (condition.mode === 'regex' && condition.re) hit = condition.re.test(text);
    else hit = text.includes(condition.value);
    return condition.neg ? !hit : hit;
  }
  if (Number.isNaN(num)) return condition.neg;
  const a = condition.a;
  const b = condition.b;
  let hit = false;
  if (condition.op === 'range') {
    hit = (a === null || num >= (condition.temporal ? a.lo : pointOf(a))) && (b === null || (condition.temporal ? num < b.hi : num <= pointOf(b)));
  } else if (a) {
    if (condition.op === '=') hit = num >= a.lo && num < a.hi;
    else if (condition.temporal) hit = condition.op === '>' ? num >= a.hi : condition.op === '>=' ? num >= a.lo : condition.op === '<' ? num < a.lo : num < a.hi;
    else hit = condition.op === '>' ? num > pointOf(a) : condition.op === '>=' ? num >= pointOf(a) : condition.op === '<' ? num < pointOf(a) : num <= pointOf(a);
  }
  return condition.neg ? !hit : hit;
}

/** Compiles a filter expression for a column type. `text` passed to test() must be lower-case; `num` is NaN when unavailable. Null for an empty expression. */
function compileFilter(input: string, type: ColType, now: number = Date.now()): CompiledFilter | null {
  if (input.trim() === '') return null;
  const groups = tokenizeFilter(input);
  if (!groups.length) return null;
  const compiled: Condition[][] = [];
  for (const group of groups) {
    const conditions: Condition[] = [];
    for (const token of group) {
      const condition = compileCondition(token, type, now);
      if (typeof condition === 'string') return { ok: false, error: condition };
      conditions.push(condition);
    }
    compiled.push(conditions);
  }
  return { ok: true, test: (num: number, text: string) => compiled.some(group => group.every(condition => evalCondition(condition, type, num, text))) };
}


export { ALL_COL_TYPES, COL_TYPE_LABELS, COL_TYPE_NAMES, COL_TYPE_CLASSES, COL_TYPE_PLACEHOLDERS, COL_TYPE_HELP, isEmptyCell, parseCellValue, detectColType, compileFilter };
export type { ColType, CompiledFilter };
