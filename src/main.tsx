/// <reference types="bun" />
// Fidelity reports: import Fidelity Portfolio_Positions CSV exports, look at them as tables, and get the
// watchlists, investments, dividends and DRIPs reports of the old scio-examples jobs, computed in a web
// worker while you browse. Every table sorts, filters (the ETF apps' filter grammar) and exports.
import React, { useCallback, useEffect, useMemo, useRef, useState, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { zipSync, strToU8 } from 'fflate';
import {
  Archive, ArrowDown, ArrowUp, Columns3, Copy, Download, FileSpreadsheet, Filter, FilterX, LoaderCircle, Moon, Search, Sun, Trash2,
  TriangleAlert, Upload, X,
} from 'lucide-react';
import clsx from 'clsx';
import { readFidelityAccounts, readTable, reportText, todayIso, REPORT_KINDS, type Account, type ReportKind, type ReportSheet, type ReportTable } from './fidelity';
import {
  ALL_COL_TYPES, COL_TYPE_CLASSES, COL_TYPE_HELP, COL_TYPE_LABELS, COL_TYPE_PLACEHOLDERS, compileFilter, detectColType, parseCellValue, type ColType,
} from './filter-engine';
import './index.css';

// ---- storage (settings only; files are kept only when "Remember files" is on) -------------------

const PREFIX = 'fidelity-reports';
const FILES_KEY = `${PREFIX}-files`;
const REMEMBER_KEY = `${PREFIX}-remember-files`;
const THEME_KEY = `${PREFIX}-theme`;
const FILTER_DEBOUNCE_MS = 250;

function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean = () => true): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch { return fallback; }
}

