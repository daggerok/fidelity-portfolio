// main.tsx
/**
 * ============================================================================
 * AGENTIC AI ENFORCED SPECIFICATION & GUIDELINES (CRITICAL)
 * ============================================================================
 * 1. PERSIST ALL COMMENTS: Under no circumstances should ANY code comments,
 *    system design docs, or type descriptors be removed or truncated.
 * 2. AGENT READ-WRITE RULE: If a future deployment or agent updates the code,
 *    this header section and related documentation blocks MUST be kept accurate,
 *    expanded, and dynamically synchronized with the feature upgrades.
 * 3. LAYERING: business logic lives in `csv-engine.ts`, `storage.ts` and
 *    `google-sheets.ts`. This file is the React shell and must stay free of
 *    parsing/persistence internals so both remain independently testable.
 * ============================================================================
 *
 * ============================================================================
 * PROJECT: Getting-started template — CSV viewer + Google Sheets as a database
 * ENVIRONMENT: Bun · Parcel · React 19 · TypeScript · TailwindCSS v4
 * ============================================================================
 *
 * WHAT THIS TEMPLATE DEMONSTRATES
 * -------------------------------
 * • A full CSV viewer (import, type detection, per-column filters, natural
 *   sort, inline header rename, merge view, export) — ported from daggerok/csv.
 * • A storage abstraction where localStorage and Google Sheets implement the
 *   SAME `Repository<T>` interface, so the app never branches on the backend.
 * • Debug (⌘) and Settings (⚙️) popovers built exactly like
 *   https://daggerok.github.io/fundamentals/ — anchored overlays that do not
 *   reflow the page, same 22rem width, same section rhythm, same toggle model.
 *
 * STORAGE CONTRACT (mirrors the five invariants documented in storage.ts)
 * ----------------------------------------------------------------------
 *   I1  Settings ALWAYS persist to localStorage, Google or not.
 *   I2  Data persists locally only while it fits the byte budget.
 *   I3  A data write can never evict settings (guardedWrite + rollback).
 *   I4  Switching Google → local mirrors sheet rows down. Never the reverse.
 *   I5  On tab close, settings flush to BOTH backends (keepalive for Google).
 *
 * TWO DOCUMENTS, ONE TOKEN
 * ------------------------
 * Settings and data may live in separate spreadsheets. Typing/pasting the
 * settings document auto-fills the data document field (`autoFillDataDocument`)
 * so the common "one document, two tabs" case needs a single paste, while power
 * users can still point the data field somewhere else.
 *
 * PANEL MODEL (matching fundamentals)
 * -----------------------------------
 *   const [showDebug, setShowDebug] = useState(false)
 *   const [showSettings, setShowSettings] = useState(false)
 * Both reset on refresh, both stay open until explicitly toggled (no
 * click-outside auto-close), each rendered as an absolute popover with
 * `w-[min(92vw,22rem)]` — debug anchored left, settings anchored right.
 * ============================================================================
 */

import React, {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { createRoot } from 'react-dom/client';

import {
  ALL_COLUMN_TYPES,
  COLUMN_TYPE_COLORS,
  COLUMN_TYPE_LABELS,
  DEFAULT_SORT_STATE,
  DEMO_CSV,
  DEMO_FILE_NAME,
  NUMERIC_FILTER_TYPES,
  applyFilters,
  buildCSVString,
  detectColumnType,
  downloadFile,
  extractValidTableData,
  getComparator,
  getTotalRowCount,
  makeExportFileName,
  naturalCollator,
  padCSVRow,
  type ColumnType,
  type SortState,
} from './csv-engine';

import {
  DATA_BUDGET_BYTES,
  DATA_BUDGET_MB,
  LS_DATA_KEY,
  LS_SETTINGS_KEY,
  SHEET_TABS,
  createGoogleDataRepository,
  createGoogleSettingsRepository,
  createLocalDataRepository,
  createLocalSettingsRepository,
  createShutdownFlusher,
  formatBytes,
  gridRange,
  mergeSettings,
  resolveStorage,
  syncDataFromGoogleToLocal,
  type BackendKind,
  type DataRepository,
  type DataSet,
  type SaveResult,
  type SettingsBag,
  type SettingsRepository,
} from './storage';

import {
  createSheetsClient,
  errorMessage,
  normalizeSpreadsheetId,
  requestAccessToken,
  revokeAccessToken,
  spreadsheetUrl,
  type SheetsClient,
} from './google-sheets';

// ============================================================================
// DEBUG SYSTEM — `?debug=true` (same convention as csv / google / fundamentals)
// ============================================================================

export const DEBUG_ENABLED: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).get('debug') === 'true';
  } catch {
    return false;
  }
})();

/** Ring buffer shown in the Debug popover's "Recent activity" section. */
type LogEntry = { at: string; message: string };
const LOG_LIMIT = 40;
let logSink: ((entry: LogEntry) => void) | null = null;

export function dbg(...args: unknown[]): void {
  if (DEBUG_ENABLED) console.log('[DBG]', ...args);
  const message = args
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(' ');
  logSink?.({ at: new Date().toLocaleTimeString(), message });
}

if (DEBUG_ENABLED) {
  console.log(
    '%c[DEBUG MODE ACTIVE]%c Add ?debug=true to the URL to enable. Remove to disable.',
    'color:#fff;background:#e11d48;padding:2px 6px;border-radius:3px;font-weight:bold;',
    'color:#6b7280;',
  );
}

// ============================================================================
// APP SETTINGS
// ============================================================================

export type Language = 'en' | 'ru';

/**
 * Every field here is mirrored to Google (except the device-scoped keys listed
 * in `LOCAL_ONLY_SETTING_KEYS`, which stay local so a shared spreadsheet cannot
 * repoint another machine's wiring).
 */
export interface AppSettings extends SettingsBag {
  theme: 'light' | 'dark';
  lang: Language;
  firstRowIsHeader: boolean;
  firstColIsHeader: boolean;
  mergeFiles: boolean;
  stickyHeaders: boolean;
  rememberData: boolean;
  columnCustomNames: Record<number, string>;
  columnTypeOverrides: Record<number, ColumnType>;
  columnFilters: Record<number, string>;
  sortState: SortState;
  /** Device-scoped ↓ */
  backend: BackendKind;
  googleClientId: string;
  settingsDocumentId: string;
  dataDocumentId: string;
  /** Paste-once convenience: settings doc id auto-populates the data doc id. */
  autoFillDataDocument: boolean;
  lastAccountEmail: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  lang: 'en',
  firstRowIsHeader: true,
  firstColIsHeader: true,
  mergeFiles: false,
  stickyHeaders: true,
  rememberData: true,
  columnCustomNames: {},
  columnTypeOverrides: {},
  columnFilters: {},
  sortState: { columnIndex: null, direction: 'asc' },
  backend: 'local',
  googleClientId: '',
  settingsDocumentId: '',
  dataDocumentId: '',
  autoFillDataDocument: true,
  lastAccountEmail: '',
};

/** Normalizes an arbitrary bag (localStorage or Sheets) into complete settings. */
export function normalizeSettings(raw: SettingsBag | null): AppSettings {
  const bag = raw ?? {};
  const pickBool = (k: keyof AppSettings) =>
    typeof bag[k] === 'boolean' ? (bag[k] as boolean) : (DEFAULT_SETTINGS[k] as boolean);
  const pickStr = (k: keyof AppSettings) =>
    typeof bag[k] === 'string' ? (bag[k] as string) : (DEFAULT_SETTINGS[k] as string);
  const rec = <T,>(k: keyof AppSettings): Record<number, T> => {
    const v = bag[k];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<number, T>) : {};
  };
  const sort = bag.sortState as SortState | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...bag,
    theme: bag.theme === 'dark' ? 'dark' : 'light',
    lang: bag.lang === 'ru' ? 'ru' : 'en',
    firstRowIsHeader: pickBool('firstRowIsHeader'),
    firstColIsHeader: pickBool('firstColIsHeader'),
    mergeFiles: pickBool('mergeFiles'),
    stickyHeaders: pickBool('stickyHeaders'),
    rememberData: pickBool('rememberData'),
    autoFillDataDocument: pickBool('autoFillDataDocument'),
    columnCustomNames: rec<string>('columnCustomNames'),
    columnTypeOverrides: rec<ColumnType>('columnTypeOverrides'),
    columnFilters: rec<string>('columnFilters'),
    sortState: {
      columnIndex: typeof sort?.columnIndex === 'number' ? sort.columnIndex : null,
      direction: sort?.direction === 'desc' ? 'desc' : 'asc',
    },
    backend: bag.backend === 'google' ? 'google' : 'local',
    googleClientId: pickStr('googleClientId'),
    settingsDocumentId: pickStr('settingsDocumentId'),
    dataDocumentId: pickStr('dataDocumentId'),
    lastAccountEmail: pickStr('lastAccountEmail'),
  };
}

// ============================================================================
// I18N
// ============================================================================

