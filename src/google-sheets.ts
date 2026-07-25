// google-sheets.ts
/**
 * ============================================================================
 * AGENTIC AI ENFORCED SPECIFICATION & GUIDELINES (CRITICAL)
 * ============================================================================
 * 1. PERSIST ALL COMMENTS: Under no circumstances should ANY code comments,
 *    system design docs, or type descriptors be removed or truncated.
 * 2. AGENT READ-WRITE RULE: If a future deployment or agent updates the code,
 *    this header section and related documentation blocks MUST be kept accurate,
 *    expanded, and dynamically synchronized with the feature upgrades.
 * 3. LAYER CONTINUITY: This module owns *only* the transport concerns of Google
 *    (OAuth token acquisition through GIS + the Sheets v4 REST surface).
 *    It must stay free of React and free of repository/business semantics so it
 *    can be unit-tested head-less by injecting `fetchImpl`.
 * ============================================================================
 *
 * ============================================================================
 * MODULE: Google Identity Services (GIS) + Google Sheets v4 transport
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The application treats a Google Spreadsheet as a remote database. Two totally
 * separate spreadsheet documents are supported (see `storage.ts`):
 *
 *   • the APP SETTINGS document  → tab `app:settings`
 *   • the APP DATA    document  → tab `app:data`
 *
 * Both are reached through the same token and the same REST helpers defined
 * here. Nothing in this file knows which document plays which role.
 *
 * AUTH MODEL
 * ----------
 * Browser-only OAuth 2.0 implicit/token flow via Google Identity Services.
 * There is NO client secret and NO backend: the access token lives in memory
 * only (never localStorage — see the security notes in README) and expires
 * after ~1h, at which point a silent re-request is attempted.
 *
 * KEEPALIVE WRITES
 * ----------------
 * `writeValues()` accepts `keepalive`, which is what makes the "flush settings
 * to Google when the tab is closing" requirement possible: `fetch(..., {
 * keepalive: true })` survives document unload, unlike a normal fetch, and —
 * unlike `navigator.sendBeacon()` — it can carry the `Authorization` header
 * that the Sheets API demands. Payloads must stay under ~64KB, which is why
 * only SETTINGS (small, bounded) are flushed this way, never bulk data.
 * ============================================================================
 */

/** Scopes required: full spreadsheets access + identity for the account label. */
export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'openid',
  'email',
  'profile',
].join(' ');

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const SHEETS_API = 'https://sheets.googleapis.com/v4';
export const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const DRIVE_FILE_URL = 'https://docs.google.com/spreadsheets/d';

/** Canonical tab names. Settings and data may live in ONE or in TWO documents. */
export const SETTINGS_TAB = 'app:settings';
export const DATA_TAB = 'app:data';

export type GisTokenResponse = { access_token?: string; error?: string };
export type GisErrorResponse = { type?: string; message?: string };
export type GisTokenClient = { requestAccessToken: (opts?: { prompt?: string }) => void };
export type GisNamespace = {
  accounts: {
    oauth2: {
      initTokenClient: (cfg: {
        client_id: string;
        scope: string;
        callback: (r: GisTokenResponse) => void;
        error_callback?: (e: GisErrorResponse) => void;
      }) => GisTokenClient;
      revoke: (token: string, cb?: () => void) => void;
    };
  };
};

declare global {
  interface Window {
    google?: GisNamespace;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Minimal shape of the Sheets `spreadsheets.get` response we actually consume. */
export type SpreadsheetMeta = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: { properties?: { title?: string; sheetId?: number } }[];
};

// ============================================================================
// SMALL PURE HELPERS (exported: they are covered by unit tests)
// ============================================================================

/**
 * Accepts anything a user may paste and returns the bare spreadsheet ID:
 *   • a full edit URL   → https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0
 *   • a bare ID         → <ID>
 *   • an ID with suffix → <ID>/edit
 */
export function normalizeSpreadsheetId(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match?.[1]) return match[1];
  return trimmed.replace(/[#?].*$/, '').replace(/\/edit.*$/, '').replace(/\/$/, '');
}

/** Builds the canonical human-openable URL for a spreadsheet ID. */
export function spreadsheetUrl(id: string): string {
  return `${DRIVE_FILE_URL}/${id}/edit`;
}

/**
 * Quotes a sheet/tab title for use inside an A1 range.
 * Tab names such as `app:settings` contain a colon and MUST be quoted, otherwise
 * the Sheets API parses `app:settings!A1` as a malformed range.
 */
export function quoteTab(title: string): string {
  const name = (title ?? '').trim() || DATA_TAB;
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** Composes an A1 range: `'app:data'!A1:ZZ`. */
export function a1(tab: string, cells: string): string {
  return `${quoteTab(tab)}!${cells}`;
}

/** Converts a 0-based column index to spreadsheet letters (0→A, 26→AA). */
export function columnLetter(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

/** Human-readable message extraction for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}

// ============================================================================
// GIS SCRIPT LOADING & TOKEN ACQUISITION
// ============================================================================

let gisPromise: Promise<void> | null = null;

/** Polls until the GIS namespace is present (the script sets it asynchronously). */
function waitForGis(timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('Google Identity Services timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Injects the GIS <script> exactly once and resolves when it is usable. */
export async function loadGis(): Promise<void> {
  if (typeof window === 'undefined') throw new Error('GIS requires a browser');
  if (window.google?.accounts?.oauth2) return;
  if (!gisPromise) {
    gisPromise = new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => {
        gisPromise = null;
        reject(e);
      };
      if (document.querySelector('script[data-gis]')) {
        waitForGis().then(resolve).catch(fail);
        return;
      }
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.dataset.gis = '1';
      script.onload = () => waitForGis().then(resolve).catch(fail);
      script.onerror = () => fail(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(script);
    });
  }
  await gisPromise;
}

/**
 * Requests an access token.
 * @param interactive `true` forces the account chooser / consent screen;
 *                    `false` attempts a silent refresh of an existing grant.
 */
export async function requestAccessToken(clientId: string, interactive: boolean): Promise<string> {
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google Identity Services unavailable');
  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error));
        if (!r.access_token) return reject(new Error('No access token returned'));
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e?.type || e?.message || 'Google auth error')),
    });
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

