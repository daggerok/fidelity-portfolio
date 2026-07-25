// storage.test.ts
/**
 * ============================================================================
 * TESTS: the five storage invariants
 * ============================================================================
 * These tests exist to make the product requirements executable. Each block
 * maps 1:1 onto an invariant documented at the top of `storage.ts`:
 *
 *   I1  settings always persist to localStorage
 *   I2  data is budgeted locally
 *   I3  data can never evict settings
 *   I4  sync is one-way: Google → local
 *   I5  on close, settings flush to BOTH backends
 * ============================================================================
 */

import { describe, expect, test } from 'bun:test';

import {
  DATA_BUDGET_BYTES,
  LS_DATA_KEY,
  LS_SETTINGS_KEY,
  byteSize,
  createGoogleDataRepository,
  createGoogleSettingsRepository,
  createLocalDataRepository,
  createLocalSettingsRepository,
  createMemoryStorage,
  createShutdownFlusher,
  dataSetsToRows,
  formatBytes,
  gridRange,
  guardedWrite,
  mergeSettings,
  rowsToDataSets,
  rowsToSettings,
  settingsToRows,
  syncDataFromGoogleToLocal,
  type DataSet,
  type SettingsBag,
  type StorageLike,
} from './storage';

// ============================================================================
// HELPERS
// ============================================================================

/** A storage that starts refusing writes once `limit` bytes are held. */
function createQuotaStorage(limit: number, seed: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(seed));
  const used = () => [...map.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      const projected = used() - (map.get(k)?.length ?? 0) - (map.has(k) ? k.length : 0) + k.length + v.length;
      if (projected > limit) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
  };
}

/**
 * Minimal DOM shim.
 * `bun test` runs head-less, but `createShutdownFlusher` legitimately binds to
 * `window`/`document`. Rather than weakening the production API with an
 * injectable event target, we install a tiny EventTarget-backed stand-in for
 * the duration of the I5 tests.
 */
function installFakeDom(): () => void {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const prevWindow = g.window;
  const prevDocument = g.document;

  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();

  g.window = {
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    dispatchEvent: windowTarget.dispatchEvent.bind(windowTarget),
  };
  g.document = {
    visibilityState: 'visible',
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    dispatchEvent: documentTarget.dispatchEvent.bind(documentTarget),
  };

  return () => {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadDocument) g.document = prevDocument;
    else delete g.document;
  };
}

const sampleDataSets: DataSet[] = [
  { fileName: 'a.csv', data: [['Ticker', 'Price'], ['AAPL', '232.10'], ['MSFT', '429.03']] },
  { fileName: 'b.csv', data: [['X'], ['1']] },
];

/** Minimal in-memory stand-in for the Sheets client used by the repositories. */
function createFakeSheetsClient(initial: Record<string, string[][]> = {}) {
  const tabs = new Map<string, string[][]>(Object.entries(initial));
  const calls: string[] = [];
  const client = {
    calls,
    tabs,
    async userEmail() {
      return 'tester@example.com';
    },
    async getSpreadsheet() {
      return { spreadsheetId: 'doc' };
    },
    async createSpreadsheet() {
      return { spreadsheetId: 'doc', spreadsheetUrl: 'https://example.test/doc' };
    },
    async ensureTab(_doc: string, tab: string) {
      calls.push(`ensureTab:${tab}`);
      if (!tabs.has(tab)) tabs.set(tab, []);
    },
    async readValues(_doc: string, tab: string) {
      calls.push(`read:${tab}`);
      return tabs.get(tab) ?? [];
    },
    async writeValues(_doc: string, tab: string, _cells: string, values: string[][], keepalive = false) {
      calls.push(`write:${tab}${keepalive ? ':keepalive' : ''}`);
      tabs.set(tab, values);
    },
    async clearValues(_doc: string, tab: string) {
      calls.push(`clear:${tab}`);
      tabs.set(tab, []);
    },
  };
  return client as unknown as import('./google-sheets').SheetsClient & { calls: string[]; tabs: Map<string, string[][]> };
}

// ============================================================================
// I1 — SETTINGS ALWAYS PERSIST LOCALLY
// ============================================================================

