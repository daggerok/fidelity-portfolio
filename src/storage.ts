// storage.ts
/**
 * ============================================================================
 * AGENTIC AI ENFORCED SPECIFICATION & GUIDELINES (CRITICAL)
 * ============================================================================
 * 1. PERSIST ALL COMMENTS: Under no circumstances should ANY code comments,
 *    system design docs, or type descriptors be removed or truncated.
 * 2. AGENT READ-WRITE RULE: If a future deployment or agent updates the code,
 *    this header section and related documentation blocks MUST be kept accurate,
 *    expanded, and dynamically synchronized with the feature upgrades.
 * 3. INTERFACE PARITY IS LAW: `LocalSettingsRepository` / `GoogleSettingsRepository`
 *    and `LocalDataRepository` / `GoogleDataRepository` implement the *identical*
 *    `Repository<T>` contract. Callers must never branch on the backend. If you
 *    add a method, add it to BOTH implementations of BOTH repositories.
 * ============================================================================
 *
 * ============================================================================
 * MODULE: Storage layer — localStorage & Google Sheets behind one interface
 * ============================================================================
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FIVE INVARIANTS (these are the product requirements, encoded)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * I1. localStorage is the ALWAYS-ON backend for SETTINGS.
 *     Whatever the user configures — Google connected or not — settings are
 *     written to localStorage. Google is *additive*, never a replacement.
 *     Rationale: the app must boot correctly offline, before any OAuth, and
 *     the Google configuration itself (client id, document ids) lives in
 *     settings — storing it *only* in Google would be a bootstrap paradox.
 *
 * I2. DATA in localStorage is BEST-EFFORT and BUDGETED.
 *     Data is persisted locally only while it fits inside `DATA_BUDGET_BYTES`.
 *     Beyond that, the write is refused (`'over-budget'`) or, if the browser
 *     rejects it first, rolled back (`'quota'`). The app keeps working — the
 *     rows simply live in memory / in Google instead.
 *
 * I3. DATA MUST NEVER EVICT SETTINGS.
 *     Every data write goes through `guardedWrite()`, which (a) refuses
 *     oversized payloads before touching the store, and (b) on QuotaExceeded
 *     removes the *data* key and then re-asserts the settings snapshot it took
 *     before the attempt. A full disk can cost you rows; it can never cost you
 *     your configuration.
 *
 * I4. SYNC IS ONE-WAY: GOOGLE → LOCAL.
 *     `syncDataFromGoogleToLocal()` mirrors sheet rows into localStorage when
 *     leaving Google. There is deliberately NO local→google data sync helper:
 *     a stale/partial local cache must never clobber the remote database.
 *     (Local rows still *reach* Google, but only through explicit user-driven
 *     writes while Google is the active backend — never as a bulk overwrite
 *     triggered by a mode switch.)
 *
 * I5. ON CLOSE, SETTINGS GO TO BOTH BACKENDS.
 *     `createShutdownFlusher()` writes settings to localStorage synchronously
 *     (guaranteed) and to Google via `keepalive` fetch (best effort). Data is
 *     NOT flushed on unload: it is unbounded, would exceed the ~64KB keepalive
 *     ceiling, and I3 forbids risking the settings write on its behalf.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SHEET ENCODINGS
 * ────────────────────────────────────────────────────────────────────────────
 * Settings tab (`app:settings`) — 2 columns, human-editable:
 *     | key            | value (JSON)        |
 *     | theme          | "dark"              |
 *     | columnFilters  | {"0":">10"}         |
 *
 * Data tab (`app:data`) — long format so N files share one grid:
 *     | file      | c1     | c2    | ... |
 *     | a.csv     | Ticker | Price |     |
 *     | a.csv     | AAPL   | 100   |     |
 *     | b.csv     | X      | 1     |     |
 * Row order is preserved; files are regrouped in first-seen order on read.
 * ============================================================================
 */

