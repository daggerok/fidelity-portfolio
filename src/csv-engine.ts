// csv-engine.ts
/**
 * ============================================================================
 * AGENTIC AI ENFORCED SPECIFICATION & GUIDELINES (CRITICAL)
 * ============================================================================
 * 1. PERSIST ALL COMMENTS: Under no circumstances should ANY code comments,
 *    system design docs, or type descriptors be removed or truncated.
 * 2. AGENT READ-WRITE RULE: If a future deployment or agent updates the code,
 *    this header section and related documentation blocks MUST be kept accurate,
 *    expanded, and dynamically synchronized with the feature upgrades.
 * 3. PURITY: This module is React-free and DOM-free apart from the explicitly
 *    marked download helper, so the whole engine is unit-testable under `bun test`.
 * ============================================================================
 *
 * ============================================================================
 * MODULE: CSV engine — parsing, type detection, sorting, filtering, export
 * ============================================================================
 * Ported from daggerok/csv (single-file `main.tsx`) and extracted into a module
 * so the storage layer and the UI can both depend on it without duplication.
 *
 * 1. [Heuristic CSV Parser — `parseCSVRow` / `extractValidTableData`]
 *    Broker exports wrap the real table in preamble/postamble prose. The
 *    heuristic parses every line honouring RFC-4180 quoting, histograms the
 *    column counts, and keeps the longest contiguous block whose width matches
 *    the modal width — stripping account summaries and footnotes.
 *
 * 2. [Column Type System]
 *    'string' | 'number' | 'percent' | 'currency' | 'marketcap'.
 *    Detected by regex sampling (60% of a 20-row sample must match); overridable
 *    per column from the header badge.
 *
 * 3. [Smart Sort Engine]
 *    Each type maps to a value extractor so `$1.2B` sorts above `$999M` and
 *    `(1,234.00)` is read as −1234. Strings use `Intl.Collator` natural order,
 *    so `file2` precedes `file10`. Blank/`--`/`N/A` always sink to the bottom.
 *
 * 4. [Filter Engine]
 *    Grammar (identical in both modes):
 *      SPACE = AND · COMMA = OR · !token = NOT · "quoted phrase" = one token
 *    STRING MODE  (string | marketcap): case-insensitive substring.
 *    NUMERIC MODE (number | percent | currency): = != > >= < <=
 *      bare `22` → `=22`; `!22` → `!=22`; `!>10` → `<=10`.
 * ============================================================================
 */

// ============================================================================
// TYPES
// ============================================================================

export type ColumnType = 'string' | 'number' | 'percent' | 'currency' | 'marketcap';

export const ALL_COLUMN_TYPES: ColumnType[] = ['string', 'number', 'percent', 'currency', 'marketcap'];

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  string: 'ABC',
  number: '123',
  percent: '%',
  currency: '$',
  marketcap: 'Cap',
};

export const COLUMN_TYPE_COLORS: Record<ColumnType, string> = {
  string: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  number: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
  percent: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300',
  currency: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
  marketcap: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
};

export const NUMERIC_FILTER_TYPES: Set<ColumnType> = new Set(['number', 'percent', 'currency']);

export interface SortState {
  columnIndex: number | null;
  direction: 'asc' | 'desc';
}

export const DEFAULT_SORT_STATE: SortState = { columnIndex: null, direction: 'asc' };

export interface StringFilterCondition {
  type: 'string';
  value: string;
  negated: boolean;
}
export interface NumericFilterCondition {
  type: 'numeric';
  value: number;
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=';
}
export type FilterCondition = StringFilterCondition | NumericFilterCondition;
export interface FilterExpression {
  orGroups: FilterCondition[][];
}

export const TYPE_DETECTION_SAMPLE_SIZE = 20;
export const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Values treated as "no value" by detection, sorting and filtering alike. */
const BLANKS = new Set(['', '--', 'N/A', 'n/a', '-']);

// ============================================================================
// PARSER
// ============================================================================

/** RFC-4180-aware single-row splitter (handles `""` escapes inside quotes). */
export function parseCSVRow(row: string): string[] {
  const result: string[] = [];
  let inQuotes = false;
  let currentValue = '';
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') {
      if (inQuotes && row[i + 1] === '"') {
        currentValue += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(currentValue.trim());
      currentValue = '';
    } else {
      currentValue += char;
    }
  }
  result.push(currentValue.trim());
  return result;
}