const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en: {
    'app.title': 'CSV + Sheets Template',
    'app.subtitle': 'localStorage by default · Google Sheets when configured',
    'tip.debug': 'Open debug panel',
    'tip.settings': 'Settings',
    'tip.theme': 'Theme',
    'tip.lang': 'Language',

    'debug.title': 'Debug',
    'debug.overview': 'Overview',
    'debug.storage': 'Storage',
    'debug.connection': 'Google connection',
    'debug.activity': 'Recent activity',
    'debug.status': 'Status',
    'debug.backend': 'Active backend',
    'debug.files': 'Files',
    'debug.rows': 'Rows',
    'debug.settingsRepo': 'Settings repository',
    'debug.dataRepo': 'Data repository',
    'debug.localSettings': 'localStorage settings',
    'debug.localData': 'localStorage data',
    'debug.budget': 'Data budget',
    'debug.account': 'Account',
    'debug.settingsDoc': 'Settings document',
    'debug.dataDoc': 'Data document',
    'debug.tabs': 'Tabs',
    'debug.ready': 'Ready',
    'debug.loading': 'Loading',
    'debug.idle': 'Idle',
    'debug.none': 'No activity yet',
    'debug.notConnected': 'Not connected',
    'debug.hintDebug': 'Verbose console logging is on only with ?debug=true.',

    'settings.title': 'Settings',
    'settings.display': 'Display',
    'settings.table': 'Table',
    'settings.data': 'Data & storage',
    'settings.google': 'Google Sheets',
    'settings.theme': 'Theme',
    'settings.lang': 'Language',
    'settings.stickyHeaders': 'Sticky headers',
    'settings.mergeFiles': 'Merge files',
    'settings.firstRow': '1st row = header',
    'settings.firstCol': '1st column sticky',
    'settings.rememberData': 'Remember data locally',
    'settings.rememberData.hint':
      'Rows are cached in localStorage while they fit the budget. Settings are always saved, regardless.',
    'settings.backend': 'Backend',
    'settings.clearData': 'Clear loaded data',
    'settings.resetSettings': 'Reset settings',
    'settings.exportSettings': 'Export settings',
    'settings.importSettings': 'Import settings',
    'settings.clientId': 'OAuth client ID',
    'settings.clientId.hint': 'Web client ID from Google Cloud Console. Stays on this device.',
    'settings.settingsDoc': 'Settings spreadsheet',
    'settings.settingsDoc.hint': 'Paste a URL or ID. Stored in tab app:settings.',
    'settings.dataDoc': 'Data spreadsheet',
    'settings.dataDoc.hint': 'Defaults to the settings document. Change it to split them apart.',
    'settings.autoFill': 'Auto-fill data document',
    'settings.connect': 'Connect',
    'settings.reconnect': 'Reconnect',
    'settings.disconnect': 'Disconnect',
    'settings.useGoogle': 'Use Google Sheets',
    'settings.useLocal': 'Use localStorage',
    'settings.pushData': 'Push data to Google',
    'settings.pullData': 'Pull data from Google',
    'settings.setupGuide': 'Setup guide',
    'settings.close': 'Close',

    'toolbar.import': 'Import CSV',
    'toolbar.export': 'Export CSV',
    'toolbar.exportMerged': 'Export merged CSV',
    'toolbar.exportAll': 'Export all files',
    'toolbar.loadDemo': 'Load demo data',
    'toolbar.clear': 'Clear',
    'empty.title': 'No data loaded',
    'empty.body': 'Import a CSV file, or load the bundled demo dataset to explore the template.',
    'filters.showing': 'Showing {shown} of {total} rows',
    'filters.filteredOut': '({n} filtered out)',
    'table.noMatch': 'No rows match the current filters.',
    'table.noData': 'No table data extracted.',
  },
  ru: {
    'app.title': 'Шаблон CSV + Sheets',
    'app.subtitle': 'localStorage по умолчанию · Google Sheets при настройке',
    'tip.debug': 'Открыть панель отладки',
    'tip.settings': 'Настройки',
    'tip.theme': 'Тема',
    'tip.lang': 'Язык',

    'debug.title': 'Отладка',
    'debug.overview': 'Обзор',
    'debug.storage': 'Хранилище',
    'debug.connection': 'Подключение Google',
    'debug.activity': 'Последние события',
    'debug.status': 'Статус',
    'debug.backend': 'Активный бэкенд',
    'debug.files': 'Файлы',
    'debug.rows': 'Строки',
    'debug.settingsRepo': 'Репозиторий настроек',
    'debug.dataRepo': 'Репозиторий данных',
    'debug.localSettings': 'Настройки в localStorage',
    'debug.localData': 'Данные в localStorage',
    'debug.budget': 'Лимит данных',
    'debug.account': 'Аккаунт',
    'debug.settingsDoc': 'Документ настроек',
    'debug.dataDoc': 'Документ данных',
    'debug.tabs': 'Вкладки',
    'debug.ready': 'Готово',
    'debug.loading': 'Загрузка',
    'debug.idle': 'Ожидание',
    'debug.none': 'Событий пока нет',
    'debug.notConnected': 'Не подключено',
    'debug.hintDebug': 'Подробные логи в консоли только с ?debug=true.',

    'settings.title': 'Настройки',
    'settings.display': 'Отображение',
    'settings.table': 'Таблица',
    'settings.data': 'Данные и хранилище',
    'settings.google': 'Google Таблицы',
    'settings.theme': 'Тема',
    'settings.lang': 'Язык',
    'settings.stickyHeaders': 'Закреплённые заголовки',
    'settings.mergeFiles': 'Объединять файлы',
    'settings.firstRow': '1-я строка — заголовок',
    'settings.firstCol': '1-й столбец закреплён',
    'settings.rememberData': 'Запоминать данные локально',
    'settings.rememberData.hint':
      'Строки кэшируются в localStorage, пока помещаются в лимит. Настройки сохраняются всегда.',
    'settings.backend': 'Бэкенд',
    'settings.clearData': 'Очистить данные',
    'settings.resetSettings': 'Сбросить настройки',
    'settings.exportSettings': 'Экспорт настроек',
    'settings.importSettings': 'Импорт настроек',
    'settings.clientId': 'OAuth client ID',
    'settings.clientId.hint': 'Web client ID из Google Cloud Console. Остаётся на этом устройстве.',
    'settings.settingsDoc': 'Таблица настроек',
    'settings.settingsDoc.hint': 'Вставьте URL или ID. Хранится во вкладке app:settings.',
    'settings.dataDoc': 'Таблица данных',
    'settings.dataDoc.hint': 'По умолчанию — документ настроек. Измените, чтобы разделить.',
    'settings.autoFill': 'Автозаполнение документа данных',
    'settings.connect': 'Подключить',
    'settings.reconnect': 'Переподключить',
    'settings.disconnect': 'Отключить',
    'settings.useGoogle': 'Использовать Google Sheets',
    'settings.useLocal': 'Использовать localStorage',
    'settings.pushData': 'Отправить данные в Google',
    'settings.pullData': 'Загрузить данные из Google',
    'settings.setupGuide': 'Инструкция по настройке',
    'settings.close': 'Закрыть',

    'toolbar.import': 'Импорт CSV',
    'toolbar.export': 'Экспорт CSV',
    'toolbar.exportMerged': 'Экспорт объединённого CSV',
    'toolbar.exportAll': 'Экспорт всех файлов',
    'toolbar.loadDemo': 'Загрузить демо-данные',
    'toolbar.clear': 'Очистить',
    'empty.title': 'Данные не загружены',
    'empty.body': 'Импортируйте CSV или загрузите демо-набор, чтобы изучить шаблон.',
    'filters.showing': 'Показано {shown} из {total} строк',
    'filters.filteredOut': '({n} отфильтровано)',
    'table.noMatch': 'Нет строк, соответствующих фильтрам.',
    'table.noData': 'Табличные данные не найдены.',
  },
};

export function t(key: string, lang: Language): string {
  return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key;
}

// ============================================================================
// ASYNC UTILITIES (paint-aware spinner lifecycle, ported from daggerok/csv)
// ============================================================================

export const EXPENSIVE_TOGGLE_ROW_THRESHOLD = 500;
export const FILTER_DEBOUNCE_MS = 250;
const LAYOUT_RESTRUCTURING_KEYS = new Set<keyof AppSettings>([
  'mergeFiles',
  'firstRowIsHeader',
  'firstColIsHeader',
]);

function yieldToMain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Double-rAF: first fires after commit, second after the browser paints. */
function waitForPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error(`Failed to read: ${file.name}`));
    reader.readAsText(file);
  });
}

interface LoadingState {
  active: boolean;
  phase: 'idle' | 'parsing' | 'rendering' | 'restoring';
  current: number;
  total: number;
  fileName: string;
}
const DEFAULT_LOADING_STATE: LoadingState = {
  active: false,
  phase: 'idle',
  current: 0,
  total: 0,
  fileName: '',
};

/** Synchronous boot probe so the restore spinner shows on the very first paint. */
const NEEDS_BOOT_RESTORE: boolean = (() => {
  try {
    const rawSettings = localStorage.getItem(LS_SETTINGS_KEY);
    let remember = DEFAULT_SETTINGS.rememberData;
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      if (typeof parsed.rememberData === 'boolean') remember = parsed.rememberData;
    }
    if (!remember) return false;
    const raw = localStorage.getItem(LS_DATA_KEY);
    return raw !== null && raw.length > 10;
  } catch {
    return false;
  }
})();

// ============================================================================
// TOASTS
// ============================================================================