import {
  DATA_TAB,
  SETTINGS_TAB,
  columnLetter,
  errorMessage,
  type SheetsClient,
} from './google-sheets';

// ============================================================================
// SHARED TYPES
// ============================================================================

/** Which physical backend a repository talks to. */
export type BackendKind = 'local' | 'google';

/** Why a write did not fully succeed. `null` on success. */
export type SaveFailure =
  | 'over-budget' // payload exceeds the configured local budget — refused up-front
  | 'quota' // browser rejected the write; data key rolled back, settings re-asserted
  | 'unavailable' // backend not reachable (no token / no document configured)
  | 'error'; // anything else; see `message`

export type SaveResult = {
  ok: boolean;
  failure: SaveFailure | null;
  /** Serialized byte size we attempted to write (0 when refused before serializing). */
  bytes: number;
  /** Human-readable detail for toasts/debug panel. */
  message?: string;
};

export const SAVE_OK = (bytes: number): SaveResult => ({ ok: true, failure: null, bytes });

/**
 * THE contract. Identical for settings and data, identical for local and Google.
 * Everything in the UI is written against this type and only this type.
 */
export interface Repository<T> {
  /** Stable identity for debug output, e.g. `local:settings` / `google:data`. */
  readonly id: string;
  readonly kind: BackendKind;
  /** False when the backend is configured but currently unusable (no token…). */
  isReady(): boolean;
  /** Returns `null` when nothing has ever been stored. */
  load(): Promise<T | null>;
  save(value: T): Promise<SaveResult>;
  clear(): Promise<void>;
  /** Bytes currently occupied, or `null` when the backend cannot report it. */
  usage(): Promise<number | null>;
}

/** Free-form settings bag. The app owns the schema; the repository does not. */
export type SettingsBag = Record<string, unknown>;

/** One imported CSV file. */
export type DataSet = { fileName: string; data: string[][] };

export type SettingsRepository = Repository<SettingsBag>;
export type DataRepository = Repository<DataSet[]>;

// ============================================================================
// CONSTANTS
// ============================================================================

/** localStorage keys. Settings key is sacred (see I3). */
export const LS_SETTINGS_KEY = 'appTemplate.settings.v1';
export const LS_DATA_KEY = 'appTemplate.data.v1';

/**
 * Local data budget. Browsers give an origin ~5MB of localStorage; we reserve
 * the remainder for settings and future keys. Tunable from the Settings panel.
 */
export const DATA_BUDGET_MB = 4;
export const DATA_BUDGET_BYTES = DATA_BUDGET_MB * 1024 * 1024;

/** Settings are tiny by construction; this ceiling only catches runaway bugs. */
export const SETTINGS_BUDGET_BYTES = 512 * 1024;

// ============================================================================
// BYTE HELPERS
// ============================================================================

/** UTF-8 byte length of a string (localStorage quota is counted in UTF-16 by
 *  some engines, but bytes are the portable, conservative approximation). */