/**
 * Isolates the real table from a noisy export.
 * Returns every parsed line unchanged when no dominant width can be found.
 */
export function extractValidTableData(rawText: string): string[][] {
  const lines = rawText.split(/\r?\n/).filter((line) => line.trim() !== '');
  const parsedLines = lines.map(parseCSVRow);
  if (parsedLines.length === 0) return [];

  const colCounts: Record<number, number> = {};
  parsedLines.forEach((row) => {
    if (row.length > 2) colCounts[row.length] = (colCounts[row.length] || 0) + 1;
  });

  let targetColLength = 0;
  let maxOccurrences = 0;
  for (const [lengthStr, count] of Object.entries(colCounts)) {
    if (count > maxOccurrences) {
      maxOccurrences = count;
      targetColLength = parseInt(lengthStr, 10);
    }
  }
  if (targetColLength === 0) targetColLength = Math.max(...parsedLines.map((r) => r.length));

  const tableData: string[][] = [];
  let isRecording = false;
  for (const row of parsedLines) {
    if (row.length === targetColLength || row.length === targetColLength + 1) {
      isRecording = true;
      tableData.push(row.slice(0, targetColLength));
    } else if (isRecording && row.length < targetColLength - 1) {
      break;
    }
  }
  return tableData.length > 0 ? tableData : parsedLines;
}

// ============================================================================
// COLUMN TYPE DETECTION
// ============================================================================

const TYPE_PATTERNS: { type: ColumnType; pattern: RegExp }[] = [
  { type: 'marketcap', pattern: /\$[\d,.]+\s*[KMBT]/i },
  { type: 'percent', pattern: /^-?[\d,.]+\s*%$/ },
  { type: 'currency', pattern: /^[($-]*\$[\d,.]+\)?$/ },
  { type: 'number', pattern: /^[+-]?[\d,]+\.?\d*$/ },
];

/** Samples up to 20 non-blank cells; a type wins at ≥60% match. */
export function detectColumnType(rows: string[][], colIndex: number): ColumnType {
  const samples: string[] = [];
  for (let i = 0; i < rows.length && samples.length < TYPE_DETECTION_SAMPLE_SIZE; i++) {
    const val = (rows[i]?.[colIndex] || '').trim();
    if (!BLANKS.has(val)) samples.push(val);
  }
  if (samples.length === 0) return 'string';
  const threshold = samples.length * 0.6;
  for (const { type, pattern } of TYPE_PATTERNS) {
    if (samples.filter((s) => pattern.test(s)).length >= threshold) return type;
  }
  return 'string';
}

// ============================================================================
// VALUE EXTRACTION & SORTING
// ============================================================================

const SUFFIX_MULTIPLIERS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** Type-aware comparable value; `null` means "blank, sort last". */
export function extractSortValue(cellValue: string, colType: ColumnType): number | string | null {
  const trimmed = (cellValue ?? '').trim();
  if (BLANKS.has(trimmed)) return null;
  switch (colType) {
    case 'number': {
      const n = parseFloat(trimmed.replace(/,/g, ''));
      return isNaN(n) ? null : n;
    }
    case 'percent': {
      const n = parseFloat(trimmed.replace(/%/g, '').replace(/,/g, ''));
      return isNaN(n) ? null : n;
    }
    case 'currency': {
      let c = trimmed.replace(/[$,\s]/g, '');
      const neg = /^\(.*\)$/.test(trimmed) || trimmed.startsWith('-');
      c = c.replace(/[()]/g, '').replace(/^-/, '');
      const n = parseFloat(c);
      if (isNaN(n)) return null;
      return neg ? -n : n;
    }
    case 'marketcap': {
      const m = trimmed.match(/\$([\d,.]+)\s*([KMBT])/i);
      if (m) {
        const b = parseFloat(m[1].replace(/,/g, ''));
        return isNaN(b) ? null : b * (SUFFIX_MULTIPLIERS[m[2].toUpperCase()] || 1);
      }
      const f = trimmed.match(/\$([\d,.]+)/);
      if (f) {
        const n = parseFloat(f[1].replace(/,/g, ''));
        return isNaN(n) ? null : n;
      }
      return null;
    }
    default:
      return trimmed;
  }
}