type Toast = { id: string; message: string; level: 'info' | 'warn' | 'error' };
const TOAST_MS = 6000;
const uid = () => (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const ToastStack: React.FC<{ toasts: Toast[]; onDismiss: (id: string) => void }> = ({ toasts, onDismiss }) => (
  <div className="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 max-w-[min(92vw,26rem)]">
    {toasts.map((toast) => (
      <button
        key={toast.id}
        type="button"
        onClick={() => onDismiss(toast.id)}
        className={`text-left rounded-xl border px-4 py-3 text-xs shadow-lg animate-fade-in ${
          toast.level === 'error'
            ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/70 dark:text-rose-200'
            : toast.level === 'warn'
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-200'
              : 'border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
        }`}
      >
        {toast.message}
      </button>
    ))}
  </div>
);

// ============================================================================
// LOADING OVERLAY
// ============================================================================

const LoadingOverlay: React.FC<{ state: LoadingState }> = ({ state }) => {
  if (!state.active) return null;
  const isParsing = state.phase === 'parsing';
  const isRestoring = state.phase === 'restoring';
  const fraction = isParsing && state.total > 0 ? Math.max(state.current / state.total, 0) : 1;
  const percent = Math.round(fraction * 100);
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/60 dark:bg-slate-950/75 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-5 rounded-2xl border border-slate-200 bg-white px-10 py-8 shadow-2xl dark:border-slate-700 dark:bg-slate-900 min-w-[280px]">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 80 80" fill="none">
            <circle cx="40" cy="40" r="34" stroke="currentColor" strokeWidth="6" className="text-slate-200 dark:text-slate-700" />
          </svg>
          <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 80 80" fill="none">
            <circle
              cx="40"
              cy="40"
              r="34"
              stroke="currentColor"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              strokeDashoffset={`${2 * Math.PI * 34 * (1 - fraction)}`}
              className="text-blue-500 dark:text-blue-400"
              style={{ transition: 'stroke-dashoffset .35s cubic-bezier(.4,0,.2,1)' }}
            />
          </svg>
          <div className="relative z-10 h-9 w-9 animate-pulse rounded-full bg-blue-50 dark:bg-blue-950/60" />
        </div>
        <div className="text-center">
          <p className="text-base font-bold text-slate-800 dark:text-slate-100">
            {isParsing ? 'Processing files…' : isRestoring ? 'Restoring data…' : 'Rendering table…'}
          </p>
          {isParsing && (
            <p className="mt-1 text-xs font-semibold text-blue-600 dark:text-blue-300">
              {state.current} of {state.total} parsed
            </p>
          )}
          {state.fileName && (
            <p className="mt-1 max-w-[240px] truncate font-mono text-[11px] text-slate-400">{state.fileName}</p>
          )}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className="h-full rounded-full bg-blue-500 transition-all duration-300 dark:bg-blue-400" style={{ width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SHARED UI ATOMS (Pill matches the fundamentals segmented control)
// ============================================================================

type PillOption = { k: string; l: string };

const Pill: React.FC<{
  value: string;
  options: PillOption[];
  onChange: (k: string) => void;
  dark: boolean;
  title?: string;
}> = ({ value, options, onChange, dark, title }) => (
  <div
    title={title}
    className={`flex flex-shrink-0 items-center rounded-lg border p-0.5 ${
      dark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-slate-100'
    }`}
  >
    {options.map((opt) => (
      <button
        key={opt.k}
        type="button"
        onClick={() => onChange(opt.k)}
        className={`rounded-md px-2.5 py-1 text-sm font-bold leading-none transition-all ${
          value === opt.k
            ? 'bg-emerald-500 text-white shadow-sm'
            : dark
              ? 'text-slate-400 hover:text-slate-200'
              : 'text-slate-500 hover:text-slate-700'
        }`}
      >
        {opt.l}
      </button>
    ))}
  </div>
);

/** Label + value row used throughout the debug popover. */
const DebugRow: React.FC<{ label: string; value: React.ReactNode; mono?: boolean; tone?: string }> = ({
  label,
  value,
  mono = true,
  tone,
}) => (
  <div className="flex items-start justify-between gap-3 px-3 py-2">
    <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
    <span className={`text-right text-xs break-words ${mono ? 'font-mono' : ''} ${tone ?? 'text-slate-800 dark:text-slate-100'}`}>
      {value}
    </span>
  </div>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }> = ({
  label,
  checked,
  onChange,
  hint,
}) => (
  <label className="flex cursor-pointer items-center justify-between gap-3" title={hint}>
    <span className="text-xs text-slate-600 dark:text-slate-300">{label}</span>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 cursor-pointer accent-emerald-500"
    />
  </label>
);

// ============================================================================
// INLINE HEADER EDITOR
// ============================================================================

const InlineHeaderEditor: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  isMergeView?: boolean;
}> = ({ value, onChange, onSave, onCancel, isMergeView = false }) => {
  /** Set by Escape / ✗ so the subsequent blur does NOT save. */
  const cancelledRef = useRef(false);
  return (
    <div className="flex w-full items-center gap-1">
      <input
        type="text"
        value={value}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (cancelledRef.current) {
            cancelledRef.current = false;
            return;
          }
          onSave();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          else if (e.key === 'Escape') {
            cancelledRef.current = true;
            onCancel();
          }
        }}
        className={`min-w-0 flex-1 rounded border border-blue-500 bg-white px-2 text-xs font-normal text-slate-900 focus:outline-none dark:bg-slate-900 dark:text-slate-100 ${
          isMergeView ? 'py-0.5' : 'py-1'
        }`}
      />
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSave}
        title="Save (Enter)"
        className="shrink-0 rounded p-0.5 text-green-600 transition-colors hover:bg-green-100 dark:text-green-400 dark:hover:bg-green-900/40"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </button>
      <button
        onMouseDown={(e) => {
          e.preventDefault();
          cancelledRef.current = true;
        }}
        onClick={onCancel}
        title="Cancel (Esc)"
        className="shrink-0 rounded p-0.5 text-red-500 transition-colors hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/40"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

// ============================================================================
// COLUMN FILTER INPUT (debounced)
// ============================================================================

const ColumnFilterInput: React.FC<{
  colIndex: number;
  filterValue: string;
  colType: ColumnType;
  onFilterChange: (colIndex: number, value: string) => void;
}> = ({ colIndex, filterValue, colType, onFilterChange }) => {
  const [localValue, setLocalValue] = useState(filterValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setLocalValue(filterValue), [filterValue]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const isActive = localValue.trim() !== '';
  const isNumeric = NUMERIC_FILTER_TYPES.has(colType);

  return (
    <div className={`mt-1 flex w-full items-center gap-0.5 transition-opacity ${isActive ? 'opacity-100' : 'opacity-0 group-hover/header:opacity-100'}`}>
      <svg
        className={`h-3 w-3 shrink-0 ${isActive ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
      </svg>
      <input
        type="text"
        value={localValue}
        placeholder={isNumeric ? '>10 <50, =22' : 'filter…'}
        title={
          isNumeric
            ? 'Numeric filter: =, !=, >, >=, <, <=. Space=AND, Comma=OR.'
            : 'Text filter: space=AND, comma=OR, !=NOT, "quotes"=phrase.'
        }
        onChange={(e) => {
          const v = e.target.value;
          setLocalValue(v);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            onFilterChange(colIndex, v);
            timerRef.current = null;
          }, FILTER_DEBOUNCE_MS);
        }}
        className={`w-full min-w-0 rounded px-1 py-0.5 text-[10px] font-normal bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-slate-900 ${
          isActive
            ? 'border border-blue-400 text-slate-800 dark:border-blue-600 dark:text-slate-200'
            : 'border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-400'
        }`}
      />
      {isActive && (
        <button
          title="Clear filter"
          onClick={() => {
            if (timerRef.current) {
              clearTimeout(timerRef.current);
              timerRef.current = null;
            }
            setLocalValue('');
            onFilterChange(colIndex, '');
          }}
          className="shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:text-red-500 dark:hover:text-red-400"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
};

// ============================================================================
// COLUMN HEADER
// ============================================================================

const ColumnHeader: React.FC<{
  header: string;
  colIndex: number;
  sortState: SortState;
  colType: ColumnType;
  isEditing: boolean;
  editValue: string;
  filterValue: string;
  onEditChange: (v: string) => void;
  onEditStart: () => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onSort: (col: number, dir: 'asc' | 'desc') => void;
  onTypeChange: (col: number, t: ColumnType) => void;
  onFilterChange: (col: number, value: string) => void;
  isMergeView?: boolean;
}> = ({
  header,
  colIndex,
  sortState,
  colType,
  isEditing,
  editValue,
  filterValue,
  onEditChange,
  onEditStart,
  onEditSave,
  onEditCancel,
  onSort,
  onTypeChange,
  onFilterChange,
  isMergeView = false,
}) => {
  const isActiveSort = sortState.columnIndex === colIndex;
  const isAsc = isActiveSort && sortState.direction === 'asc';
  const isDesc = isActiveSort && sortState.direction === 'desc';

  if (isEditing) {
    return (
      <InlineHeaderEditor
        value={editValue}
        onChange={onEditChange}
        onSave={onEditSave}
        onCancel={onEditCancel}
        isMergeView={isMergeView}
      />
    );
  }

  return (
    <div className="group/header flex w-full flex-col">
      <div className="flex w-full items-center justify-between gap-1">
        <div className="-my-1 flex shrink-0 flex-col opacity-0 transition-opacity group-hover/header:opacity-100">
          <button
            onClick={() => onSort(colIndex, 'asc')}
            title="Sort ascending"
            className={`p-0 leading-none transition-colors ${isAsc ? 'text-blue-600 dark:text-blue-400' : 'text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400'}`}
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"><path d="M6 2L10 8H2L6 2Z" /></svg>
          </button>
          <button
            onClick={() => onSort(colIndex, 'desc')}
            title="Sort descending"
            className={`p-0 leading-none transition-colors ${isDesc ? 'text-blue-600 dark:text-blue-400' : 'text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400'}`}
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"><path d="M6 10L2 4H10L6 10Z" /></svg>
          </button>
        </div>
        <span className={`flex-1 truncate ${isMergeView ? '' : 'font-semibold'}`}>{header}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            const i = ALL_COLUMN_TYPES.indexOf(colType);
            onTypeChange(colIndex, ALL_COLUMN_TYPES[(i + 1) % ALL_COLUMN_TYPES.length]);
          }}
          title={`Column type: ${colType}. Click to cycle.`}
          className={`shrink-0 cursor-pointer rounded border border-transparent px-1.5 py-0 text-[9px] font-bold leading-4 tracking-wide transition-all hover:border-slate-400 dark:hover:border-slate-500 ${
            isActiveSort ? 'opacity-100' : 'opacity-0 group-hover/header:opacity-70'
          } ${COLUMN_TYPE_COLORS[colType]}`}
        >
          {COLUMN_TYPE_LABELS[colType]}
        </button>
        <button
          onClick={onEditStart}
          title="Rename column"
          className="shrink-0 p-0.5 text-slate-400 opacity-0 transition-all hover:text-blue-500 group-hover/header:opacity-100 dark:hover:text-blue-400"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
        {isActiveSort && (
          <span className="shrink-0 text-blue-500 dark:text-blue-400">
            {isAsc ? (
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"><path d="M6 2L10 8H2L6 2Z" /></svg>
            ) : (
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"><path d="M6 10L2 4H10L6 10Z" /></svg>
            )}
          </span>
        )}
      </div>
      <ColumnFilterInput colIndex={colIndex} filterValue={filterValue} colType={colType} onFilterChange={onFilterChange} />
    </div>
  );
};

// ============================================================================
// MAIN APPLICATION
// ============================================================================

const App: React.FC = () => {
  // ── Settings: synchronous init so the theme class lands before first paint ──
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(LS_SETTINGS_KEY);
      return normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  });

  const [dataSets, setDataSets] = useState<DataSet[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [loadingState, setLoadingState] = useState<LoadingState>(() =>
    NEEDS_BOOT_RESTORE
      ? { active: true, phase: 'restoring', current: 0, total: 0, fileName: '' }
      : DEFAULT_LOADING_STATE,
  );
  const [sortState, setSortState] = useState<SortState>(() => settings.sortState ?? DEFAULT_SORT_STATE);
  const [columnFilters, setColumnFilters] = useState<Record<number, string>>(() => settings.columnFilters ?? {});
  const [editingHeaderKey, setEditingHeaderKey] = useState<string | null>(null);
  const [editHeaderValue, setEditHeaderValue] = useState('');

  // ── Panels: identical model to fundamentals (reset on refresh, explicit toggle) ──
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // ── Google session ──
  const [isAuthed, setIsAuthed] = useState(false);
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastSave, setLastSave] = useState<SaveResult | null>(null);
  const [localUsage, setLocalUsage] = useState({ settings: 0, data: 0 });

  const tokenRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const settingsFileRef = useRef<HTMLInputElement>(null);
  const isRestoringRef = useRef(NEEDS_BOOT_RESTORE);
  const settingsRef = useRef(settings);
  const dataSetsRef = useRef(dataSets);

  settingsRef.current = settings;
  dataSetsRef.current = dataSets;

  const lang = settings.lang;
  const dark = settings.theme === 'dark';
  const isBusy = busy > 0;

  // ── Debug log sink ──
  useEffect(() => {
    logSink = (entry) => setLogs((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
    return () => {
      logSink = null;
    };
  }, []);

  const addToast = useCallback((message: string, level: Toast['level'] = 'info') => {
    const id = uid();
    setToasts((prev) => [...prev, { id, message, level }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), TOAST_MS);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((x) => x.id !== id)), []);

  // ── Repositories ─────────────────────────────────────────────────────────
  // Constructed once; they read their configuration lazily through closures so
  // switching documents/tokens never requires rebuilding the object graph.
  const storage = useMemo(() => resolveStorage(), []);
  const localSettingsRepo: SettingsRepository = useMemo(
    () => createLocalSettingsRepository(storage),
    [storage],
  );
  const localDataRepo: DataRepository = useMemo(
    () => createLocalDataRepository(storage, LS_DATA_KEY, DATA_BUDGET_BYTES, LS_SETTINGS_KEY),
    [storage],
  );

  const sheetsClient = useRef<SheetsClient | null>(null);
  const getClient = useCallback(() => sheetsClient.current, []);
  const settingsDocId = useCallback(
    () => normalizeSpreadsheetId(settingsRef.current.settingsDocumentId),
    [],
  );
  const dataDocId = useCallback(
    () =>
      normalizeSpreadsheetId(
        settingsRef.current.dataDocumentId || settingsRef.current.settingsDocumentId,
      ),
    [],
  );

  const googleSettingsRepo: SettingsRepository = useMemo(
    () => createGoogleSettingsRepository({ client: getClient, documentId: settingsDocId, tab: SHEET_TABS.settings }),
    [getClient, settingsDocId],
  );
  const googleDataRepo: DataRepository = useMemo(
    () => createGoogleDataRepository({ client: getClient, documentId: dataDocId, tab: SHEET_TABS.data }),
    [getClient, dataDocId],
  );

  /**
   * ACTIVE REPOSITORIES — the only place the backend choice is resolved.
   * Everything downstream consumes `Repository<T>` and stays backend-agnostic.
   */
  const googleUsable = isAuthed && Boolean(settingsDocId() || dataDocId());
  const activeBackend: BackendKind = settings.backend === 'google' && googleUsable ? 'google' : 'local';
  const activeDataRepo: DataRepository = activeBackend === 'google' ? googleDataRepo : localDataRepo;

  const refreshUsage = useCallback(async () => {
    const [s, d] = await Promise.all([localSettingsRepo.usage(), localDataRepo.usage()]);
    setLocalUsage({ settings: s ?? 0, data: d ?? 0 });
  }, [localDataRepo, localSettingsRepo]);

  // ── I1: settings ALWAYS persist locally, on every change ──────────────────
  useEffect(() => {
    void localSettingsRepo.save(settings).then(() => refreshUsage());
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
  }, [settings, localSettingsRepo, refreshUsage]);

  // Keep sort/filter mirrored into settings so they survive reloads.
  useEffect(() => {
    setSettings((prev) => {
      const p = prev.sortState ?? DEFAULT_SORT_STATE;
      if (p.columnIndex === sortState.columnIndex && p.direction === sortState.direction) return prev;
      return { ...prev, sortState };
    });
  }, [sortState]);

  useEffect(() => {
    setSettings((prev) => {
      const prevKeys = Object.keys(prev.columnFilters ?? {});
      const nextKeys = Object.keys(columnFilters);
      if (
        prevKeys.length === nextKeys.length &&
        nextKeys.every((k) => prev.columnFilters?.[Number(k)] === columnFilters[Number(k)])
      ) {
        return prev;
      }
      return { ...prev, columnFilters };
    });
  }, [columnFilters]);

  // ── I2 + I3: data persists locally, budgeted, never at settings' expense ──
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (activeBackend !== 'local') return;
    if (!settings.rememberData) return;
    if (dataSets.length === 0) {
      void localDataRepo.clear().then(refreshUsage);
      return;
    }
    void localDataRepo.save(dataSets).then((res) => {
      setLastSave(res);
      if (!res.ok) {
        dbg('local data save failed', res.failure, res.message);
        addToast(res.message ?? 'Local data was not saved', res.failure === 'over-budget' ? 'warn' : 'error');
      }
      void refreshUsage();
    });
  }, [dataSets, settings.rememberData, activeBackend, localDataRepo, addToast, refreshUsage]);

  // ── Boot restore from localStorage ────────────────────────────────────────
  useEffect(() => {
    if (!NEEDS_BOOT_RESTORE) {
      void refreshUsage();
      return;
    }
    let cancelled = false;
    void (async () => {
      await yieldToMain();
      await waitForPaint();
      const restored = await localDataRepo.load();
      if (cancelled) return;
      if (restored?.length) {
        setDataSets(restored);
        dbg('boot restore', restored.length, 'dataset(s)');
        await yieldToMain();
        await waitForPaint();
      }
      isRestoringRef.current = false;
      setLoadingState(DEFAULT_LOADING_STATE);
      void refreshUsage();
    })();
    return () => {
      cancelled = true;
      isRestoringRef.current = false;
    };
  }, [localDataRepo, refreshUsage]);

  // ── Paint-gated dismissal of the "rendering" spinner ──────────────────────
  useEffect(() => {
    if (loadingState.phase !== 'rendering') return;
    let cancelled = false;
    void (async () => {
      await waitForPaint();
      await waitForPaint();
      if (!cancelled) setLoadingState(DEFAULT_LOADING_STATE);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadingState.phase]);

  // ── Google auth ───────────────────────────────────────────────────────────
  const connect = useCallback(
    async (interactive: boolean) => {
      const clientId = settingsRef.current.googleClientId.trim();
      if (!clientId) throw new Error('Set the OAuth client ID first');
      const token = await requestAccessToken(clientId, interactive);
      tokenRef.current = token;
      sheetsClient.current = createSheetsClient({
        getToken: () => {
          if (!tokenRef.current) throw new Error('Google session expired');
          return tokenRef.current;
        },
        log: (...a) => dbg(...a),
      });
      setIsAuthed(true);
      try {
        const email = await sheetsClient.current.userEmail();
        setAccount(email);
        setSettings((p) => ({ ...p, lastAccountEmail: email }));
      } catch {
        setAccount(settingsRef.current.lastAccountEmail);
      }
      dbg('google connected');
      return token;
    },
    [],
  );

  const disconnect = useCallback(() => {
    if (tokenRef.current) revokeAccessToken(tokenRef.current);
    tokenRef.current = null;
    sheetsClient.current = null;
    setIsAuthed(false);
    setAccount('');
    setSettings((p) => ({ ...p, backend: 'local' }));
    dbg('google disconnected');
    addToast('Disconnected from Google — using localStorage', 'info');
  }, [addToast]);

  const run = useCallback(
    async (label: string, op: () => Promise<void>) => {
      setBusy((c) => c + 1);
      try {
        await op();
      } catch (e) {
        dbg(label, 'failed:', errorMessage(e));
        addToast(`${label}: ${errorMessage(e)}`, 'error');
      } finally {
        setBusy((c) => c - 1);
      }
    },
    [addToast],
  );

  // ── Silent reconnect at boot when Google was the last used backend ────────
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const s = settingsRef.current;
    if (s.backend !== 'google' || !s.googleClientId.trim() || !normalizeSpreadsheetId(s.settingsDocumentId || s.dataDocumentId)) {
      return;
    }
    void (async () => {
      try {
        await connect(false);
        // Remote settings merge over local, except device-scoped keys.
        const remote = await googleSettingsRepo.load().catch(() => null);
        if (remote) {
          setSettings((prev) => normalizeSettings(mergeSettings(prev, remote)));
          dbg('settings merged from Google');
        }
        const rows = await googleDataRepo.load().catch(() => null);
        if (rows?.length) {
          setDataSets(rows);
          dbg('data loaded from Google:', rows.length, 'file(s)');
        }
      } catch (e) {
        dbg('silent reconnect failed:', errorMessage(e));
        addToast('Google sign-in required — using localStorage until you reconnect', 'warn');
      }
    })();
  }, [connect, googleDataRepo, googleSettingsRepo, addToast]);

  // ── I5: flush settings to BOTH backends when the tab goes away ────────────
  useEffect(() => {
    const unsubscribe = createShutdownFlusher({
      getSettings: () => settingsRef.current,
      localSettings: localSettingsRepo,
      googleSettings: () => (googleSettingsRepo.isReady() ? googleSettingsRepo : null),
      keepaliveWrite: (rows) => {
        const client = sheetsClient.current;
        const docId = settingsDocId();
        if (!client || !docId) return;
        // keepalive fetch survives unload; settings are small enough for it.
        void client.writeValues(docId, SHEET_TABS.settings, gridRange(rows), rows, true);
      },
      log: (...a) => dbg(...a),
    });
    return unsubscribe;
  }, [localSettingsRepo, googleSettingsRepo, settingsDocId]);

  // ── Backend switching ─────────────────────────────────────────────────────

  /** local → google. Attaches tabs, pushes settings up, pulls data down. */
  const switchToGoogle = useCallback(
    () =>
      run('Switch to Google', async () => {
        if (!tokenRef.current) await connect(true);
        const client = sheetsClient.current!;
        const sDoc = settingsDocId();
        const dDoc = dataDocId();
        if (!sDoc && !dDoc) throw new Error('Configure a spreadsheet first');
        if (sDoc) {
          await client.ensureTab(sDoc, SHEET_TABS.settings);
          await googleSettingsRepo.save(settingsRef.current);
        }
        if (dDoc) await client.ensureTab(dDoc, SHEET_TABS.data);
        setSettings((p) => ({ ...p, backend: 'google' }));
        const remote = await googleDataRepo.load().catch(() => null);
        if (remote?.length) setDataSets(remote);
        dbg('switched to google');
        addToast('Google Sheets is now the active database', 'info');
      }),
    [run, connect, settingsDocId, dataDocId, googleSettingsRepo, googleDataRepo, addToast],
  );

  /**
   * google → local. I4: mirror sheet rows DOWN into localStorage first, then
   * flip the backend. Never the other way around.
   */
  const switchToLocal = useCallback(
    () =>
      run('Switch to localStorage', async () => {
        if (googleDataRepo.isReady()) {
          const outcome = await syncDataFromGoogleToLocal(googleDataRepo, localDataRepo);
          dbg('google→local sync:', JSON.stringify(outcome));
          if (outcome.synced) {
            addToast(outcome.message ?? 'Synced from Google', 'info');
            const mirrored = await localDataRepo.load();
            if (mirrored?.length) setDataSets(mirrored);
          } else if (outcome.message) {
            addToast(outcome.message, outcome.save?.failure === 'over-budget' ? 'warn' : 'info');
            // Even when the local mirror could not hold it all, keep what we read.
            const remote = await googleDataRepo.load().catch(() => null);
            if (remote?.length) setDataSets(remote);
          }
        }
        setSettings((p) => ({ ...p, backend: 'local' }));
        void refreshUsage();
      }),
    [run, googleDataRepo, localDataRepo, addToast, refreshUsage],
  );

  const pushDataToGoogle = useCallback(
    () =>
      run('Push data', async () => {
        if (!googleDataRepo.isReady()) throw new Error('Connect Google and set a data spreadsheet first');
        const res = await googleDataRepo.save(dataSetsRef.current);
        setLastSave(res);
        if (!res.ok) throw new Error(res.message ?? 'Push failed');
        addToast(`Pushed ${getTotalRowCount(dataSetsRef.current)} row(s) to Google`, 'info');
      }),
    [run, googleDataRepo, addToast],
  );

  const pullDataFromGoogle = useCallback(
    () =>
      run('Pull data', async () => {
        if (!googleDataRepo.isReady()) throw new Error('Connect Google and set a data spreadsheet first');
        const remote = await googleDataRepo.load();
        if (!remote?.length) {
          addToast('The Google data sheet is empty', 'warn');
          return;
        }
        setDataSets(remote);
        addToast(`Loaded ${getTotalRowCount(remote)} row(s) from Google`, 'info');
      }),
    [run, googleDataRepo, addToast],
  );

  // ── Settings mutation helpers ─────────────────────────────────────────────
  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  /** Heavy layout toggles show the spinner first so the UI never appears frozen. */
  const updateSettingWithSpinner = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      if (LAYOUT_RESTRUCTURING_KEYS.has(key) && getTotalRowCount(dataSetsRef.current) >= EXPENSIVE_TOGGLE_ROW_THRESHOLD) {
        setLoadingState({ active: true, phase: 'rendering', current: 0, total: 0, fileName: '' });
        await yieldToMain();
      }
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  /**
   * Paste-once behaviour: typing the settings document also fills the data
   * document while `autoFillDataDocument` is on and the user has not diverged.
   */
  const updateSettingsDocument = useCallback((raw: string) => {
    setSettings((prev) => {
      const shouldMirror =
        prev.autoFillDataDocument &&
        (prev.dataDocumentId.trim() === '' || prev.dataDocumentId.trim() === prev.settingsDocumentId.trim());
      return { ...prev, settingsDocumentId: raw, dataDocumentId: shouldMirror ? raw : prev.dataDocumentId };
    });
  }, []);

  // ── CSV import / demo / clear ─────────────────────────────────────────────
  const processFiles = useCallback(async (files: File[]) => {
    setLoadingState({ active: true, phase: 'parsing', current: 0, total: files.length, fileName: '' });
    await yieldToMain();
    const parsed: DataSet[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setLoadingState((p) => ({ ...p, fileName: file.name }));
      await yieldToMain();
      try {
        const text = await readFileAsText(file);
        await yieldToMain();
        parsed.push({ fileName: file.name, data: extractValidTableData(text) });
      } catch (e) {
        dbg('parse failed', file.name, errorMessage(e));
      }
      setLoadingState((p) => ({ ...p, current: i + 1 }));
      await yieldToMain();
    }
    setLoadingState((p) => ({ ...p, phase: 'rendering', fileName: '' }));
    await yieldToMain();
    setDataSets((prev) => [...prev, ...parsed].sort((a, b) => naturalCollator.compare(a.fileName, b.fileName)));
    dbg('imported', parsed.length, 'file(s)');
  }, []);

  const handleFileUpload = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files?.length) return;
      const arr = Array.from(files);
      e.target.value = '';
      void processFiles(arr).catch(() => setLoadingState(DEFAULT_LOADING_STATE));
    },
    [processFiles],
  );

  const loadDemo = useCallback(() => {
    setDataSets((prev) =>
      prev.some((d) => d.fileName === DEMO_FILE_NAME)
        ? prev
        : [...prev, { fileName: DEMO_FILE_NAME, data: extractValidTableData(DEMO_CSV) }].sort((a, b) =>
            naturalCollator.compare(a.fileName, b.fileName),
          ),
    );
    dbg('demo dataset loaded');
  }, []);

  const clearData = useCallback(() => {
    setDataSets([]);
    setActiveTab(0);
    setSortState(DEFAULT_SORT_STATE);
    setColumnFilters({});
    void localDataRepo.clear().then(refreshUsage);
    dbg('data cleared');
  }, [localDataRepo, refreshUsage]);

  const resetSettings = useCallback(() => {
    setSettings({ ...DEFAULT_SETTINGS });
    setSortState(DEFAULT_SORT_STATE);
    setColumnFilters({});
    dbg('settings reset');
  }, []);

  const exportSettings = useCallback(() => {
    const blob = new Blob([JSON.stringify(settingsRef.current, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'app-template-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importSettings = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        const next = normalizeSettings(parsed);
        setSettings(next);
        setColumnFilters(next.columnFilters ?? {});
        setSortState(next.sortState ?? DEFAULT_SORT_STATE);
        dbg('settings imported');
      } catch {
        addToast('Invalid settings JSON', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [addToast]);

  // ── Table derivation ──────────────────────────────────────────────────────
  const startEditingHeader = (fileIndex: number, colIndex: number, currentValue: string) => {
    setEditingHeaderKey(`${fileIndex}-${colIndex}`);
    setEditHeaderValue(currentValue);
  };
  const saveHeaderName = (colIndex: number) => {
    if (editHeaderValue.trim() !== '') {
      setSettings((prev) => ({
        ...prev,
        columnCustomNames: { ...prev.columnCustomNames, [colIndex]: editHeaderValue.trim() },
      }));
    }
    setEditingHeaderKey(null);
  };
  const cancelEditingHeader = () => {
    setEditingHeaderKey(null);
    setEditHeaderValue('');
  };

  const handleSort = useCallback((colIndex: number, direction: 'asc' | 'desc') => {
    setSortState((prev) =>
      prev.columnIndex === colIndex && prev.direction === direction ? DEFAULT_SORT_STATE : { columnIndex: colIndex, direction },
    );
  }, []);

  const handleTypeChange = useCallback((colIndex: number, newType: ColumnType) => {
    setSettings((prev) => ({
      ...prev,
      columnTypeOverrides: { ...prev.columnTypeOverrides, [colIndex]: newType },
    }));
    setSortState(DEFAULT_SORT_STATE);
  }, []);

  const handleFilterChange = useCallback((colIndex: number, value: string) => {
    setColumnFilters((prev) => {
      const next = { ...prev };
      if (value.trim() === '') delete next[colIndex];
      else next[colIndex] = value;
      return next;
    });
  }, []);

  const getFileHeadersAndRows = useCallback(
    (raw: string[][]) => {
      if (raw.length === 0) return { headers: [] as string[], rows: [] as string[][] };
      const totalColumns = raw[0].length;
      const fileHeaders = settings.firstRowIsHeader ? raw[0] : [];
      const headers = Array.from(
        { length: totalColumns },
        (_, i) => settings.columnCustomNames[i] || (settings.firstRowIsHeader && fileHeaders[i] ? fileHeaders[i] : `Col ${i + 1}`),
      );
      const rows = settings.firstRowIsHeader ? raw.slice(1) : raw;
      return { headers, rows };
    },
    [settings.firstRowIsHeader, settings.columnCustomNames],
  );

  const getColumnType = useCallback(
    (colIndex: number, dataRows: string[][]): ColumnType =>
      settings.columnTypeOverrides[colIndex] || detectColumnType(dataRows, colIndex),
    [settings.columnTypeOverrides],
  );

  const applySortToRows = useCallback(
    (rows: string[][], dataRows: string[][]): string[][] => {
      if (sortState.columnIndex === null) return rows;
      const colType = getColumnType(sortState.columnIndex, dataRows);
      return [...rows].sort(getComparator(sortState.columnIndex, sortState.direction, colType));
    },
    [sortState, getColumnType],
  );

  const activeData = dataSets[activeTab]?.data ?? [];

  const isolatedTable = useMemo(() => {
    const { headers, rows } = getFileHeadersAndRows(activeData);
    const dataRows = settings.firstRowIsHeader ? activeData.slice(1) : activeData;
    const getColType = (i: number) => getColumnType(i, dataRows);
    const filtered = applyFilters(rows, columnFilters, getColType);
    const sorted = applySortToRows(filtered, dataRows);
    return { headers, rows: sorted, totalBeforeFilter: rows.length };
  }, [activeData, getFileHeadersAndRows, applySortToRows, columnFilters, getColumnType, settings.firstRowIsHeader]);

  const activeColumnTypes = useMemo((): ColumnType[] => {
    const dataRows = settings.firstRowIsHeader ? activeData.slice(1) : activeData;
    if (dataRows.length === 0) return [];
    return Array.from({ length: dataRows[0]?.length ?? 0 }, (_, i) => getColumnType(i, dataRows));
  }, [activeData, settings.firstRowIsHeader, getColumnType]);

  const hasActiveFilters = Object.keys(columnFilters).length > 0;
  const totalRows = getTotalRowCount(dataSets);

  // ── Exports ───────────────────────────────────────────────────────────────
  const exportTabCSV = useCallback(() => {
    if (dataSets.length === 0) return;
    downloadFile(
      buildCSVString(isolatedTable.headers, isolatedTable.rows),
      makeExportFileName(dataSets[activeTab]?.fileName || 'exported_data.csv'),
    );
  }, [dataSets, isolatedTable, activeTab]);

  const buildBlocks = useCallback(
    () =>
      dataSets.map((dataset) => {
        const { headers, rows } = getFileHeadersAndRows(dataset.data);
        const dataRows = settings.firstRowIsHeader ? dataset.data.slice(1) : dataset.data;
        const getColType = (i: number) => getColumnType(i, dataRows);
        const sorted = applySortToRows(applyFilters(rows, columnFilters, getColType), dataRows);
        return { fileName: dataset.fileName, headers, rows: sorted };
      }),
    [dataSets, getFileHeadersAndRows, settings.firstRowIsHeader, getColumnType, columnFilters, applySortToRows],
  );

  const exportMergedCSV = useCallback(() => {
    if (dataSets.length === 0) return;
    const blocks = buildBlocks();
    const maxCols = Math.max(1, ...blocks.map((b) => Math.max(b.headers.length, ...b.rows.map((r) => r.length), 1)));
    const merged: string[][] = [];
    for (const block of blocks) {
      merged.push(padCSVRow([`FILE: ${block.fileName}`], maxCols));
      merged.push(padCSVRow(block.headers, maxCols));
      for (const row of block.rows) merged.push(padCSVRow(row, maxCols));
      merged.push(padCSVRow([], maxCols));
    }
    downloadFile(merged.map((r) => r.map((c) => (c.includes(',') || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'), 'merged_exported.csv');
  }, [dataSets, buildBlocks]);

  const exportAllCSV = useCallback(() => {
    for (const block of buildBlocks()) {
      downloadFile(buildCSVString(block.headers, block.rows), makeExportFileName(block.fileName));
    }
  }, [buildBlocks]);

  // ── Theme tokens (mirroring the fundamentals palette) ─────────────────────
  const card = dark
    ? 'bg-slate-800 border-slate-600 text-slate-100'
    : 'bg-white border-slate-200 text-slate-900 shadow-sm';
  const bdr = dark ? 'border-slate-800' : 'border-slate-200';
  const mt = dark ? 'text-slate-400' : 'text-slate-500';
  const t1 = dark ? 'text-slate-100' : 'text-slate-800';
  const t2 = dark ? 'text-slate-300' : 'text-slate-600';
  const inputCls = `w-full rounded-lg border px-2 py-1.5 text-xs outline-none transition ${
    dark
      ? 'border-slate-700 bg-slate-900 text-slate-100 placeholder-slate-500 focus:border-slate-500'
      : 'border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:border-slate-500'
  }`;
  const btnPrimary =
    'inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50';
  const btnGhost = `inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
    dark
      ? 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'
      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
  }`;
  const sectionLabel = `text-[10px] font-bold uppercase tracking-wide ${mt}`;

  const debugStatus = isBusy
    ? t('debug.loading', lang)
    : dataSets.length > 0
      ? t('debug.ready', lang)
      : t('debug.idle', lang);

  return (
    <Fragment>
      <LoadingOverlay state={loadingState} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="flex h-screen flex-col overflow-hidden bg-slate-50 font-sans text-slate-900 transition-colors dark:bg-slate-900 dark:text-slate-100">
        {/* ══════════════════ HEADER ══════════════════ */}
        <div className={`sticky top-0 z-50 border-b backdrop-blur-md ${bdr} ${dark ? 'bg-slate-900/95' : 'bg-white/95'}`}>
          <div className="px-4 xl:px-8">
            <div className="flex items-center gap-2 py-3 sm:gap-3">
              {/* 1. DEBUG popover — anchored LEFT, overlay only (never reflows) */}
              <div className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setShowDebug((open) => !open)}
                  title={t('tip.debug', lang)}
                  aria-label={t('tip.debug', lang)}
                  aria-expanded={showDebug}
                  className={`rounded-lg px-2 py-1.5 text-xs transition-colors ${
                    showDebug
                      ? 'bg-emerald-500 text-white'
                      : dark
                        ? 'text-slate-600 hover:bg-slate-800 hover:text-slate-400'
                        : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                  }`}
                >
                  ⌘
                </button>

                {showDebug && (
                  <div
                    role="dialog"
                    aria-label={t('debug.title', lang)}
                    className={`absolute left-0 top-full mt-2 w-[min(92vw,22rem)] z-[60] ${card} border rounded-xl shadow-xl p-3 space-y-3 max-h-[80vh] overflow-y-auto`}
                  >
                    <div className={`text-sm font-bold ${t1}`}>⌘ {t('debug.title', lang)}</div>

                    <div className={sectionLabel}>{t('debug.overview', lang)}</div>
                    <div className={`rounded-lg border ${bdr} divide-y ${bdr}`}>
                      <DebugRow
                        label={t('debug.status', lang)}
                        value={debugStatus}
                        tone={isBusy ? 'text-amber-500' : 'text-emerald-500'}
                      />
                      <DebugRow label={t('debug.backend', lang)} value={activeBackend.toUpperCase()} />
                      <div className="grid grid-cols-2 divide-x divide-inherit">
                        <div className="px-3 py-2">
                          <div className={`text-[10px] ${mt}`}>{t('debug.files', lang)}</div>
                          <div className={`font-mono text-xs font-semibold ${t1}`}>{dataSets.length}</div>
                        </div>
                        <div className="px-3 py-2">
                          <div className={`text-[10px] ${mt}`}>{t('debug.rows', lang)}</div>
                          <div className={`font-mono text-xs font-semibold ${t1}`}>{totalRows}</div>
                        </div>
                      </div>
                      <DebugRow label={t('debug.settingsRepo', lang)} value={activeBackend === 'google' && googleSettingsRepo.isReady() ? googleSettingsRepo.id : localSettingsRepo.id} />
                      <DebugRow label={t('debug.dataRepo', lang)} value={activeDataRepo.id} />
                    </div>

                    <div className={`${sectionLabel} pt-1`}>{t('debug.storage', lang)}</div>
                    <div className={`rounded-lg border ${bdr} divide-y ${bdr}`}>
                      <DebugRow label={t('debug.localSettings', lang)} value={formatBytes(localUsage.settings)} />
                      <DebugRow label={t('debug.localData', lang)} value={formatBytes(localUsage.data)} />
                      <DebugRow
                        label={t('debug.budget', lang)}
                        value={`${formatBytes(localUsage.data)} / ${DATA_BUDGET_MB} MB`}
                        tone={localUsage.data > DATA_BUDGET_BYTES * 0.9 ? 'text-amber-500' : undefined}
                      />
                      {lastSave && (
                        <DebugRow
                          label="Last write"
                          value={lastSave.ok ? `ok · ${formatBytes(lastSave.bytes)}` : `${lastSave.failure} · ${formatBytes(lastSave.bytes)}`}
                          tone={lastSave.ok ? 'text-emerald-500' : 'text-rose-500'}
                        />
                      )}
                    </div>
                    <div className={`text-[10px] ${mt}`}>
                      Settings are always written to localStorage; data is capped at {DATA_BUDGET_MB} MB and can never evict them.
                    </div>

                    <div className={`${sectionLabel} pt-1`}>{t('debug.connection', lang)}</div>
                    <div className={`rounded-lg border ${bdr} divide-y ${bdr}`}>
                      <DebugRow
                        label={t('debug.account', lang)}
                        value={isAuthed ? account || 'connected' : t('debug.notConnected', lang)}
                        tone={isAuthed ? 'text-emerald-500' : mt}
                      />
                      <DebugRow label={t('debug.settingsDoc', lang)} value={settingsDocId() || '—'} />
                      <DebugRow label={t('debug.dataDoc', lang)} value={dataDocId() || '—'} />
                      <DebugRow label={t('debug.tabs', lang)} value={`${SHEET_TABS.settings} · ${SHEET_TABS.data}`} />
                    </div>

                    <div className={`${sectionLabel} pt-1`}>{t('debug.activity', lang)}</div>
                    <div className={`rounded-lg border ${bdr} divide-y ${bdr} max-h-40 overflow-y-auto`}>
                      {logs.length === 0 ? (
                        <div className={`px-3 py-2 text-xs ${mt}`}>{t('debug.none', lang)}</div>
                      ) : (
                        logs.map((entry, i) => (
                          <div key={`${entry.at}-${i}`} className="px-3 py-1.5">
                            <div className={`text-[10px] ${mt}`}>{entry.at}</div>
                            <div className={`font-mono text-[11px] break-words ${t2}`}>{entry.message}</div>
                          </div>
                        ))
                      )}
                    </div>
                    <div className={`text-[10px] ${mt}`}>{t('debug.hintDebug', lang)}</div>
                  </div>
                )}
              </div>

              {/* 2. Title */}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <svg className="h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-bold tracking-tight sm:text-base">{t('app.title', lang)}</h1>
                  <p className={`hidden truncate text-[10px] sm:block ${mt}`}>{t('app.subtitle', lang)}</p>
                </div>
              </div>

              {/* 3. Backend indicator */}
              <div
                title={activeBackend === 'google' ? `Google Sheets · ${account || 'connected'}` : 'Browser localStorage'}
                className={`hidden flex-shrink-0 rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-wide sm:block ${
                  activeBackend === 'google'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : dark
                      ? 'border-slate-700 bg-slate-800 text-slate-400'
                      : 'border-slate-200 bg-slate-100 text-slate-500'
                }`}
              >
                {activeBackend === 'google' ? '☁︎ sheets' : '▤ local'}
              </div>

              {/* 4. Language */}
              <div className="flex-shrink-0" title={t('tip.lang', lang)}>
                <Pill
                  value={lang}
                  options={[{ k: 'en', l: '🇺🇸' }, { k: 'ru', l: '🇷🇺' }]}
                  onChange={(k) => updateSetting('lang', k as Language)}
                  dark={dark}
                  title={t('tip.lang', lang)}
                />
              </div>

              {/* 5. SETTINGS popover — anchored RIGHT, same dimensions as debug */}
              <div className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setShowSettings((open) => !open)}
                  title={t('tip.settings', lang)}
                  aria-label={t('tip.settings', lang)}
                  aria-expanded={showSettings}
                  className={`flex-shrink-0 rounded-lg px-2 py-1.5 text-base leading-none transition-colors ${
                    showSettings
                      ? 'bg-emerald-500 text-white'
                      : dark
                        ? 'text-slate-300 hover:bg-slate-800'
                        : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  ⚙️
                </button>

                {showSettings && (
                  <div
                    role="dialog"
                    aria-label={t('settings.title', lang)}
                    className={`absolute right-0 top-full mt-2 w-[min(92vw,22rem)] z-[60] ${card} border rounded-xl shadow-xl p-3 space-y-3 max-h-[80vh] overflow-y-auto`}
                  >
                    <div className={`text-sm font-bold ${t1}`}>⚙️ {t('settings.title', lang)}</div>

                    {/* ── Display ── */}
                    <div className={sectionLabel}>{t('settings.display', lang)}</div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs ${t2}`}>{t('settings.theme', lang)}</span>
                      <Pill
                        value={settings.theme}
                        options={[{ k: 'light', l: '☀️' }, { k: 'dark', l: '🌙' }]}
                        onChange={(k) => updateSetting('theme', k as 'light' | 'dark')}
                        dark={dark}
                        title={t('tip.theme', lang)}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs ${t2}`}>{t('settings.lang', lang)}</span>
                      <Pill
                        value={lang}
                        options={[{ k: 'en', l: '🇺🇸' }, { k: 'ru', l: '🇷🇺' }]}
                        onChange={(k) => updateSetting('lang', k as Language)}
                        dark={dark}
                        title={t('tip.lang', lang)}
                      />
                    </div>

                    {/* ── Table ── */}
                    <div className={`${sectionLabel} pt-1`}>{t('settings.table', lang)}</div>
                    <Toggle label={t('settings.stickyHeaders', lang)} checked={settings.stickyHeaders} onChange={(v) => updateSetting('stickyHeaders', v)} />
                    <Toggle label={t('settings.mergeFiles', lang)} checked={settings.mergeFiles} onChange={(v) => void updateSettingWithSpinner('mergeFiles', v)} />
                    <Toggle label={t('settings.firstRow', lang)} checked={settings.firstRowIsHeader} onChange={(v) => void updateSettingWithSpinner('firstRowIsHeader', v)} />
                    <Toggle label={t('settings.firstCol', lang)} checked={settings.firstColIsHeader} onChange={(v) => void updateSettingWithSpinner('firstColIsHeader', v)} />

                    {/* ── Data & storage ── */}
                    <div className={`${sectionLabel} pt-1`}>{t('settings.data', lang)}</div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs ${t2}`}>{t('settings.backend', lang)}</span>
                      <Pill
                        value={activeBackend}
                        options={[{ k: 'local', l: '▤' }, { k: 'google', l: '☁︎' }]}
                        onChange={(k) => (k === 'google' ? void switchToGoogle() : void switchToLocal())}
                        dark={dark}
                        title={t('settings.backend', lang)}
                      />
                    </div>
                    <Toggle
                      label={t('settings.rememberData', lang)}
                      checked={settings.rememberData}
                      onChange={(v) => updateSetting('rememberData', v)}
                      hint={t('settings.rememberData.hint', lang)}
                    />
                    <div className={`text-[10px] ${mt}`}>{t('settings.rememberData.hint', lang)}</div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={btnGhost} onClick={clearData}>{t('settings.clearData', lang)}</button>
                      <button type="button" className={btnGhost} onClick={resetSettings}>{t('settings.resetSettings', lang)}</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={btnGhost} onClick={exportSettings}>{t('settings.exportSettings', lang)}</button>
                      <button type="button" className={btnGhost} onClick={() => settingsFileRef.current?.click()}>
                        {t('settings.importSettings', lang)}
                      </button>
                      <input ref={settingsFileRef} type="file" accept="application/json" className="hidden" onChange={importSettings} />
                    </div>

                    {/* ── Google Sheets ── */}
                    <div className={`${sectionLabel} pt-1`}>{t('settings.google', lang)}</div>
                    <div
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        isAuthed
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
                          : dark
                            ? 'border-slate-700 bg-slate-800/60 text-slate-300'
                            : 'border-slate-200 bg-slate-50 text-slate-600'
                      }`}
                    >
                      {isAuthed ? `Connected${account ? ` · ${account}` : ''}` : t('debug.notConnected', lang)}
                    </div>

                    <label className="block">
                      <span className={`mb-1 block text-xs ${t2}`}>{t('settings.clientId', lang)}</span>
                      <input
                        type="text"
                        value={settings.googleClientId}
                        onChange={(e) => updateSetting('googleClientId', e.target.value)}
                        placeholder="xxxx.apps.googleusercontent.com"
                        className={inputCls}
                      />
                      <span className={`mt-1 block text-[10px] ${mt}`}>{t('settings.clientId.hint', lang)}</span>
                    </label>

                    <label className="block">
                      <span className={`mb-1 block text-xs ${t2}`}>{t('settings.settingsDoc', lang)}</span>
                      <input
                        type="text"
                        value={settings.settingsDocumentId}
                        onChange={(e) => updateSettingsDocument(e.target.value)}
                        placeholder="https://docs.google.com/spreadsheets/d/…"
                        className={inputCls}
                      />
                      <span className={`mt-1 block text-[10px] ${mt}`}>{t('settings.settingsDoc.hint', lang)}</span>
                    </label>

                    <Toggle
                      label={t('settings.autoFill', lang)}
                      checked={settings.autoFillDataDocument}
                      onChange={(v) => updateSetting('autoFillDataDocument', v)}
                    />

                    <label className="block">
                      <span className={`mb-1 block text-xs ${t2}`}>{t('settings.dataDoc', lang)}</span>
                      <input
                        type="text"
                        value={settings.dataDocumentId}
                        onChange={(e) => updateSetting('dataDocumentId', e.target.value)}
                        placeholder="defaults to the settings document"
                        className={inputCls}
                      />
                      <span className={`mt-1 block text-[10px] ${mt}`}>{t('settings.dataDoc.hint', lang)}</span>
                    </label>

                    {(settingsDocId() || dataDocId()) && (
                      <div className={`space-y-1 rounded-lg border ${bdr} px-3 py-2 text-[10px]`}>
                        {settingsDocId() && (
                          <a href={spreadsheetUrl(settingsDocId())} target="_blank" rel="noreferrer" className="block break-all text-emerald-600 underline dark:text-emerald-400">
                            {t('debug.settingsDoc', lang)} ↗
                          </a>
                        )}
                        {dataDocId() && (
                          <a href={spreadsheetUrl(dataDocId())} target="_blank" rel="noreferrer" className="block break-all text-emerald-600 underline dark:text-emerald-400">
                            {t('debug.dataDoc', lang)} ↗
                          </a>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={btnPrimary}
                        disabled={isBusy || !settings.googleClientId.trim()}
                        onClick={() => void run('Connect', async () => { await connect(true); })}
                      >
                        {isAuthed ? t('settings.reconnect', lang) : t('settings.connect', lang)}
                      </button>
                      {isAuthed && (
                        <button type="button" className={btnGhost} disabled={isBusy} onClick={disconnect}>
                          {t('settings.disconnect', lang)}
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={btnGhost} disabled={isBusy || !isAuthed} onClick={() => void switchToGoogle()}>
                        {t('settings.useGoogle', lang)}
                      </button>
                      <button type="button" className={btnGhost} disabled={isBusy} onClick={() => void switchToLocal()}>
                        {t('settings.useLocal', lang)}
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={btnGhost} disabled={isBusy || !isAuthed} onClick={() => void pushDataToGoogle()}>
                        {t('settings.pushData', lang)}
                      </button>
                      <button type="button" className={btnGhost} disabled={isBusy || !isAuthed} onClick={() => void pullDataFromGoogle()}>
                        {t('settings.pullData', lang)}
                      </button>
                    </div>

                    <details className={`rounded-lg border ${bdr} px-3 py-2`}>
                      <summary className={`cursor-pointer text-xs font-semibold ${t1}`}>{t('settings.setupGuide', lang)}</summary>
                      <ol className={`mt-2 list-decimal space-y-1 pl-4 text-[10px] ${t2}`}>
                        <li>Create a project at console.cloud.google.com.</li>
                        <li>Enable the Google Sheets API for that project.</li>
                        <li>Configure the OAuth consent screen; add yourself as a test user.</li>
                        <li>
                          Create an <strong>OAuth client ID → Web application</strong> and add your origins:
                          <code className={`mt-1 block rounded px-1 py-0.5 font-mono ${dark ? 'bg-slate-900' : 'bg-slate-100'}`}>http://localhost:1234</code>
                          <code className={`mt-1 block rounded px-1 py-0.5 font-mono ${dark ? 'bg-slate-900' : 'bg-slate-100'}`}>https://USERNAME.github.io</code>
                        </li>
                        <li>Paste the client ID above, then paste a spreadsheet URL and press Connect.</li>
                        <li>
                          Tabs <code className="font-mono">{SHEET_TABS.settings}</code> and{' '}
                          <code className="font-mono">{SHEET_TABS.data}</code> are created automatically.
                        </li>
                      </ol>
                      <p className={`mt-2 text-[10px] ${mt}`}>
                        The access token lives in memory only — it is never written to localStorage or to the sheet.
                      </p>
                    </details>

                    <button type="button" className={`${btnGhost} w-full justify-center`} onClick={() => setShowSettings(false)}>
                      {t('settings.close', lang)}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ══════════════════ TOOLBAR ══════════════════ */}
        <div className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 ${bdr} ${dark ? 'bg-slate-950/40' : 'bg-white'}`}>
          <input ref={fileInputRef} type="file" multiple accept=".csv,text/csv" className="hidden" onChange={handleFileUpload} />
          <button type="button" className={btnPrimary} disabled={loadingState.active} onClick={() => fileInputRef.current?.click()}>
            {t('toolbar.import', lang)}
          </button>
          <button type="button" className={btnGhost} disabled={loadingState.active} onClick={loadDemo}>
            {t('toolbar.loadDemo', lang)}
          </button>
          {dataSets.length > 0 && (
            <Fragment>
              {settings.mergeFiles ? (
                <Fragment>
                  <button type="button" className={btnGhost} onClick={exportMergedCSV}>{t('toolbar.exportMerged', lang)}</button>
                  <button type="button" className={btnGhost} onClick={exportAllCSV}>{t('toolbar.exportAll', lang)}</button>
                </Fragment>
              ) : (
                <button type="button" className={btnGhost} onClick={exportTabCSV}>{t('toolbar.export', lang)}</button>
              )}
              <button type="button" className={btnGhost} onClick={clearData}>{t('toolbar.clear', lang)}</button>
            </Fragment>
          )}
          <div className={`ml-auto text-[11px] ${mt}`}>
            {dataSets.length} file(s) · {totalRows} row(s) · {activeBackend === 'google' ? 'Google Sheets' : `localStorage ${formatBytes(localUsage.data)}`}
          </div>
        </div>

        {/* ══════════════════ MAIN ══════════════════ */}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {dataSets.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <div className={`text-lg font-semibold ${t1}`}>{t('empty.title', lang)}</div>
              <p className={`max-w-md text-sm ${mt}`}>{t('empty.body', lang)}</p>
              <div className="flex gap-2">
                <button type="button" className={btnPrimary} onClick={() => fileInputRef.current?.click()}>{t('toolbar.import', lang)}</button>
                <button type="button" className={btnGhost} onClick={loadDemo}>{t('toolbar.loadDemo', lang)}</button>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Tabs (hidden in merge view) */}
              {!settings.mergeFiles && dataSets.length > 1 && (
                <div className={`flex gap-1 overflow-x-auto border-b px-4 py-1.5 themed-scroll ${bdr} ${dark ? 'bg-slate-950/40' : 'bg-white'}`}>
                  {dataSets.map((ds, i) => (
                    <button
                      key={`${ds.fileName}-${i}`}
                      type="button"
                      onClick={() => setActiveTab(i)}
                      className={`shrink-0 rounded-lg px-3 py-1 text-xs font-medium transition ${
                        i === activeTab
                          ? 'bg-emerald-500 text-white'
                          : dark
                            ? 'text-slate-400 hover:bg-slate-800'
                            : 'text-slate-500 hover:bg-slate-100'
                      }`}
                    >
                      {ds.fileName}
                    </button>
                  ))}
                </div>
              )}

              {hasActiveFilters && !settings.mergeFiles && (
                <div className="flex shrink-0 items-center gap-2 border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-xs text-blue-700 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-400">
                  <span className="font-semibold">
                    {t('filters.showing', lang)
                      .replace('{shown}', String(isolatedTable.rows.length))
                      .replace('{total}', String(isolatedTable.totalBeforeFilter))}
                  </span>
                  <span>
                    {t('filters.filteredOut', lang).replace(
                      '{n}',
                      String(isolatedTable.totalBeforeFilter - isolatedTable.rows.length),
                    )}
                  </span>
                </div>
              )}

              <div className="table-container relative min-h-0 flex-1 overflow-auto">
                {settings.mergeFiles ? (
                  /* ── MERGE VIEW: grid rows with dual-axis sticky banners ── */
                  <div className="w-max min-w-full space-y-12">
                    {dataSets.map((dataset, fileIdx) => {
                      const { headers, rows } = getFileHeadersAndRows(dataset.data);
                      const dataRows = settings.firstRowIsHeader ? dataset.data.slice(1) : dataset.data;
                      const getColType = (i: number) => getColumnType(i, dataRows);
                      const sorted = applySortToRows(applyFilters(rows, columnFilters, getColType), dataRows);
                      return (
                        <div key={`${dataset.fileName}-${fileIdx}`} className="relative flex w-full flex-col border-b border-slate-200 bg-white last:border-none dark:border-slate-800 dark:bg-slate-950">
                          <div className={`${settings.stickyHeaders ? 'sticky top-0 z-30' : ''} -mb-px flex flex-col bg-white dark:bg-slate-950`}>
                            <div className="relative h-8 w-max min-w-full select-none border-b border-blue-200 bg-blue-50 py-1.5 dark:border-blue-900/50 dark:bg-blue-950">
                              <span className="sticky left-0 z-10 bg-blue-50 px-4 py-1 text-xs font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-400">
                                FILE [{fileIdx + 1}/{dataSets.length}]: {dataset.fileName}
                                {hasActiveFilters && <span className="ml-2 text-blue-500">({sorted.length}/{rows.length} rows)</span>}
                              </span>
                            </div>
                            <div className="flex border-b border-slate-300 bg-slate-100 pt-[9px] text-sm font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                              {headers.map((header, i) => (
                                <div
                                  key={i}
                                  className={`flex w-[180px] shrink-0 items-center justify-between gap-1 bg-slate-100 px-4 py-2 dark:bg-slate-800 ${
                                    settings.firstColIsHeader && i === 0 ? 'sticky left-0 z-[35] border-r border-slate-300 font-bold dark:border-slate-700' : ''
                                  }`}
                                >
                                  <ColumnHeader
                                    header={header}
                                    colIndex={i}
                                    sortState={sortState}
                                    colType={getColType(i)}
                                    isEditing={editingHeaderKey === `${fileIdx}-${i}`}
                                    editValue={editHeaderValue}
                                    filterValue={columnFilters[i] || ''}
                                    onEditChange={setEditHeaderValue}
                                    onEditStart={() => startEditingHeader(fileIdx, i, header)}
                                    onEditSave={() => saveHeaderName(i)}
                                    onEditCancel={cancelEditingHeader}
                                    onSort={handleSort}
                                    onTypeChange={handleTypeChange}
                                    onFilterChange={handleFilterChange}
                                    isMergeView
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                          <div className="flex flex-col divide-y divide-slate-200 text-sm dark:divide-slate-800">
                            {sorted.map((row, ri) => (
                              <div key={ri} className="flex transition-colors hover:bg-slate-50/50 dark:hover:bg-slate-900/50">
                                {headers.map((_, ci) => (
                                  <div
                                    key={ci}
                                    className={`w-[180px] shrink-0 truncate px-4 py-2 text-slate-800 dark:text-slate-300 ${
                                      settings.firstColIsHeader && ci === 0
                                        ? 'sticky left-0 z-10 border-r border-slate-200 bg-white font-medium dark:border-slate-800 dark:bg-slate-950'
                                        : ''
                                    }`}
                                  >
                                    {row[ci] || ''}
                                  </div>
                                ))}
                              </div>
                            ))}
                            {sorted.length === 0 && (
                              <div className="w-full px-4 py-8 text-center text-slate-500">
                                {hasActiveFilters ? t('table.noMatch', lang) : t('table.noData', lang)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  /* ── TAB VIEW: a real <table> ── */
                  <table className="w-full whitespace-nowrap border-collapse text-left text-sm">
                    <thead>
                      <tr className="text-slate-700 dark:text-slate-300">
                        {isolatedTable.headers.map((header, i) => (
                          <th
                            key={i}
                            className={`relative border-b border-slate-300 bg-slate-100 px-4 py-2 outline-1 outline-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:outline-slate-800 ${
                              settings.stickyHeaders ? 'sticky top-0 z-20' : ''
                            } ${settings.firstColIsHeader && i === 0 ? 'sticky left-0 border-r border-slate-300 dark:border-slate-700' : ''} ${
                              settings.stickyHeaders && settings.firstColIsHeader && i === 0 ? 'z-30' : ''
                            }`}
                          >
                            <ColumnHeader
                              header={header}
                              colIndex={i}
                              sortState={sortState}
                              colType={activeColumnTypes[i] || 'string'}
                              isEditing={editingHeaderKey === `${activeTab}-${i}`}
                              editValue={editHeaderValue}
                              filterValue={columnFilters[i] || ''}
                              onEditChange={setEditHeaderValue}
                              onEditStart={() => startEditingHeader(activeTab, i, header)}
                              onEditSave={() => saveHeaderName(i)}
                              onEditCancel={cancelEditingHeader}
                              onSort={handleSort}
                              onTypeChange={handleTypeChange}
                              onFilterChange={handleFilterChange}
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {isolatedTable.rows.map((row, ri) => (
                        <tr key={ri} className="transition-colors hover:bg-slate-50/50 dark:hover:bg-slate-900/50">
                          {isolatedTable.headers.map((_, ci) => (
                            <td
                              key={ci}
                              className={`px-4 py-2 text-slate-800 dark:text-slate-300 ${
                                settings.firstColIsHeader && ci === 0
                                  ? 'sticky left-0 z-10 border-r border-slate-200 bg-white font-medium dark:border-slate-800 dark:bg-slate-950'
                                  : ''
                              }`}
                            >
                              {row[ci] || ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {isolatedTable.rows.length === 0 && (
                        <tr>
                          <td colSpan={isolatedTable.headers.length || 1} className="px-4 py-8 text-center text-slate-500">
                            {hasActiveFilters ? t('table.noMatch', lang) : t('table.noData', lang)}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </Fragment>
  );
};

// ============================================================================
// BOOTSTRAP
// ============================================================================

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} else {
  console.error('Failed to find root element.');
}

export default App;