describe('I1 · localStorage always keeps the app settings', () => {
  test('saves and reloads a settings bag', async () => {
    const storage = createMemoryStorage();
    const repo = createLocalSettingsRepository(storage);
    const bag: SettingsBag = { theme: 'dark', lang: 'ru', backend: 'google' };

    const result = await repo.save(bag);
    expect(result.ok).toBe(true);
    expect(await repo.load()).toEqual(bag);
  });

  test('returns null (not a throw) when nothing was ever stored', async () => {
    expect(await createLocalSettingsRepository(createMemoryStorage()).load()).toBeNull();
  });

  test('survives corrupted JSON without losing the app', async () => {
    const storage = createMemoryStorage({ [LS_SETTINGS_KEY]: '{ not json' });
    expect(await createLocalSettingsRepository(storage).load()).toBeNull();
  });

  test('settings are written even while the backend is Google', async () => {
    // The app writes settings locally on every change regardless of backend;
    // this asserts the repository imposes no backend condition of its own.
    const storage = createMemoryStorage();
    const repo = createLocalSettingsRepository(storage);
    await repo.save({ backend: 'google', theme: 'dark' });
    expect(JSON.parse(storage.getItem(LS_SETTINGS_KEY) as string).backend).toBe('google');
  });
});

// ============================================================================
// I2 — DATA IS BUDGETED
// ============================================================================

