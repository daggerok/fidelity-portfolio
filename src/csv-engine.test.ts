// csv-engine.test.ts
/**
 * ============================================================================
 * TESTS: CSV parsing, type detection, sorting, filtering and export
 * ============================================================================
 * The engine is ported from daggerok/csv; these tests pin the behaviour that
 * the UI depends on so future refactors cannot silently change it.
 * ============================================================================
 */

import { describe, expect, test } from 'bun:test';

import {
  ALL_COLUMN_TYPES,
  DEMO_CSV,
  applyFilters,
  buildCSVString,
  detectColumnType,
  escapeCSVField,
  extractNumericValue,
  extractSortValue,
  extractValidTableData,
  getComparator,
  getTotalRowCount,
  makeExportFileName,
  matchesFilter,
  padCSVRow,
  parseCSVRow,
  parseFilterExpression,
  parseNumericToken,
  tokenizeFilterInput,
  type ColumnType,
} from './csv-engine';

// ============================================================================
// PARSER
// ============================================================================

describe('parseCSVRow', () => {
  test('splits a plain row and trims whitespace', () => {
    expect(parseCSVRow('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  test('honours quoted fields containing commas', () => {
    expect(parseCSVRow('"Apple, Inc.",232.10')).toEqual(['Apple, Inc.', '232.10']);
  });

  test('unescapes doubled quotes', () => {
    expect(parseCSVRow('"He said ""hi""",x')).toEqual(['He said "hi"', 'x']);
  });

  test('preserves empty trailing fields', () => {
    expect(parseCSVRow('a,,')).toEqual(['a', '', '']);
  });
});

describe('extractValidTableData', () => {
  test('strips preamble and postamble around the real table', () => {
    const raw = [
      'Account summary for June',
      'Generated 2026-07-01',
      '',
      'Ticker,Company,Price,Qty',
      'AAPL,Apple,232.10,10',
      'MSFT,Microsoft,429.03,5',
      '',
      'Total,,,15',
    ].join('\n');

    const table = extractValidTableData(raw);

    expect(table[0]).toEqual(['Ticker', 'Company', 'Price', 'Qty']);
    expect(table).toContainEqual(['AAPL', 'Apple', '232.10', '10']);
    // The 1-column prose lines are gone.
    expect(table.some((r) => r[0] === 'Account summary for June')).toBe(false);
  });

  test('returns [] for empty input', () => {
    expect(extractValidTableData('')).toEqual([]);
  });

  test('falls back to all parsed lines when no dominant width exists', () => {
    expect(extractValidTableData('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  test('parses the bundled demo dataset into 9 rows', () => {
    const table = extractValidTableData(DEMO_CSV);
    expect(table.length).toBe(9); // header + 8 tickers
    expect(table[0]).toEqual(['Ticker', 'Company', 'Price', 'Change', 'Market Cap']);
  });
});

// ============================================================================
// TYPE DETECTION
// ============================================================================

describe('detectColumnType', () => {
  const rows = [
    ['AAPL', '232.10', '1.24%', '$232.10', '$3.51T'],
    ['MSFT', '429.03', '-0.42%', '$429.03', '$3.19T'],
    ['NVDA', '134.81', '2.98%', '$134.81', '$3.31T'],
  ];

  test('detects strings', () => expect(detectColumnType(rows, 0)).toBe('string'));
  test('detects numbers', () => expect(detectColumnType(rows, 1)).toBe('number'));
  test('detects percents', () => expect(detectColumnType(rows, 2)).toBe('percent'));
  test('detects currency', () => expect(detectColumnType(rows, 3)).toBe('currency'));
  test('detects market cap', () => expect(detectColumnType(rows, 4)).toBe('marketcap'));

  test('an all-blank column falls back to string', () => {
    expect(detectColumnType([['--'], ['N/A'], ['']], 0)).toBe('string');
  });

  test('exposes exactly five cycleable types', () => {
    expect(ALL_COLUMN_TYPES).toEqual(['string', 'number', 'percent', 'currency', 'marketcap']);
  });
});

// ============================================================================
// VALUE EXTRACTION
// ============================================================================

describe('extractSortValue', () => {
  test('parses thousands separators', () => expect(extractSortValue('1,234.5', 'number')).toBe(1234.5));
  test('parses percents as plain numbers', () => expect(extractSortValue('-4.2%', 'percent')).toBe(-4.2));
  test('parses currency', () => expect(extractSortValue('$1,234.00', 'currency')).toBe(1234));
  test('reads parenthesised currency as negative', () => expect(extractSortValue('($500.00)', 'currency')).toBe(-500));

  test('scales market cap suffixes', () => {
    expect(extractSortValue('$3.51T', 'marketcap')).toBeCloseTo(3.51e12);
    expect(extractSortValue('$699.4B', 'marketcap')).toBeCloseTo(699.4e9);
    expect(extractSortValue('$12M', 'marketcap')).toBeCloseTo(12e6);
  });

  test('treats blanks as null so they sort last', () => {
    for (const blank of ['', '--', 'N/A', 'n/a']) {
      expect(extractSortValue(blank, 'number')).toBeNull();
    }
  });

  test('extractNumericValue returns null for text columns', () => {
    expect(extractNumericValue('AAPL', 'string')).toBeNull();
  });
});

// ============================================================================
// SORTING
// ============================================================================

describe('getComparator', () => {
  test('sorts market caps numerically, not lexically', () => {
    const rows = [['$999.0M'], ['$1.2B'], ['$50.0K']];
    const sorted = [...rows].sort(getComparator(0, 'desc', 'marketcap'));
    expect(sorted.map((r) => r[0])).toEqual(['$1.2B', '$999.0M', '$50.0K']);
  });

  test('uses natural order for strings so file2 precedes file10', () => {
    const rows = [['file10'], ['file2'], ['file1']];
    const sorted = [...rows].sort(getComparator(0, 'asc', 'string'));
    expect(sorted.map((r) => r[0])).toEqual(['file1', 'file2', 'file10']);
  });

  test('pushes blanks to the bottom in both directions', () => {
    const rows = [['5'], [''], ['1']];
    expect([...rows].sort(getComparator(0, 'asc', 'number')).map((r) => r[0])).toEqual(['1', '5', '']);
    expect([...rows].sort(getComparator(0, 'desc', 'number')).map((r) => r[0])).toEqual(['5', '1', '']);
  });
});

// ============================================================================
// FILTER ENGINE
// ============================================================================

describe('tokenizeFilterInput', () => {
  test('space separates tokens', () => expect(tokenizeFilterInput('aa bb')).toEqual(['aa', 'bb']));
  test('comma is emitted as its own token', () => expect(tokenizeFilterInput('aa,bb')).toEqual(['aa', ',', 'bb']));
  test('quotes group a phrase', () => expect(tokenizeFilterInput('"multi word" x')).toEqual(['multi word', 'x']));
  test('bang marks negation', () => expect(tokenizeFilterInput('!foo')).toEqual(['!foo']));
});

describe('parseNumericToken', () => {
  test('bare number means equals', () => expect(parseNumericToken('22')).toEqual({ type: 'numeric', value: 22, operator: '=' }));
  test('!22 means not-equals', () => expect(parseNumericToken('!22')).toEqual({ type: 'numeric', value: 22, operator: '!=' }));
  test('>=10 is preserved', () => expect(parseNumericToken('>=10')).toEqual({ type: 'numeric', value: 10, operator: '>=' }));
  test('!>10 inverts to <=10', () => expect(parseNumericToken('!>10')).toEqual({ type: 'numeric', value: 10, operator: '<=' }));
  test('non-numeric returns null', () => expect(parseNumericToken('AAPL')).toBeNull());
});

describe('matchesFilter', () => {
  const match = (cell: string, expr: string, type: ColumnType) => {
    const parsed = parseFilterExpression(expr, type);
    return parsed ? matchesFilter(cell, parsed, type) : true;
  };

  test('substring matching is case-insensitive', () => {
    expect(match('Apple Inc.', 'apple', 'string')).toBe(true);
  });

  test('space means AND', () => {
    expect(match('Apple Inc.', 'apple inc', 'string')).toBe(true);
    expect(match('Apple Inc.', 'apple google', 'string')).toBe(false);
  });

  test('comma means OR', () => {
    expect(match('Apple Inc.', 'google,apple', 'string')).toBe(true);
  });

  test('bang negates', () => {
    expect(match('Apple Inc.', '!google', 'string')).toBe(true);
    expect(match('Apple Inc.', '!apple', 'string')).toBe(false);
  });

  test('quoted phrases match as one token', () => {
    expect(match('Berkshire Hathaway', '"berkshire hathaway"', 'string')).toBe(true);
    expect(match('Berkshire Inc', '"berkshire hathaway"', 'string')).toBe(false);
  });

  test('numeric ranges combine with AND', () => {
    expect(match('25', '>10 <50', 'number')).toBe(true);
    expect(match('75', '>10 <50', 'number')).toBe(false);
  });

  test('numeric OR works across groups', () => {
    expect(match('5', '>100, <10', 'number')).toBe(true);
  });
});

describe('applyFilters', () => {
  const rows = [
    ['AAPL', '232.10'],
    ['MSFT', '429.03'],
    ['NVDA', '134.81'],
  ];
  const types: ColumnType[] = ['string', 'number'];
  const getType = (i: number) => types[i];

  test('no filters returns the original array reference', () => {
    expect(applyFilters(rows, {}, getType)).toBe(rows);
  });

  test('filters on a single column', () => {
    expect(applyFilters(rows, { 0: 'aapl' }, getType)).toEqual([['AAPL', '232.10']]);
  });

  test('multiple columns combine with AND', () => {
    expect(applyFilters(rows, { 0: 'a', 1: '>200' }, getType)).toEqual([['AAPL', '232.10']]);
  });

  test('a whitespace-only filter is ignored', () => {
    expect(applyFilters(rows, { 0: '   ' }, getType)).toEqual(rows);
  });
});

// ============================================================================
// EXPORT
// ============================================================================

describe('CSV export helpers', () => {
  test('escapes commas, quotes and newlines', () => {
    expect(escapeCSVField('a,b')).toBe('"a,b"');
    expect(escapeCSVField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCSVField('line\nbreak')).toBe('"line\nbreak"');
    expect(escapeCSVField('plain')).toBe('plain');
  });

  test('builds a CRLF-delimited document with a header', () => {
    expect(buildCSVString(['a', 'b'], [['1', '2']])).toBe('a,b\r\n1,2');
  });

  test('pads and truncates rows to a fixed width', () => {
    expect(padCSVRow(['a'], 3)).toEqual(['a', '', '']);
    expect(padCSVRow(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
  });

  test('derives an export filename', () => {
    expect(makeExportFileName('data.csv')).toBe('data_exported.csv');
    expect(makeExportFileName('report')).toBe('report_exported.csv');
  });

  test('counts rows across datasets', () => {
    expect(getTotalRowCount([{ data: [[], []] }, { data: [[]] }])).toBe(3);
  });
});