function save(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

function drop(key: string): void {
  try { localStorage.removeItem(key); } catch { /* blocked storage */ }
}

const isRecordOfStrings = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');

// ---- files --------------------------------------------------------------------------------

type ImportedFile = { name: string; text: string; table: ReportTable; accounts: Account[] | null };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function toImported(name: string, text: string): ImportedFile {
  return { name, text, table: readTable(text), accounts: readFidelityAccounts(name, text) };
}

/** Account tabs need unique names: two accounts called the same get the last 4 characters of their number. */
function namedAccounts(files: ImportedFile[]): Account[] {
  const accounts = files.flatMap(f => f.accounts ?? []);
  const counts = new Map<string, number>();
  accounts.forEach(a => counts.set(a.name, (counts.get(a.name) ?? 0) + 1));
  return accounts.map(a => (counts.get(a.name) === 1 ? a : { ...a, name: `${a.name} *${a.number.slice(-4)}` }));
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_');

// ---- table --------------------------------------------------------------------------------

type SortState = { col: string; dir: 'asc' | 'desc' } | null;
type TableSettings = { filters: Record<string, string>; types: Record<string, string>; hidden: string[]; showFilters: boolean };

const DEFAULT_TABLE_SETTINGS: TableSettings = { filters: {}, types: {}, hidden: [], showFilters: true };

function loadTableSettings(scope: string): TableSettings {
  const s = load<Partial<TableSettings>>(`${PREFIX}-table-${scope}`, {}, v => !!v && typeof v === 'object');
  return {
    filters: isRecordOfStrings(s.filters) ? s.filters ?? {} : {},
    types: isRecordOfStrings(s.types) ? Object.fromEntries(Object.entries(s.types ?? {}).filter(([, t]) => ALL_COL_TYPES.includes(t as ColType))) : {},
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(x => typeof x === 'string') : [],
    showFilters: typeof s.showFilters === 'boolean' ? s.showFilters : true,
  };
}

function FilterInput({ value, type, error, onChange }: { value: string; type: ColType; error: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <div className="relative">
      <input
        value={text}
        placeholder={COL_TYPE_PLACEHOLDERS[type]}
        title={error || COL_TYPE_HELP[type]}
        onChange={e => {
          const v = e.target.value;
          setText(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onChange(v), FILTER_DEBOUNCE_MS);
        }}
        className={clsx(
          'w-full min-w-[5rem] rounded border bg-white px-1.5 py-0.5 pr-5 text-xs font-normal outline-none dark:bg-slate-900',
          error ? 'border-red-500 text-red-600' : 'border-slate-300 focus:border-blue-500 dark:border-slate-600',
        )}
      />
      {text && (
        <button type="button" aria-label="Clear filter" className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
          onClick={() => { if (timer.current) clearTimeout(timer.current); setText(''); onChange(''); }}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function ColumnsMenu({ columns, hidden, locked, onChange }: { columns: string[]; hidden: string[]; locked: string; onChange: (hidden: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shown = columns.filter(c => c.toLowerCase().includes(query.toLowerCase()));
  const visible = columns.filter(c => !hidden.includes(c)).length;
  return (
    <div className="relative">
      <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)} title="Choose the columns of the table">
        <Columns3 size={14} /> Columns: {visible} of {columns.length}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-800">
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search columns"
              className="mb-2 w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-600" />
            <div className="mb-2 flex gap-1 text-xs">
              <button type="button" className="btn-sm" onClick={() => onChange([])}>All</button>
              <button type="button" className="btn-sm" onClick={() => onChange(columns.filter(c => c !== locked))}>Clear</button>
              <button type="button" className="btn-sm" onClick={() => onChange(columns.filter(c => c !== locked && !hidden.includes(c)))}>Toggle</button>
              <button type="button" className="btn-sm" onClick={() => onChange([])}>Reset</button>
            </div>
            <ul className="max-h-72 overflow-auto text-sm">
              {shown.map(c => (
                <li key={c} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-700">
                  <span className="w-6 text-right text-xs text-slate-400">{columns.indexOf(c) + 1}</span>
                  <label className="flex flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" disabled={c === locked} checked={!hidden.includes(c)}
                      onChange={() => onChange(hidden.includes(c) ? hidden.filter(h => h !== c) : [...hidden, c])} />
                    <span className="truncate">{c}</span>
                  </label>
                  {c !== locked && (
                    <button type="button" className="text-xs text-blue-600 hover:underline dark:text-blue-400" onClick={() => onChange(columns.filter(x => x !== c && x !== locked))}>Only</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

type DataTableProps = {
  scope: string;
  table: ReportTable;
  exportName: string;
  /** watchlists export tickers only, like the Scala job; reports export their CSV; files export the table. */
  exportKind: ReportKind | 'file';
  extraTools?: React.ReactNode;
};

function DataTable({ scope, table, exportName, exportKind, extraTools }: DataTableProps) {
  const [settings, setSettings] = useState<TableSettings>(() => loadTableSettings(scope));
  const [sort, setSort] = useState<SortState>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { setSettings(loadTableSettings(scope)); setSort(null); }, [scope]);
  const update = useCallback((patch: Partial<TableSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      save(`${PREFIX}-table-${scope}`, next);
      return next;
    });
  }, [scope]);

  const { columns, rows } = table;
  const symbolCol = columns.findIndex(c => c.toLowerCase() === 'symbol');
  const detected = useMemo(() => columns.map((_, i) => detectColType(rows.map(r => r[i] ?? ''))), [columns, rows]);
  const types: ColType[] = columns.map((c, i) => (settings.types[c] as ColType | undefined) ?? detected[i]);
  const values = useMemo(() => columns.map((_, i) => rows.map(r => parseCellValue(r[i] ?? '', types[i]))), [columns, rows, types.join()]);

  const compiled = columns.map((c, i) => compileFilter(settings.filters[c] ?? '', types[i]));
  const shownRows = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    let idx = rows.map((_, r) => r).filter(r => {
      for (let i = 0; i < columns.length; i += 1) {
        const f = compiled[i];
        if (f && f.ok && !f.test(values[i][r], (rows[r][i] ?? '').toLowerCase())) return false;
      }
      if (!terms.length) return true;
      const line = rows[r].join(' ').toLowerCase();
      return terms.every(t => line.includes(t));
    });
    if (sort) {
      const c = columns.indexOf(sort.col);
      if (c >= 0) {
        const sign = sort.dir === 'asc' ? 1 : -1;
        idx = idx.map((r, i) => ({ r, i })).sort((a, b) => {
          if (types[c] === 'string') {
            const x = rows[a.r][c] ?? '';
            const y = rows[b.r][c] ?? '';
            if (!x !== !y) return x ? -1 : 1;
            return sign * collator.compare(x, y) || a.i - b.i;
          }
          const x = values[c][a.r];
          const y = values[c][b.r];
          if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1; // unavailable values always last
          return (Number.isNaN(x) ? 0 : sign * (x - y)) || a.i - b.i;
        }).map(x => x.r);
      }
    }
    return idx;
  }, [rows, columns, values, search, sort, JSON.stringify(settings.filters), types.join()]);

  const filterCount = Object.values(settings.filters).filter(v => v.trim()).length;
  const tickers = () => (symbolCol >= 0 ? shownRows.map(r => rows[r][symbolCol]).filter(Boolean) : []);

  const exportCsv = () => {
    const view = { columns, rows: shownRows.map(r => rows[r]) };
    const text = exportKind === 'file' ? [columns, ...view.rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n' : reportText(exportKind, view);
    download(`${safeName(exportName)}.csv`, text, 'text/csv');
  };
  const flash = (text: string) => { setNotice(text); setTimeout(() => setNotice(''), 2000); };

  const cycleType = (c: string, i: number, reset: boolean) => {
    const types2 = { ...settings.types };
    if (reset) delete types2[c];
    else {
      const next = ALL_COL_TYPES[(ALL_COL_TYPES.indexOf(types[i]) + 1) % ALL_COL_TYPES.length];
      if (next === detected[i]) delete types2[c]; else types2[c] = next;
    }
    update({ types: types2 });
  };

  const visibleCols = columns.map((c, i) => ({ c, i })).filter(({ c }) => !settings.hidden.includes(c) || c === columns[symbolCol]);
  const MAX_ROWS = 3000;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all columns"
            className="w-56 rounded-md border border-slate-300 bg-white py-1 pl-7 pr-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
        </label>
        <ColumnsMenu columns={columns} hidden={settings.hidden} locked={columns[symbolCol] ?? ''} onChange={hidden => update({ hidden })} />
        <button type="button" className={clsx('btn', settings.showFilters && 'btn-on')} onClick={() => update({ showFilters: !settings.showFilters })}>
          <Filter size={14} /> Filters: {settings.showFilters ? 'on' : 'off'}{filterCount ? ` (${filterCount})` : ''}
        </button>
        {(filterCount > 0 || sort || search) && (
          <button type="button" className="btn" onClick={() => { update({ filters: {} }); setSort(null); setSearch(''); }}>
            <FilterX size={14} /> Clear filters
          </button>
        )}
        {extraTools}
        <span className="text-xs text-slate-500">{shownRows.length === rows.length ? `${rows.length} rows` : `${shownRows.length} of ${rows.length} rows`}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {notice && <span className="text-xs text-emerald-600">{notice}</span>}
          {symbolCol >= 0 && (
            <button type="button" className="btn" onClick={() => {
              const list = tickers();
              navigator.clipboard?.writeText(list.join('\n')).then(() => flash(`${list.length} tickers copied`), () => flash('Clipboard blocked'));
            }}><Copy size={14} /> Copy Tickers</button>
          )}
          <button type="button" className="btn" onClick={exportCsv}><Download size={14} /> Export .csv</button>
          {symbolCol >= 0 && (
            <button type="button" className="btn" onClick={() => download(`${safeName(exportName)}.txt`, tickers().map(t => `${t}\n`).join(''), 'text/plain')}>
              <Download size={14} /> Export .txt
            </button>
          )}
        </div>
      </div>

      <div className="table-scroll min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-max min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800">
            <tr>
              <th className="sticky left-0 z-20 bg-slate-100 px-2 py-1 text-right text-xs font-medium text-slate-400 dark:bg-slate-800">#</th>
              {visibleCols.map(({ c, i }) => (
                <th key={c} className={clsx('whitespace-nowrap px-2 py-1 text-left align-top font-semibold', i === symbolCol && 'sticky left-8 z-20 bg-slate-100 dark:bg-slate-800')}>
                  <div className="flex items-center gap-1">
                    <button type="button" className="flex items-center gap-1 hover:text-blue-600"
                      title="Sort: ascending, descending, off"
                      onClick={() => setSort(sort?.col !== c ? { col: c, dir: 'asc' } : sort.dir === 'asc' ? { col: c, dir: 'desc' } : null)}>
                      {c}
                      {sort?.col === c && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                    </button>
                    <button type="button" title={`Column type: ${COL_TYPE_LABELS[types[i]]} (click to change, Shift+click resets to the detected type)`}
                      className={clsx('rounded px-1 text-[10px] font-bold', COL_TYPE_CLASSES[types[i]], settings.types[c] && 'ring-1 ring-current')}
                      onClick={e => cycleType(c, i, e.shiftKey)}>
                      {COL_TYPE_LABELS[types[i]]}
                    </button>
                  </div>
                  {settings.showFilters && (
                    <div className="mt-1">
                      <FilterInput value={settings.filters[c] ?? ''} type={types[i]} error={compiled[i] && !compiled[i]?.ok ? (compiled[i] as { error: string }).error : ''}
                        onChange={v => {
                          const filters = { ...settings.filters };
                          if (v.trim()) filters[c] = v; else delete filters[c];
                          update({ filters });
                        }} />
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.slice(0, MAX_ROWS).map((r, n) => (
              <tr key={r} className="border-t border-slate-100 odd:bg-white even:bg-slate-50 hover:bg-blue-50 dark:border-slate-800 dark:odd:bg-slate-900 dark:even:bg-slate-900/60 dark:hover:bg-slate-800">
                <td className="sticky left-0 bg-inherit px-2 py-0.5 text-right text-xs text-slate-400">{n + 1}</td>
                {visibleCols.map(({ c, i }) => (
                  <td key={c} className={clsx('whitespace-nowrap px-2 py-0.5', types[i] !== 'string' && 'text-right tabular-nums', i === symbolCol && 'sticky left-8 bg-inherit font-semibold')}>
                    {rows[r][i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!shownRows.length && <p className="p-6 text-center text-sm text-slate-500">{rows.length ? 'No rows match the filters' : 'Nothing in this report'}</p>}
        {shownRows.length > MAX_ROWS && <p className="p-2 text-center text-xs text-slate-500">Showing the first {MAX_ROWS} of {shownRows.length} rows; filter to narrow down (exports include every row)</p>}
      </div>
    </div>
  );
}

// ---- app ----------------------------------------------------------------------------------

type ReportState = { status: 'idle' | 'running' | 'done'; sheets: ReportSheet[]; error?: string };
type TabId = 'files' | ReportKind;

const IDLE: Record<ReportKind, ReportState> = { watchlists: { status: 'idle', sheets: [] }, investments: { status: 'idle', sheets: [] }, dividends: { status: 'idle', sheets: [] }, drips: { status: 'idle', sheets: [] } };

function SubTabs({ items, active, onSelect, onClose }: { items: { id: string; label: string; hint?: string; warn?: boolean }[]; active: string; onSelect: (id: string) => void; onClose?: (id: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto pb-1">
      {items.map(item => (
        <div key={item.id} className={clsx('flex shrink-0 items-center rounded-md border text-sm',
          item.id === active ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'border-slate-200 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800')}>
          <button type="button" className="flex items-center gap-1 px-2.5 py-1" title={item.hint} onClick={() => onSelect(item.id)}>
            {item.warn && <TriangleAlert size={13} className="text-amber-500" />}
            {item.label}
          </button>
          {onClose && (
            <button type="button" aria-label={`Remove ${item.label}`} className="pr-1.5 text-slate-400 hover:text-red-600" onClick={() => onClose(item.id)}><X size={13} /></button>
          )}
        </div>
      ))}
    </div>
  );
}

function App() {
  const [dark, setDark] = useState<boolean>(() => load(THEME_KEY, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false, v => typeof v === 'boolean'));
  const [remember, setRemember] = useState<boolean>(() => load(REMEMBER_KEY, false, v => typeof v === 'boolean'));
  const [files, setFiles] = useState<ImportedFile[]>(() => (remember
    ? load<{ name: string; text: string }[]>(FILES_KEY, [], v => Array.isArray(v) && v.every(f => f && typeof f.name === 'string' && typeof f.text === 'string')).map(f => toImported(f.name, f.text))
    : []));
  const [tab, setTab] = useState<TabId>('files');
  const [sheetOf, setSheetOf] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<Record<ReportKind, ReportState>>(IDLE);
  const [runDate, setRunDate] = useState(todayIso());
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { document.documentElement.classList.toggle('dark', dark); save(THEME_KEY, dark); }, [dark]);

  useEffect(() => {
    save(REMEMBER_KEY, remember);
    if (!remember) { drop(FILES_KEY); return; }
    if (!save(FILES_KEY, files.map(f => ({ name: f.name, text: f.text })))) {
      drop(FILES_KEY);
      setRemember(false);
      setMessage('The files are too large for the browser storage: "Remember files" is off, nothing is kept');
    }
  }, [files, remember]);

  const accounts = useMemo(() => namedAccounts(files), [files]);

  // Reports run in a worker whenever the accounts or the DRIP run date change; a newer run replaces the old one
  useEffect(() => {
    if (!accounts.length) { setReports(IDLE); return; }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const jobId = Date.now();
    setReports(prev => Object.fromEntries(REPORT_KINDS.map(({ kind }) => [kind, { ...prev[kind], status: 'running' }])) as Record<ReportKind, ReportState>);
    worker.onmessage = (e: MessageEvent<{ jobId: number; kind: ReportKind; sheets: ReportSheet[]; error?: string }>) => {
      if (e.data.jobId !== jobId) return;
      setReports(prev => ({ ...prev, [e.data.kind]: { status: 'done', sheets: e.data.sheets, error: e.data.error } }));
    };
    worker.onerror = e => {
      setReports(prev => Object.fromEntries(REPORT_KINDS.map(({ kind }) => [kind, prev[kind].status === 'running' ? { status: 'done', sheets: [], error: e.message || 'The report worker failed' } : prev[kind]])) as Record<ReportKind, ReportState>);
    };
    worker.postMessage({ jobId, accounts, runDate });
    return () => worker.terminate();
  }, [accounts, runDate]);

  const importFiles = async (list: FileList | File[]) => {
    const picked = [...list].filter(f => /\.(csv|txt)$/i.test(f.name) || f.type.includes('csv'));
    if (!picked.length) { setMessage('Only .csv files can be imported'); return; }
    const loaded = await Promise.all(picked.map(async f => toImported(f.name, await f.text())));
    setFiles(prev => [...prev.filter(p => !loaded.some(l => l.name === p.name)), ...loaded].sort((a, b) => collator.compare(a.name, b.name)));
    setSheetOf(prev => ({ ...prev, files: loaded[0].name }));
    setTab('files');
    const plain = loaded.filter(f => !f.accounts).map(f => f.name);
    setMessage(plain.length ? `Not a Fidelity positions export (shown, not used in reports): ${plain.join(', ')}` : '');
  };

  const removeFile = (name: string) => setFiles(prev => prev.filter(f => f.name !== name));

  const downloadAll = () => {
    const entries: Record<string, Uint8Array> = {};
    for (const { kind, folder } of REPORT_KINDS) {
      reports[kind].sheets.forEach((sheet, i) => {
        if (sheet.error) return;
        const text = strToU8(reportText(kind, sheet.table));
        if (kind === 'watchlists') {
          entries[`${folder}/${safeName(sheet.title)}.csv`] = text;
          entries[`${folder}/${safeName(sheet.title)}.txt`] = text;
        } else entries[`${folder}/${i + 1}-${safeName(sheet.title)}.csv`] = text;
      });
    }
    download(`fidelity-reports-${runDate}.zip`, zipSync(entries), 'application/zip');
  };

  const allDone = accounts.length > 0 && REPORT_KINDS.every(({ kind }) => reports[kind].status === 'done');

  // the sub-tabs and the table of the active tab
  let body: React.ReactNode;
  if (!files.length) {
    body = (
      <button type="button" onClick={() => inputRef.current?.click()}
        className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-300 p-10 text-slate-500 hover:border-blue-400 hover:text-blue-600 dark:border-slate-700">
        <Upload size={40} />
        <span className="text-lg font-medium">Drop Fidelity Portfolio_Positions CSV files here, or click to choose</span>
        <span className="max-w-xl text-sm">One file per account or an all-accounts export. Everything stays in this browser: nothing is uploaded anywhere.
          The watchlists, investments, dividends and DRIPs reports are built in the background while you look at the files.</span>
      </button>
    );
  } else if (tab === 'files') {
    const active = files.find(f => f.name === sheetOf.files) ?? files[0];
    const accountsOf = active.accounts;
    body = (
      <>
        <SubTabs items={files.map(f => ({ id: f.name, label: f.name, warn: !f.accounts, hint: f.accounts ? f.accounts.map(a => `${a.name} (${a.number})`).join(', ') : 'Not a Fidelity positions export' }))}
          active={active.name} onSelect={id => setSheetOf({ ...sheetOf, files: id })} onClose={removeFile} />
        <p className="text-xs text-slate-500">
          {accountsOf ? `Accounts: ${accountsOf.map(a => `${a.name} (${a.number})`).join(', ')}` : 'Not a Fidelity positions export: shown as a table, not used in the reports'}
        </p>
        <DataTable scope="files" table={active.table} exportName={active.name.replace(/\.csv$/i, '')} exportKind="file" />
      </>
    );
  } else {
    const state = reports[tab];
    const sheets = state.sheets;
    const active = sheets.find(s => s.id === sheetOf[tab]) ?? sheets[0];
    const meta = REPORT_KINDS.find(k => k.kind === tab);
    body = state.status !== 'done' ? (
      <div className="flex flex-1 items-center justify-center gap-2 text-slate-500"><LoaderCircle className="animate-spin" size={20} /> Building {meta?.label}…</div>
    ) : state.error || !active ? (
      <p className="p-6 text-center text-red-600">{state.error ?? 'No Fidelity positions files imported'}</p>
    ) : (
      <>
        <SubTabs items={sheets.map(s => ({ id: s.id, label: s.title, warn: !!s.error, hint: s.error }))} active={active.id} onSelect={id => setSheetOf({ ...sheetOf, [tab]: id })} />
        {active.error ? <p className="p-6 text-center text-red-600">{active.error}</p> : (
          <DataTable scope={tab} table={active.table} exportName={`${meta?.folder}-${active.title}`} exportKind={tab}
            extraTools={tab === 'drips' ? (
              <label className="flex items-center gap-1 text-xs text-slate-500" title="Ex. Dividend Date and Payment Date show only dates after this day">
                Dates after <input type="date" value={runDate} onChange={e => e.target.value && setRunDate(e.target.value)} className="rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600" />
              </label>
            ) : undefined} />
        )}
      </>
    );
  }

  const tabs: { id: TabId; label: string; count?: number; busy?: boolean }[] = [
    { id: 'files', label: 'Files', count: files.length },
    ...REPORT_KINDS.map(({ kind, label }) => ({ id: kind, label, busy: reports[kind].status === 'running', count: reports[kind].status === 'done' ? reports[kind].sheets.length : undefined })),
  ];

  return (
    <div
      className="flex h-screen flex-col bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-200"
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); }}
    >
      <div id="top-panels" className="flex flex-col gap-2 px-4 pt-3 sm:px-8">
        <div id="selected-tabs-panel" className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-2 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex shrink-0 items-center gap-2">
            <FileSpreadsheet className="text-emerald-600" size={22} />
            <div>
              <h1 className="text-base font-bold leading-tight">Fidelity reports</h1>
              <p id="app-subtitle" className="hidden text-xs text-slate-500 xl:block">{accounts.length} accounts in {files.length} files</p>
            </div>
          </div>
          <nav className="flex flex-1 gap-1 overflow-x-auto" role="tablist">
            {tabs.map(t => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={clsx('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium',
                  tab === t.id ? 'bg-blue-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800')}>
                {t.label}
                {t.busy && <LoaderCircle size={14} className="animate-spin" aria-label="building" />}
                {!t.busy && t.count !== undefined && t.count > 0 && <span className={clsx('rounded-full px-1.5 text-xs', tab === t.id ? 'bg-blue-500' : 'bg-slate-200 dark:bg-slate-700')}>{t.count}</span>}
              </button>
            ))}
          </nav>
          <button type="button" className="btn" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? <Sun size={14} /> : <Moon size={14} />}</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <input ref={inputRef} type="file" accept=".csv,text/csv" multiple hidden onChange={e => { if (e.target.files) importFiles(e.target.files); e.target.value = ''; }} />
          <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}><Upload size={14} /> Import CSV files</button>
          <label className="flex items-center gap-1.5 text-sm" title="Keep the imported files in this browser's storage so they come back after a reload (off by default: these are financial data)">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember files
          </label>
          {message && <span className="text-xs text-amber-600">{message}</span>}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn" disabled={!allDone} onClick={downloadAll} title="All reports in one zip: watchlist/, investments/, dividends/, DRIPs/">
              <Archive size={14} /> Download all reports
            </button>
            <button type="button" className="btn btn-danger" disabled={!files.length}
              onClick={() => { if (window.confirm('Remove all imported files?')) { setFiles([]); setTab('files'); setMessage(''); } }}>
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </div>
      </div>
      <main className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3 sm:px-8">{body}</main>
      <footer className="px-4 pb-[3.5px] text-center text-[10px] text-slate-400 sm:px-8 sm:pb-[19.5px]">
        <a href="https://github.com/daggerok/fidelity-portfolio" target="_blank" rel="noreferrer" className="underline decoration-dotted">daggerok &copy; {new Date().getFullYear()}</a>
      </footer>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-blue-600/20 text-2xl font-semibold text-blue-700 backdrop-blur-sm">Drop CSV files to import</div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);