/** Revokes the in-memory token (best effort; never throws). */
export function revokeAccessToken(token: string): void {
  try {
    window.google?.accounts?.oauth2?.revoke(token, () => undefined);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// SHEETS v4 CLIENT
// ============================================================================

export type SheetsClientOptions = {
  /** Returns a live access token; must throw when the session is gone. */
  getToken: () => string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Optional debug sink. */
  log?: (...args: unknown[]) => void;
};

export type SheetsClient = ReturnType<typeof createSheetsClient>;

export function createSheetsClient(options: SheetsClientOptions) {
  const doFetch: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const log = options.log ?? (() => undefined);

  /** Authenticated JSON request with Sheets-shaped error unwrapping. */
  async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
    log('sheets', init.method ?? 'GET', url);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${options.getToken()}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const res = await doFetch(url, { ...init, headers });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      let message = text || `HTTP ${res.status}`;
      const err = (json as { error?: { message?: string } } | null)?.error;
      if (err?.message) message = err.message;
      throw new Error(`Google Sheets API ${res.status}: ${message}`);
    }
    return json as T;
  }

  const api = <T>(path: string, init?: RequestInit) => call<T>(`${SHEETS_API}${path}`, init);

  return {
    /** Email of the signed-in account (used purely as a UI label). */
    async userEmail(): Promise<string> {
      const profile = await call<{ email?: string }>(USERINFO);
      return profile.email?.trim() ?? '';
    },

    /** Spreadsheet metadata — also the cheapest way to validate access. */
    getSpreadsheet(spreadsheetId: string): Promise<SpreadsheetMeta> {
      const id = normalizeSpreadsheetId(spreadsheetId);
      if (!id) throw new Error('Spreadsheet ID is empty');
      return api<SpreadsheetMeta>(`/spreadsheets/${id}`);
    },

    /** Creates a spreadsheet containing the given tabs. */
    async createSpreadsheet(title: string, tabs: string[]): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
      const res = await api<SpreadsheetMeta>('/spreadsheets', {
        method: 'POST',
        body: JSON.stringify({
          properties: { title: title.trim() || 'App Database' },
          sheets: tabs.map((t) => ({ properties: { title: t } })),
        }),
      });
      const id = res.spreadsheetId?.trim();
      if (!id) throw new Error('Google did not return a spreadsheet ID');
      return { spreadsheetId: id, spreadsheetUrl: res.spreadsheetUrl?.trim() || spreadsheetUrl(id) };
    },

    /** Creates the tab when missing. Idempotent. */
    async ensureTab(spreadsheetId: string, tab: string): Promise<void> {
      const id = normalizeSpreadsheetId(spreadsheetId);
      const meta = await api<SpreadsheetMeta>(`/spreadsheets/${id}`);
      const exists = (meta.sheets ?? []).some((s) => s.properties?.title === tab);
      if (exists) return;
      await api(`/spreadsheets/${id}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
      });
    },

    /** Reads a rectangular range; missing cells come back as short rows. */
    async readValues(spreadsheetId: string, tab: string, cells = 'A1:ZZ'): Promise<string[][]> {
      const id = normalizeSpreadsheetId(spreadsheetId);
      const range = encodeURIComponent(a1(tab, cells));
      const res = await api<{ values?: string[][] }>(`/spreadsheets/${id}/values/${range}`);
      return res.values ?? [];
    },

    /**
     * Overwrites a range.
     * @param keepalive set during page unload so the request survives teardown.
     */
    async writeValues(
      spreadsheetId: string,
      tab: string,
      cells: string,
      values: string[][],
      keepalive = false,
    ): Promise<void> {
      const id = normalizeSpreadsheetId(spreadsheetId);
      const rangeText = a1(tab, cells);
      const range = encodeURIComponent(rangeText);
      await api(`/spreadsheets/${id}/values/${range}?valueInputOption=RAW`, {
        method: 'PUT',
        keepalive,
        body: JSON.stringify({ range: rangeText, majorDimension: 'ROWS', values }),
      });
    },

    /** Clears a range but keeps the tab itself. */
    async clearValues(spreadsheetId: string, tab: string, cells = 'A1:ZZ'): Promise<void> {
      const id = normalizeSpreadsheetId(spreadsheetId);
      const range = encodeURIComponent(a1(tab, cells));
      await api(`/spreadsheets/${id}/values/${range}:clear`, { method: 'POST', body: '{}' });
    },
  };
}