export function extractNumericValue(cellValue: string, colType: ColumnType): number | null {
  const v = extractSortValue(cellValue, colType);
  return typeof v === 'number' ? v : null;
}

/** Comparator honouring direction, type, and blanks-last. */
export function getComparator(
  colIndex: number,
  direction: 'asc' | 'desc',
  colType: ColumnType,
): (a: string[], b: string[]) => number {
  const m = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const aV = extractSortValue(a[colIndex] || '', colType);
    const bV = extractSortValue(b[colIndex] || '', colType);
    if (aV === null && bV === null) return 0;
    if (aV === null) return 1;
    if (bV === null) return -1;
    if (colType === 'string') return m * naturalCollator.compare(aV as string, bV as string);
    return m * ((aV as number) - (bV as number));
  };
}

// ============================================================================
// FILTER ENGINE
// ============================================================================

/** Splits input into tokens, honouring quotes, `!` negation and `,` separators. */
export function tokenizeFilterInput(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = input.length;
  while (i < len) {
    if (input[i] === ' ' || input[i] === '\t') {
      i++;
      continue;
    }
    if (input[i] === ',') {
      tokens.push(',');
      i++;
      continue;
    }
    let token = '';
    if (input[i] === '!' && i + 1 < len) {
      if (input[i + 1] === '"' || input[i + 1] === "'") {
        token = '!';
        i++;
      } else {
        token = '!';
        i++;
        while (i < len && input[i] !== ' ' && input[i] !== '\t' && input[i] !== ',') {
          token += input[i];
          i++;
        }
        tokens.push(token);
        continue;
      }
    }
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      while (i < len && input[i] !== quote) {
        token += input[i];
        i++;
      }
      if (i < len) i++;
      tokens.push(token);
      continue;
    }
    while (i < len && input[i] !== ' ' && input[i] !== '\t' && input[i] !== ',') {
      token += input[i];
      i++;
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

export function parseStringToken(token: string): StringFilterCondition {
  const negated = token.startsWith('!');
  return { type: 'string', value: (negated ? token.slice(1) : token).toLowerCase(), negated };
}

const NUMERIC_TOKEN_REGEX = /^(!?)(>=|<=|!=|>|<|=)?(-?[\d,.]+)$/;

/** `>=10` / `!22` / `-3.5`; returns null when the token is not numeric. */
export function parseNumericToken(token: string): NumericFilterCondition | null {
  const match = token.match(NUMERIC_TOKEN_REGEX);
  if (!match) return null;
  const [, negPrefix, operatorStr, numStr] = match;
  const value = parseFloat(numStr.replace(/,/g, ''));
  if (isNaN(value)) return null;
  let operator: NumericFilterCondition['operator'];
  if (operatorStr) {
    if (negPrefix === '!') {
      const inv: Record<string, NumericFilterCondition['operator']> = {
        '>': '<=',
        '>=': '<',
        '<': '>=',
        '<=': '>',
        '=': '!=',
        '!=': '=',
      };
      operator = inv[operatorStr] || '=';
    } else {
      operator = operatorStr as NumericFilterCondition['operator'];
    }
  } else {
    operator = negPrefix === '!' ? '!=' : '=';
  }
  return { type: 'numeric', value, operator };
}

export function parseFilterExpression(input: string, colType: ColumnType): FilterExpression | null {
  const trimmed = (input ?? '').trim();
  if (trimmed === '') return null;
  const tokens = tokenizeFilterInput(trimmed);
  if (tokens.length === 0) return null;
  const isNumericMode = NUMERIC_FILTER_TYPES.has(colType);
  const orGroups: FilterCondition[][] = [];
  let currentGroup: FilterCondition[] = [];
  for (const token of tokens) {
    if (token === ',') {
      if (currentGroup.length > 0) {
        orGroups.push(currentGroup);
        currentGroup = [];
      }
      continue;
    }
    if (isNumericMode) {
      const nc = parseNumericToken(token);
      currentGroup.push(nc ?? parseStringToken(token));
    } else {
      currentGroup.push(parseStringToken(token));
    }
  }
  if (currentGroup.length > 0) orGroups.push(currentGroup);
  return orGroups.length > 0 ? { orGroups } : null;
}

export function matchesFilter(cellValue: string, filter: FilterExpression, colType: ColumnType): boolean {
  const cellLower = (cellValue ?? '').toLowerCase();
  const cellNumeric = NUMERIC_FILTER_TYPES.has(colType) ? extractNumericValue(cellValue, colType) : null;
  return filter.orGroups.some((group) =>
    group.every((condition) => {
      if (condition.type === 'string') {
        const c = cellLower.includes(condition.value);
        return condition.negated ? !c : c;
      }
      if (cellNumeric === null) return condition.operator === '!=';
      switch (condition.operator) {
        case '=':
          return cellNumeric === condition.value;
        case '!=':
          return cellNumeric !== condition.value;
        case '>':
          return cellNumeric > condition.value;
        case '>=':
          return cellNumeric >= condition.value;
        case '<':
          return cellNumeric < condition.value;
        case '<=':
          return cellNumeric <= condition.value;
        default:
          return false;
      }
    }),
  );
}

/** Applies every active column filter with AND semantics across columns. */
export function applyFilters(
  rows: string[][],
  filters: Record<number, string>,
  getColType: (colIndex: number) => ColumnType,
): string[][] {
  const parsed: { colIndex: number; expression: FilterExpression; colType: ColumnType }[] = [];
  for (const [key, raw] of Object.entries(filters)) {
    const colIndex = parseInt(key, 10);
    const colType = getColType(colIndex);
    const expression = parseFilterExpression(raw, colType);
    if (expression) parsed.push({ colIndex, expression, colType });
  }
  if (parsed.length === 0) return rows;
  return rows.filter((row) =>
    parsed.every(({ colIndex, expression, colType }) => matchesFilter(row[colIndex] || '', expression, colType)),
  );
}

// ============================================================================
// EXPORT HELPERS
// ============================================================================

/** RFC-4180 field escaping. */
export function escapeCSVField(field: string): string {
  const value = field ?? '';
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildCSVLine(cells: string[]): string {
  return cells.map((cell) => escapeCSVField(cell || '')).join(',');
}

export function buildCSVString(headers: string[], rows: string[][]): string {
  return [buildCSVLine(headers), ...rows.map(buildCSVLine)].join('\r\n');
}

export function buildCSVStringFromRows(rows: string[][]): string {
  return rows.map(buildCSVLine).join('\r\n');
}

/** Pads/truncates a row so merged exports stay rectangular. */
export function padCSVRow(row: string[], width: number): string[] {
  if (row.length >= width) return row.slice(0, width);
  return [...row, ...Array.from({ length: width - row.length }, () => '')];
}

/** `data.csv` → `data_exported.csv`. */
export function makeExportFileName(originalName: string): string {
  const dotIndex = originalName.lastIndexOf('.');
  if (dotIndex > 0) {
    return `${originalName.substring(0, dotIndex)}_exported${originalName.substring(dotIndex)}`;
  }
  return `${originalName}_exported.csv`;
}

/** DOM-only. Triggers a browser download. */
export function downloadFile(content: string, fileName: string, mimeType = 'text/csv;charset=utf-8;'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Total number of rows across datasets — drives the "expensive toggle" spinner. */
export function getTotalRowCount(dataSets: { data: string[][] }[]): number {
  return dataSets.reduce((sum, ds) => sum + ds.data.length, 0);
}

// ============================================================================
// DEMO SEED
// ============================================================================

/**
 * Ships one tiny dataset so a fresh visitor sees a populated table before
 * importing anything or configuring Google. Referenced by the empty state.
 */
export const DEMO_CSV = `Ticker,Company,Price,Change,Market Cap
AAPL,Apple Inc.,$232.10,1.24%,$3.51T
MSFT,Microsoft Corp.,$429.03,-0.42%,$3.19T
NVDA,NVIDIA Corp.,$134.81,2.98%,$3.31T
AMZN,Amazon.com Inc.,$201.44,0.31%,$2.11T
GOOGL,Alphabet Inc.,$191.22,-1.05%,$2.34T
BRK-B,Berkshire Hathaway,$463.88,0.12%,$1.00T
JPM,JPMorgan Chase,$248.61,0.87%,$699.4B
XOM,Exxon Mobil,$107.33,-0.55%,$472.1B`;

export const DEMO_FILE_NAME = 'demo-portfolio.csv';