describe('I2 · local data storage is best-effort and budgeted', () => {
  test('stores datasets that fit', async () => {
    const storage = createMemoryStorage();
    const repo = createLocalDataRepository(storage);
    const res = await repo.save(sampleDataSets);
    expect(res.ok).toBe(true);
    expect(await repo.load()).toEqual(sampleDataSets);
  });

  test('refuses oversized payloads up-front with over-budget', async () => {
    const storage = createMemoryStorage();
    const tinyBudget = 128;
    const repo = createLocalDataRepository(storage, LS_DATA_KEY, tinyBudget);
    const big: DataSet[] = [{ fileName: 'big.csv', data: Array.from({ length: 200 }, (_, i) => [`row${i}`, 'x'.repeat(40)]) }];

    const res = await repo.save(big);
    expect(res.ok).toBe(false);
    expect(res.failure).toBe('over-budget');
    // Nothing was written, so nothing can be read back.
    expect(storage.getItem(LS_DATA_KEY)).toBeNull();
  });

  test('the default budget is 4MB', () => {
    expect(DATA_BUDGET_BYTES).toBe(4 * 1024 * 1024);
  });

  test('reports usage in bytes', async () => {
    const storage = createMemoryStorage();
    const repo = createLocalDataRepository(storage);
    await repo.save(sampleDataSets);
    const usage = await repo.usage();
    expect(usage).toBeGreaterThan(0);
    expect(usage).toBe(byteSize(storage.getItem(LS_DATA_KEY) as string));
  });

  test('formatBytes renders human units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});

// ============================================================================
// I3 — DATA MUST NEVER EVICT SETTINGS
// ============================================================================

describe('I3 · a data write can never destroy the settings', () => {
  test('guardedWrite restores the protected key after a quota failure', () => {
    const settingsPayload = JSON.stringify({ theme: 'dark' });
    const storage = createQuotaStorage(200, { [LS_SETTINGS_KEY]: settingsPayload });

    const res = guardedWrite(storage, LS_DATA_KEY, 'x'.repeat(5000), 1024 * 1024, LS_SETTINGS_KEY);

    expect(res.ok).toBe(false);
    expect(res.failure).toBe('quota');
    // THE critical assertion: configuration survived a failed data write.
    expect(storage.getItem(LS_SETTINGS_KEY)).toBe(settingsPayload);
    expect(storage.getItem(LS_DATA_KEY)).toBeNull();
  });

  test('an over-budget data save leaves existing settings untouched', async () => {
    const storage = createMemoryStorage();
    const settingsRepo = createLocalSettingsRepository(storage);
    await settingsRepo.save({ theme: 'dark', googleClientId: 'abc.apps.googleusercontent.com' });

    const dataRepo = createLocalDataRepository(storage, LS_DATA_KEY, 64);
    const res = await dataRepo.save(sampleDataSets);

    expect(res.ok).toBe(false);
    expect(await settingsRepo.load()).toEqual({ theme: 'dark', googleClientId: 'abc.apps.googleusercontent.com' });
  });

  test('a quota failure during a real data save keeps settings readable', async () => {
    const settingsPayload = JSON.stringify({ theme: 'light', backend: 'local' });
    const storage = createQuotaStorage(300, { [LS_SETTINGS_KEY]: settingsPayload });
    const settingsRepo = createLocalSettingsRepository(storage);
    const dataRepo = createLocalDataRepository(storage, LS_DATA_KEY, 1024 * 1024, LS_SETTINGS_KEY);

    const res = await dataRepo.save([
      { fileName: 'huge.csv', data: Array.from({ length: 100 }, (_, i) => [String(i), 'y'.repeat(50)]) },
    ]);

    expect(res.ok).toBe(false);
    expect(res.failure).toBe('quota');
    expect(await settingsRepo.load()).toEqual({ theme: 'light', backend: 'local' });
  });

  test('settings writes are not budget-limited by the data budget', async () => {
    const storage = createMemoryStorage();
    const repo = createLocalSettingsRepository(storage);
    // A settings bag larger than a tiny data budget still saves fine.
    const res = await repo.save({ note: 'z'.repeat(5000) });
    expect(res.ok).toBe(true);
  });
});

// ============================================================================
// I4 — ONE-WAY SYNC
// ============================================================================

describe('I4 · sync only ever flows Google → localStorage', () => {
  test('mirrors remote rows into the local repository', async () => {
    const remoteRows = dataSetsToRows(sampleDataSets);
    const client = createFakeSheetsClient({ 'app:data': remoteRows });
    const googleData = createGoogleDataRepository({
      client: () => client,
      documentId: () => 'doc',
      tab: 'app:data',
    });
    const storage = createMemoryStorage();
    const localData = createLocalDataRepository(storage);

    const outcome = await syncDataFromGoogleToLocal(googleData, localData);

    expect(outcome.synced).toBe(true);
    expect(outcome.files).toBe(2);
    expect(outcome.rows).toBe(5);
    expect(await localData.load()).toEqual(sampleDataSets);
  });

  test('is a no-op when Google is not connected', async () => {
    const googleData = createGoogleDataRepository({
      client: () => null,
      documentId: () => '',
      tab: 'app:data',
    });
    const localData = createLocalDataRepository(createMemoryStorage());
    await localData.save(sampleDataSets);

    const outcome = await syncDataFromGoogleToLocal(googleData, localData);

    expect(outcome.synced).toBe(false);
    // The pre-existing local cache is left completely alone.
    expect(await localData.load()).toEqual(sampleDataSets);
  });

  test('reports over-budget instead of silently dropping the mirror', async () => {
    const client = createFakeSheetsClient({ 'app:data': dataSetsToRows(sampleDataSets) });
    const googleData = createGoogleDataRepository({ client: () => client, documentId: () => 'doc', tab: 'app:data' });
    const localData = createLocalDataRepository(createMemoryStorage(), LS_DATA_KEY, 32);

    const outcome = await syncDataFromGoogleToLocal(googleData, localData);

    expect(outcome.synced).toBe(false);
    expect(outcome.save?.failure).toBe('over-budget');
  });

  test('no local→google data sync helper is exported', async () => {
    const mod = (await import('./storage')) as Record<string, unknown>;
    const names = Object.keys(mod).filter((k) => /sync/i.test(k));
    expect(names).toEqual(['syncDataFromGoogleToLocal']);
  });
});

// ============================================================================
// I5 — SHUTDOWN FLUSH TO BOTH BACKENDS
// ============================================================================

describe('I5 · closing the tab persists settings to both backends', () => {
  test('writes settings locally AND keepalive-flushes them to Google', () => {
    const restoreDom = installFakeDom();
    const storage = createMemoryStorage();
    const localSettings = createLocalSettingsRepository(storage);
    const client = createFakeSheetsClient();
    const googleSettings = createGoogleSettingsRepository({
      client: () => client,
      documentId: () => 'doc',
      tab: 'app:settings',
    });

    let keepaliveRows: string[][] | null = null;
    const bag: SettingsBag = { theme: 'dark', lang: 'en' };

    const unsubscribe = createShutdownFlusher({
      getSettings: () => bag,
      localSettings,
      googleSettings: () => googleSettings,
      keepaliveWrite: (rows) => {
        keepaliveRows = rows;
      },
    });

    // Simulate the browser tearing the page down.
    window.dispatchEvent(new Event('pagehide'));

    expect(JSON.parse(storage.getItem(LS_SETTINGS_KEY) as string)).toEqual(bag);
    expect(keepaliveRows).not.toBeNull();
    expect(rowsToSettings(keepaliveRows as unknown as string[][])).toEqual(bag);

    unsubscribe();
    restoreDom();
  });

  test('a hidden visibilitychange also triggers the flush', () => {
    const restoreDom = installFakeDom();
    const storage = createMemoryStorage();
    const unsubscribe = createShutdownFlusher({
      getSettings: () => ({ theme: 'dark' }),
      localSettings: createLocalSettingsRepository(storage),
      googleSettings: () => null,
    });

    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));

    expect(JSON.parse(storage.getItem(LS_SETTINGS_KEY) as string)).toEqual({ theme: 'dark' });
    unsubscribe();
    restoreDom();
  });

  test('still writes locally when Google is unavailable', () => {
    const restoreDom = installFakeDom();
    const storage = createMemoryStorage();
    const localSettings = createLocalSettingsRepository(storage);
    let called = false;

    const unsubscribe = createShutdownFlusher({
      getSettings: () => ({ theme: 'light' }),
      localSettings,
      googleSettings: () => null,
      keepaliveWrite: () => {
        called = true;
      },
    });

    window.dispatchEvent(new Event('pagehide'));

    expect(JSON.parse(storage.getItem(LS_SETTINGS_KEY) as string)).toEqual({ theme: 'light' });
    expect(called).toBe(false);
    unsubscribe();
    restoreDom();
  });

  test('unsubscribing detaches the listeners', () => {
    const restoreDom = installFakeDom();
    const storage = createMemoryStorage();
    const unsubscribe = createShutdownFlusher({
      getSettings: () => ({ theme: 'dark' }),
      localSettings: createLocalSettingsRepository(storage),
      googleSettings: () => null,
    });
    unsubscribe();
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.getItem(LS_SETTINGS_KEY)).toBeNull();
    restoreDom();
  });

  test('data is deliberately NOT flushed on unload', () => {
    // Guards the documented decision: only settings ride the keepalive window.
    const source = require('node:fs').readFileSync(new URL('./storage.ts', import.meta.url), 'utf8') as string;
    const flusher = source.slice(source.indexOf('export function createShutdownFlusher'));
    expect(flusher).not.toContain('localData');
    expect(flusher).toContain('deps.localSettings.save');
  });
});

