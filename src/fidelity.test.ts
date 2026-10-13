/// <reference types="bun" />
import { describe, it, expect } from 'bun:test';
import {
  readFidelityAccounts, splitRow, schemaFromHeader, parseMoney, money, formatMarketCap, parseMarketCap,
  activeColumnLabels, watchlistReport, investmentsReport, dividendsReport, dripsReport, parseFidelityDate,
  buildReport, reportText, readTable,
} from './fidelity';

const HEADER = '﻿Account number,Account name,Symbol,Description,Cost basis total,Current value,Last price,Dist. rate,Payment frequency,Market cap,Ex-date,Pay date,Sector';
const row = (acct: string, sym: string, cost: string, value: string, price: string, rate: string, freq: string, cap: string, ex: string, pay: string, sector: string) =>
  `${acct},Main,${sym},DESC,${cost},${value},${price},${rate},${freq},${cap},${ex},${pay},${sector},`;
const SAMPLE = [
  HEADER,
  'Z1,Main,SPAXX,HELD IN MONEY MARKET,,$94.32,,--,--,--,--,--,--,',
  row('Z1', 'NVDA', '$5699.05', '$6744.54', '$233.95', '0.43%', 'Quarterly', 'Mega cap ($5.56T)', 'Sep-10-2026', 'Oct-01-2026', 'Information technology'),
  row('Z1', 'ITW', '$20.00', '$26.55', '$262.50', '2.64%', 'Quarterly', 'Large cap ($76.10B)', 'Sep-30-2026', 'Oct-09-2026', 'Industrials'),
  row('Z1', 'SCHD', '$3.10', '$2.05', '$27.10', '3.80%', 'Quarterly', '--', 'Dec-10-2026', 'Dec-15-2026', '--'),
  row('Z1', 'BRKB', '$4.00', '$4.10', '$500.00', '--', '--', 'Mega cap ($1.05T)', '--', '--', 'Financials'),
  'Z1,Main,Pending activity,,,,,,,,-$91.40,,,,,',
  '',
  '"The data and information in this spreadsheet is provided to you solely for your use, not for distribution."',
  '"Date downloaded Oct-02-2026 8:26 p.m ET"',
].join('\r\n');

const [account] = readFidelityAccounts('positions.csv', SAMPLE) ?? [];

describe('parsing', () => {
  it('splits like Java: quotes protect commas, trailing empty fields are dropped', () => {
    expect(splitRow('a,"1,234",b,,')).toEqual(['a', '1,234', 'b']);
    expect(splitRow(' x , "y" ')).toEqual(['x', 'y']);
  });

  it('finds columns by name, BOM and case tolerant, Dist. yield as a fallback', () => {
    const schema = schemaFromHeader('﻿ACCOUNT NUMBER,symbol,Dist. yield,Sector');
    expect([schema.symbol, schema.distYield, schema.sector, schema.marketCap]).toEqual([1, 2, 3, -1]);
  });

  it('keeps only rows of the table and groups an all-accounts file by account', () => {
    expect(account.name).toBe('Main');
    expect(account.lines.length).toBe(6);
    const two = readFidelityAccounts('all.csv', `${HEADER}\nA1,One,X,,,,,,,,,,\nB2,Two,Y,,,,,,,,,,\nA1,One,Z,,,,,,,,,,`) ?? [];
    expect(two.map(a => [a.name, a.lines.length])).toEqual([['One', 2], ['Two', 1]]);
    expect(readFidelityAccounts('other.csv', 'Symbol,Account\nAAPL,x')).toBeNull();
  });

  it('reads money, market caps and dates like the Scala helpers', () => {
    expect(money(parseMoney('+$1,045.495'))).toBe('1045.50');
    expect(money(parseMoney('--'))).toBe('0.00');
    expect(money(parseMoney('-$91.40'))).toBe('-91.40');
    expect(formatMarketCap('Mega cap ($401.47B)')).toBe('401.47B');
    expect(parseMarketCap('Mega cap ($5.56T)')).toBe(5_560_000_000_000);
    expect(parseMarketCap('--')).toBe(0);
    expect(parseFidelityDate('Sep-10-2026')).toBe('2026-09-10');
    expect(parseFidelityDate('SEP-10-2026')).toBeNull();
    expect(parseFidelityDate('Feb-30-2026')).toBe('2026-02-28');
  });

  it('reads any CSV as a table: skips preamble and disclaimers, keeps the header when rows end with a comma', () => {
    const table = readTable(SAMPLE);
    expect(table.columns[0]).toBe('Account number');
    expect(table.columns.length).toBe(13);
    expect(table.rows.length).toBe(6);
    const plain = readTable('Report for, Q3, 2026\n\nname,value\na,1\nb,"2,5"\n');
    expect(plain).toEqual({ columns: ['name', 'value'], rows: [['a', '1'], ['b', '2,5']] });
  });
});