export function byteSize(text: string): number {
  if (typeof Blob !== 'undefined') return new Blob([text]).size;
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return text.length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Safe JSON.parse with a fallback. */
export function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** True for the various shapes browsers use to signal "storage is full". */
export function isQuotaError(e: unknown): boolean {
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
    return (
      e.name === 'QuotaExceededError' ||
      e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 ||
      e.code === 1014
    );
  }
  const name = (e as { name?: string } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

// ============================================================================
// STORAGE PORT (so tests can run without a DOM)
// ============================================================================

/** The slice of the Web Storage API we depend on. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory fallback used in SSR/test contexts and when localStorage throws. */
export function createMemoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** Returns real localStorage when usable, otherwise a memory shim. */
export function resolveStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* Safari private mode and friends */
  }
  return createMemoryStorage();
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * I3 ENFORCEMENT POINT
 * ────────────────────────────────────────────────────────────────────────────
 * Writes `key` while guaranteeing `protectedKey` survives.
 *
 * 1. Snapshot the protected value BEFORE touching anything.
 * 2. Refuse up-front if the payload exceeds `budgetBytes`.
 * 3. On QuotaExceeded: delete the key we were writing, then restore the
 *    protected snapshot if it went missing during the failed attempt.
 */
export function guardedWrite(
  storage: StorageLike,
  key: string,
  payload: string,
  budgetBytes: number,
  protectedKey?: string,
): SaveResult {
  const bytes = byteSize(payload);
  if (bytes > budgetBytes) {
    return {
      ok: false,
      failure: 'over-budget',
      bytes,
      message: `${formatBytes(bytes)} exceeds the ${formatBytes(budgetBytes)} budget for "${key}".`,
    };
  }
  const snapshot = protectedKey ? storage.getItem(protectedKey) : null;
  try {
    storage.setItem(key, payload);
    return SAVE_OK(bytes);
  } catch (e) {
    if (isQuotaError(e)) {
      try {
        storage.removeItem(key);
      } catch {
        /* ignore */
      }
      if (protectedKey && snapshot !== null && storage.getItem(protectedKey) === null) {
        try {
          storage.setItem(protectedKey, snapshot);
        } catch {
          /* nothing else we can do */
        }
      }
      return {
        ok: false,
        failure: 'quota',
        bytes,
        message: `Browser storage is full (${formatBytes(bytes)} requested). Rows were not saved locally; settings were preserved.`,
      };
    }
    return { ok: false, failure: 'error', bytes, message: errorMessage(e) };
  }
}

// ============================================================================
// LOCAL REPOSITORIES
// ============================================================================

export function createLocalSettingsRepository(
  storage: StorageLike = resolveStorage(),
  key: string = LS_SETTINGS_KEY,
): SettingsRepository {
  return {
    id: 'local:settings',
    kind: 'local',
    isReady: () => true,
    async load() {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = parseJson<SettingsBag | null>(raw, null);
      return parsed && typeof parsed === 'object' ? parsed : null;
    },
    async save(value) {
      // I1: settings always win — protect nothing, they ARE the protected thing.
      return guardedWrite(storage, key, JSON.stringify(value), SETTINGS_BUDGET_BYTES);
    },
    async clear() {
      storage.removeItem(key);
    },
    async usage() {
      return byteSize(storage.getItem(key) ?? '');
    },
  };
}

export function createLocalDataRepository(
  storage: StorageLike = resolveStorage(),
  key: string = LS_DATA_KEY,
  budgetBytes: number = DATA_BUDGET_BYTES,
  settingsKey: string = LS_SETTINGS_KEY,
): DataRepository {
  return {
    id: 'local:data',
    kind: 'local',
    isReady: () => true,
    async load() {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = parseJson<unknown>(raw, null);
      if (!Array.isArray(parsed)) return null;
      const sets = parsed.filter(
        (d): d is DataSet =>
          !!d && typeof d === 'object' && typeof (d as DataSet).fileName === 'string' && Array.isArray((d as DataSet).data),
      );
      return sets.length > 0 ? sets : null;
    },
    async save(value) {
      // I2 + I3: budgeted, and settings are protected across the attempt.
      return guardedWrite(storage, key, JSON.stringify(value), budgetBytes, settingsKey);
    },
    async clear() {
      storage.removeItem(key);
    },
    async usage() {
      return byteSize(storage.getItem(key) ?? '');
    },
  };
}

// ============================================================================
// GOOGLE SHEETS ENCODINGS (pure — unit tested)
// ============================================================================

export const SETTINGS_SHEET_HEADER = ['key', 'value'] as const;
export const DATA_SHEET_FILE_COLUMN = 'file';

/** Settings bag → rows for `app:settings`. */
export function settingsToRows(bag: SettingsBag): string[][] {
  const rows: string[][] = [Array.from(SETTINGS_SHEET_HEADER)];
  for (const [k, v] of Object.entries(bag)) rows.push([k, JSON.stringify(v ?? null)]);
  return rows;
}

/** Rows from `app:settings` → settings bag. Unparseable values fall back to raw text. */
export function rowsToSettings(rows: string[][]): SettingsBag {
  const bag: SettingsBag = {};
  for (const row of rows) {
    const k = (row?.[0] ?? '').trim();
    if (!k || k === SETTINGS_SHEET_HEADER[0]) continue;
    const raw = row?.[1] ?? '';
    bag[k] = raw === '' ? null : parseJson<unknown>(raw, raw);
  }
  return bag;
}

/** DataSet[] → long-format rows for `app:data`. */
export function dataSetsToRows(dataSets: DataSet[]): string[][] {
  const width = Math.max(
    1,
    ...dataSets.flatMap((ds) => ds.data.map((r) => r.length)),
  );
  const header = [DATA_SHEET_FILE_COLUMN, ...Array.from({ length: width }, (_, i) => `c${i + 1}`)];
  const rows: string[][] = [header];
  for (const ds of dataSets) {
    for (const row of ds.data) {
      const padded = Array.from({ length: width }, (_, i) => row[i] ?? '');
      rows.push([ds.fileName, ...padded]);
    }
  }
  return rows;
}

/** Long-format rows → DataSet[], regrouped in first-seen file order. */
export function rowsToDataSets(rows: string[][]): DataSet[] {
  if (rows.length === 0) return [];
  const body = (rows[0]?.[0] ?? '').trim() === DATA_SHEET_FILE_COLUMN ? rows.slice(1) : rows;
  const order: string[] = [];
  const grouped = new Map<string, string[][]>();
  for (const row of body) {
    if (!row || row.length === 0) continue;
    const fileName = (row[0] ?? '').trim() || 'sheet.csv';
    const cells = row.slice(1);
    // Drop trailing empties introduced by the fixed-width grid.
    let end = cells.length;
    while (end > 0 && (cells[end - 1] ?? '') === '') end -= 1;
    const trimmed = cells.slice(0, end);
    if (trimmed.length === 0) continue;
    if (!grouped.has(fileName)) {
      grouped.set(fileName, []);
      order.push(fileName);
    }
    grouped.get(fileName)!.push(trimmed);
  }
  return order.map((fileName) => ({ fileName, data: grouped.get(fileName) ?? [] }));
}

/** Widest row in a grid — used to size the A1 range we overwrite. */
export function gridWidth(rows: string[][]): number {
  return Math.max(1, ...rows.map((r) => r.length));
}

/** `A1:C10` for a grid of 3×10. */
export function gridRange(rows: string[][]): string {
  return `A1:${columnLetter(gridWidth(rows) - 1)}${Math.max(1, rows.length)}`;
}

// ============================================================================
// GOOGLE REPOSITORIES
// ============================================================================

export type GoogleRepositoryDeps = {
  /** Lazily resolved so the repository survives token refreshes. */
  client: () => SheetsClient | null;
  /** Spreadsheet ID (already normalized) — settings and data may differ. */
  documentId: () => string;
  tab: string;
};

/** Shared plumbing for both Google repositories. */
function googleReady(deps: GoogleRepositoryDeps): boolean {
  return Boolean(deps.client() && deps.documentId());
}

function requireGoogle(deps: GoogleRepositoryDeps): { client: SheetsClient; documentId: string } {
  const client = deps.client();
  const documentId = deps.documentId();
  if (!client) throw new Error('Google is not connected');
  if (!documentId) throw new Error('No spreadsheet configured');
  return { client, documentId };
}

export function createGoogleSettingsRepository(deps: GoogleRepositoryDeps): SettingsRepository {
  return {
    id: 'google:settings',
    kind: 'google',
    isReady: () => googleReady(deps),
    async load() {
      const { client, documentId } = requireGoogle(deps);
      const rows = await client.readValues(documentId, deps.tab, 'A1:B');
      if (rows.length === 0) return null;
      const bag = rowsToSettings(rows);
      return Object.keys(bag).length > 0 ? bag : null;
    },
    async save(value) {
      if (!googleReady(deps)) {
        return { ok: false, failure: 'unavailable', bytes: 0, message: 'Google is not connected' };
      }
      const { client, documentId } = requireGoogle(deps);
      const rows = settingsToRows(value);
      const bytes = byteSize(JSON.stringify(rows));
      try {
        await client.ensureTab(documentId, deps.tab);
        await client.clearValues(documentId, deps.tab, 'A1:B');
        await client.writeValues(documentId, deps.tab, gridRange(rows), rows);
        return SAVE_OK(bytes);
      } catch (e) {
        return { ok: false, failure: 'error', bytes, message: errorMessage(e) };
      }
    },
    async clear() {
      const { client, documentId } = requireGoogle(deps);
      await client.clearValues(documentId, deps.tab, 'A1:B');
    },
    async usage() {
      return null; // Google does not bill us per byte here.
    },
  };
}

export function createGoogleDataRepository(deps: GoogleRepositoryDeps): DataRepository {
  return {
    id: 'google:data',
    kind: 'google',
    isReady: () => googleReady(deps),
    async load() {
      const { client, documentId } = requireGoogle(deps);
      const rows = await client.readValues(documentId, deps.tab, 'A1:ZZ');
      const sets = rowsToDataSets(rows);
      return sets.length > 0 ? sets : null;
    },
    async save(value) {
      if (!googleReady(deps)) {
        return { ok: false, failure: 'unavailable', bytes: 0, message: 'Google is not connected' };
      }
      const { client, documentId } = requireGoogle(deps);
      const rows = dataSetsToRows(value);
      const bytes = byteSize(JSON.stringify(rows));
      try {
        await client.ensureTab(documentId, deps.tab);
        await client.clearValues(documentId, deps.tab, 'A1:ZZ');
        if (rows.length > 0) {
          await client.writeValues(documentId, deps.tab, gridRange(rows), rows);
        }
        return SAVE_OK(bytes);
      } catch (e) {
        return { ok: false, failure: 'error', bytes, message: errorMessage(e) };
      }
    },
    async clear() {
      const { client, documentId } = requireGoogle(deps);
      await client.clearValues(documentId, deps.tab, 'A1:ZZ');
    },
    async usage() {
      return null;
    },
  };
}

// ============================================================================
// I4 — ONE-WAY SYNC (GOOGLE → LOCAL)
// ============================================================================

export type SyncOutcome = {
  synced: boolean;
  rows: number;
  files: number;
  /** Present when the local mirror could not hold everything (I2). */
  save?: SaveResult;
  message?: string;
};

/**
 * Pulls the Google data sheet into the local mirror. Invoked when the user
 * switches Google → localStorage so that the demo/offline mode starts from the
 * freshest known state.
 *
 * DIRECTIONALITY IS INTENTIONAL AND MUST NOT BE GENERALIZED: there is no
 * `syncDataFromLocalToGoogle()`. A local cache that was truncated by the byte
 * budget would silently destroy remote rows if pushed back up.
 */
export async function syncDataFromGoogleToLocal(
  googleData: DataRepository,
  localData: DataRepository,
): Promise<SyncOutcome> {
  if (!googleData.isReady()) return { synced: false, rows: 0, files: 0, message: 'Google is not connected' };
  try {
    const remote = await googleData.load();
    if (!remote || remote.length === 0) {
      return { synced: false, rows: 0, files: 0, message: 'Nothing to sync — the Google data sheet is empty' };
    }
    const rows = remote.reduce((sum, ds) => sum + ds.data.length, 0);
    const save = await localData.save(remote);
    return {
      synced: save.ok,
      rows,
      files: remote.length,
      save,
      message: save.ok
        ? `Mirrored ${rows} row(s) from ${remote.length} file(s) into localStorage`
        : save.message,
    };
  } catch (e) {
    return { synced: false, rows: 0, files: 0, message: errorMessage(e) };
  }
}

// ============================================================================
// I5 — SHUTDOWN FLUSH
// ============================================================================

export type ShutdownFlusherDeps = {
  /** Latest settings snapshot. Read at flush time, never cached earlier. */
  getSettings: () => SettingsBag;
  localSettings: SettingsRepository;
  /** Sheets client + settings document, or `null` when Google is not in use. */
  googleSettings: () => SettingsRepository | null;
  /** Direct keepalive writer; see the `keepalive` note in google-sheets.ts. */
  keepaliveWrite?: (rows: string[][]) => void;
  log?: (...args: unknown[]) => void;
};

/**
 * Registers `pagehide` + `visibilitychange` handlers that persist settings to
 * BOTH backends when the tab goes away.
 *
 * WHY NOT `beforeunload`: it is unreliable on mobile Safari and is skipped by
 * the bfcache. `pagehide` fires in both the unload and the bfcache path, and
 * `visibilitychange → hidden` is the only signal guaranteed on iOS app switch.
 *
 * WHY SETTINGS ONLY: see I5. Data is unbounded and would blow the keepalive
 * limit, jeopardizing the settings write that shares the same teardown window.
 *
 * @returns an unsubscribe function.
 */
export function createShutdownFlusher(deps: ShutdownFlusherDeps): () => void {
  const log = deps.log ?? (() => undefined);
  let flushing = false;

  const flush = () => {
    if (flushing) return;
    flushing = true;
    // Give a later hidden→visible→hidden cycle another chance to flush.
    setTimeout(() => {
      flushing = false;
    }, 0);

    const settings = deps.getSettings();

    // (a) localStorage — synchronous and therefore guaranteed. I1.
    try {
      void deps.localSettings.save(settings);
      log('shutdown: settings written to localStorage');
    } catch (e) {
      log('shutdown: local settings write failed', e);
    }

    // (b) Google — best effort via keepalive. Never allowed to throw.
    try {
      const remote = deps.googleSettings();
      if (remote?.isReady() && deps.keepaliveWrite) {
        deps.keepaliveWrite(settingsToRows(settings));
        log('shutdown: settings keepalive-flushed to Google');
      }
    } catch (e) {
      log('shutdown: google settings flush failed', e);
    }
  };

  const onPageHide = () => flush();
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// ============================================================================
// MERGE POLICY
// ============================================================================

/**
 * Merges a remote settings bag over the local one at boot.
 *
 * Precedence rule: REMOTE WINS for keys it defines, EXCEPT for the keys listed
 * in `localOnlyKeys`. Those are device-scoped — the Google client id and the
 * document ids must keep pointing at whatever *this* browser was configured
 * with, otherwise a shared spreadsheet would hijack another machine's wiring
 * (and could lock the user out of the very document holding the settings).
 */
export const LOCAL_ONLY_SETTING_KEYS = [
  'googleClientId',
  'settingsDocumentId',
  'dataDocumentId',
  'backend',
] as const;

export function mergeSettings(
  local: SettingsBag | null,
  remote: SettingsBag | null,
  localOnlyKeys: readonly string[] = LOCAL_ONLY_SETTING_KEYS,
): SettingsBag {
  const base: SettingsBag = { ...(local ?? {}) };
  if (!remote) return base;
  for (const [k, v] of Object.entries(remote)) {
    if (localOnlyKeys.includes(k)) continue;
    base[k] = v;
  }
  return base;
}

/** Convenience for the debug panel. */
export const SHEET_TABS = { settings: SETTINGS_TAB, data: DATA_TAB } as const;