// ============================================================================
// INTERFACE PARITY — local and Google must be interchangeable
// ============================================================================

describe('repository interface parity', () => {
  const methods = ['id', 'kind', 'isReady', 'load', 'save', 'clear', 'usage'];

  test('all four repositories expose the identical surface', () => {
    const client = createFakeSheetsClient();
    const repos = [
      createLocalSettingsRepository(createMemoryStorage()),
      createLocalDataRepository(createMemoryStorage()),
      createGoogleSettingsRepository({ client: () => client, documentId: () => 'doc', tab: 'app:settings' }),
      createGoogleDataRepository({ client: () => client, documentId: () => 'doc', tab: 'app:data' }),
    ];
    for (const repo of repos) {
      for (const m of methods) {
        expect(repo).toHaveProperty(m);
      }
    }
  });

  test('repository ids identify backend and role', () => {
    const client = createFakeSheetsClient();
    expect(createLocalSettingsRepository(createMemoryStorage()).id).toBe('local:settings');
    expect(createLocalDataRepository(createMemoryStorage()).id).toBe('local:data');
    expect(createGoogleSettingsRepository({ client: () => client, documentId: () => 'd', tab: 'app:settings' }).id).toBe('google:settings');
    expect(createGoogleDataRepository({ client: () => client, documentId: () => 'd', tab: 'app:data' }).id).toBe('google:data');
  });

  test('google repositories report not-ready without a client or document', () => {
    const client = createFakeSheetsClient();
    expect(createGoogleDataRepository({ client: () => null, documentId: () => 'doc', tab: 'app:data' }).isReady()).toBe(false);
    expect(createGoogleDataRepository({ client: () => client, documentId: () => '', tab: 'app:data' }).isReady()).toBe(false);
    expect(createGoogleDataRepository({ client: () => client, documentId: () => 'doc', tab: 'app:data' }).isReady()).toBe(true);
  });

  test('a google save without a connection fails gracefully rather than throwing', async () => {
    const repo = createGoogleDataRepository({ client: () => null, documentId: () => '', tab: 'app:data' });
    const res = await repo.save(sampleDataSets);
    expect(res.ok).toBe(false);
    expect(res.failure).toBe('unavailable');
  });

  test('local and google round-trip the same settings bag identically', async () => {
    const bag: SettingsBag = { theme: 'dark', lang: 'ru', columnFilters: { 0: '>10' } };
    const client = createFakeSheetsClient();
    const local = createLocalSettingsRepository(createMemoryStorage());
    const google = createGoogleSettingsRepository({ client: () => client, documentId: () => 'doc', tab: 'app:settings' });

    await local.save(bag);
    await google.save(bag);

    expect(await local.load()).toEqual(bag);
    expect(await google.load()).toEqual(bag);
  });

  test('local and google round-trip the same datasets identically', async () => {
    const client = createFakeSheetsClient();
    const local = createLocalDataRepository(createMemoryStorage());
    const google = createGoogleDataRepository({ client: () => client, documentId: () => 'doc', tab: 'app:data' });

    await local.save(sampleDataSets);
    await google.save(sampleDataSets);

    expect(await local.load()).toEqual(sampleDataSets);
    expect(await google.load()).toEqual(sampleDataSets);
  });
});