describe('reports', () => {
  it('active columns stop after the first kept column without zeros', () => {
    const info = new Map<string, [boolean, boolean]>([['a', [false, true]], ['b', [true, true]], ['c', [true, false]], ['d', [true, false]]]);
    expect([...activeColumnLabels(['a', 'b', 'c', 'd'], info)]).toEqual(['b', 'c']);
  });

  it('watchlist: tickers by market cap, ETFs have no sector, aliases expanded, SPAXX is an ETF', () => {
    expect(watchlistReport([account], ['Stock', 'ETF']).rows.map(r => r[0])).toEqual(['NVDA', 'BRKB', 'BRK.B', 'ITW', 'SPAXX', 'SCHD']);
    expect(watchlistReport([account], ['ETF']).rows.map(r => r[0])).toEqual(['SPAXX', 'SCHD']);
  });

  it('investments: dollars still missing to each target, header shows only useful columns', () => {
    const table = investmentsReport(account);
    expect(table.columns.slice(0, 6)).toEqual(['Symbol', 'Current $', 'Costs $', 'Market cap', '$5 Diff', '$6 Diff']);
    expect(table.rows.map(r => r[0])).toEqual(['ITW', 'BRKB', 'SCHD']);
    expect(table.rows[2].slice(0, 6)).toEqual(['SCHD', '2.05', '3.10', '', '1.90', '2.90']);
    expect(table.columns.at(-1)).toBe('$21 Diff');
  });

  it('dividends: money needed so a payout buys 0.001 share, at 1x and up', () => {
    const table = dividendsReport(account);
    expect(table.columns.slice(0, 6)).toEqual(['Symbol', 'Yield %', 'Value', '0.001 Costs $', 'Baseline $', '1x Diff $']);
    const itw = table.rows.find(r => r[0] === 'ITW');
    expect(itw?.slice(0, 6)).toEqual(['ITW', '2.64', '26.55', '0.26', '20.00', '13.22']);
  });

  it('DRIPs: shortfall in dollars and shares, dates only when after the run date', () => {
    const table = dripsReport(account, '2026-10-02');
    expect(table.rows.map(r => r[0])).toEqual(['SCHD', 'ITW']);
    expect(table.rows[1]).toEqual(['ITW', '2.64', '26.55', '39.77', '13.22', '0.101', '0.152', '0.051', 'Quarterly', '04', '', '2026-10-09']);
  });

  it('buildReport keeps a broken account as an error tab and prints the Scala text format', () => {
    const broken = { ...account, id: 'x', header: 'no header' };
    const sheets = buildReport('dividends', [account, broken]);
    expect(sheets[1].error).toContain('Fidelity header row not found');
    expect(reportText('watchlists', { columns: ['Symbol'], rows: [['A'], ['B']] })).toBe('A\nB\n');
    expect(reportText('drips', { columns: ['S', 'V'], rows: [['A', '1']] })).toBe('S,V\nA,1\n');
  });
});