// ============================================================================
// SHEET ENCODINGS
// ============================================================================

describe('sheet encodings', () => {
  test('settings survive a rows round-trip including nested objects', () => {
    const bag: SettingsBag = {
      theme: 'dark',
      pageSize: 25,
      sortState: { columnIndex: 2, direction: 'desc' },
      columnFilters: { 0: '>10', 3: 'AAPL' },
      flag: true,
    };
    expect(rowsToSettings(settingsToRows(bag))).toEqual(bag);
  });

  test('the settings sheet carries a human-readable header', () => {
    expect(settingsToRows({ a: 1 })[0]).toEqual(['key', 'value']);
  });

  test('datasets survive a rows round-trip and keep file grouping order', () => {
    expect(rowsToDataSets(dataSetsToRows(sampleDataSets))).toEqual(sampleDataSets);
  });

  test('ragged rows are padded on write and trimmed on read', () => {
    const ragged: DataSet[] = [{ fileName: 'r.csv', data: [['a', 'b', 'c'], ['x']] }];
    const rows = dataSetsToRows(ragged);
    expect(rows[0]).toEqual(['file', 'c1', 'c2', 'c3']);
    expect(rows[2]).toEqual(['r.csv', 'x', '', '']);
    expect(rowsToDataSets(rows)).toEqual(ragged);
  });

  test('an empty data sheet decodes to an empty list', () => {
    expect(rowsToDataSets([])).toEqual([]);
    expect(rowsToDataSets([['file', 'c1']])).toEqual([]);
  });

  test('gridRange sizes the A1 range from the grid', () => {
    expect(gridRange([['a', 'b'], ['c', 'd'], ['e', 'f']])).toBe('A1:B3');
    expect(gridRange([['only']])).toBe('A1:A1');
  });
});

// ============================================================================
// SETTINGS MERGE POLICY
// ============================================================================

describe('mergeSettings', () => {
  test('remote values win for shared preferences', () => {
    const merged = mergeSettings({ theme: 'light', lang: 'en' }, { theme: 'dark' });
    expect(merged.theme).toBe('dark');
    expect(merged.lang).toBe('en');
  });

  test('device-scoped keys stay local so a shared sheet cannot repoint this browser', () => {
    const local = {
      googleClientId: 'local-client',
      settingsDocumentId: 'local-doc',
      dataDocumentId: 'local-data',
      backend: 'google',
      theme: 'light',
    };
    const remote = {
      googleClientId: 'other-client',
      settingsDocumentId: 'other-doc',
      dataDocumentId: 'other-data',
      backend: 'local',
      theme: 'dark',
    };
    const merged = mergeSettings(local, remote);

    expect(merged.googleClientId).toBe('local-client');
    expect(merged.settingsDocumentId).toBe('local-doc');
    expect(merged.dataDocumentId).toBe('local-data');
    expect(merged.backend).toBe('google');
    expect(merged.theme).toBe('dark'); // shared preference still syncs
  });

  test('handles null inputs on either side', () => {
    expect(mergeSettings(null, null)).toEqual({});
    expect(mergeSettings({ a: 1 }, null)).toEqual({ a: 1 });
    expect(mergeSettings(null, { a: 1 })).toEqual({ a: 1 });
  });
});
