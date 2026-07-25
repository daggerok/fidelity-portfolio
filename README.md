# Fidelity Template — CSV viewer + Google Sheets as a database

[![CI](https://github.com/daggerok/fidelity/actions/workflows/ci.yaml/badge.svg)](https://github.com/daggerok/fidelity/actions/workflows/ci.yaml)

A **getting-started template** for building browser-only apps that treat a Google
Spreadsheet as a database, while remaining fully usable offline with
`localStorage`.

Built from the same foundations as:

- [daggerok/csv](https://github.com/daggerok/csv) — the CSV viewer engine and project structure
- [daggerok/google](https://github.com/daggerok/google) — the Google Sheets / GIS OAuth layer
- [daggerok/fundamentals](https://daggerok.github.io/fundamentals/) — the Debug (⌘) and Settings (⚙️) panel design

---

## Quick start

```bash
bun install -E
bun run serve     # http://localhost:1234
bun test          # 116 tests
bun run build
```

Open the app, press **Load demo data**, and explore. No configuration is needed —
`localStorage` is the default backend.

Add `?debug=true` to the URL for verbose console logging.

---

## Project structure

Identical layout to `daggerok/csv` and `daggerok/google`:

```
src/
├── index.html          # Parcel entrypoint
├── index.css           # Tailwind v4, CSS-first config
├── favicon.ico
├── main.tsx            # React shell: table, Debug panel, Settings panel
├── csv-engine.ts       # parsing · type detection · sorting · filtering · export
├── storage.ts          # Repository<T> — localStorage & Google Sheets
├── google-sheets.ts    # GIS OAuth + Sheets v4 transport
├── csv-engine.test.ts
├── storage.test.ts
└── ui-shell.test.ts
```

---

## The storage contract

Everything hinges on one interface. **localStorage and Google Sheets implement
it identically**, so no calling code ever branches on the backend:

```ts
interface Repository<T> {
  readonly id: string;          // 'local:settings' | 'google:data' | …
  readonly kind: 'local' | 'google';
  isReady(): boolean;
  load(): Promise<T | null>;
  save(value: T): Promise<SaveResult>;
  clear(): Promise<void>;
  usage(): Promise<number | null>;
}
```

Four implementations ship in the box:

| Repository | Backend | Stores |
|---|---|---|
| `createLocalSettingsRepository` | localStorage | app settings |
| `createLocalDataRepository` | localStorage | CSV rows (budgeted) |
| `createGoogleSettingsRepository` | Sheets tab `app:settings` | app settings |
| `createGoogleDataRepository` | Sheets tab `app:data` | CSV rows |

### The five invariants

These are the product rules, encoded in `storage.ts` and enforced by tests.

**I1 · localStorage always keeps the settings.**
Whether or not Google is connected, every settings change is written locally.
Google is *additive*, never a replacement. This also avoids a bootstrap paradox:
the Google configuration itself lives in settings.

**I2 · Local data is best-effort and budgeted.**
Rows are cached locally only while they fit `DATA_BUDGET_MB` (4 MB by default).
Beyond that the write is refused with `'over-budget'` and the app keeps working —
the rows simply live in memory or in Google instead.

**I3 · Data can never evict settings.**
Every data write goes through `guardedWrite()`, which snapshots the settings key
first, refuses oversized payloads up-front, and on `QuotaExceededError` removes
the *data* key and restores the settings snapshot. A full disk can cost you rows;
it can never cost you your configuration.

**I4 · Sync is one-way: Google → local.**
`syncDataFromGoogleToLocal()` mirrors sheet rows down when you switch back to
localStorage. There is deliberately **no** local→Google bulk sync: a local cache
truncated by the byte budget would silently destroy remote rows if pushed back up.

**I5 · On close, settings flush to both backends.**
`createShutdownFlusher()` listens on `pagehide` + `visibilitychange → hidden`
(more reliable than `beforeunload`, and bfcache-safe). It writes settings to
localStorage synchronously and to Google via a `keepalive` fetch. Data is *not*
flushed on unload — it is unbounded, would exceed the ~64 KB keepalive ceiling,
and I3 forbids risking the settings write on its behalf.

---

## Google Sheets setup

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/).
2. Enable the **Google Sheets API**.
3. Configure the **OAuth consent screen** and add yourself as a test user.
4. Create an **OAuth client ID → Web application**, with authorized JavaScript origins:
   - `http://localhost:1234` (development)
   - `https://YOUR-USERNAME.github.io` (production)
5. Paste the client ID into ⚙️ Settings → *OAuth client ID*.
6. Paste a spreadsheet URL into *Settings spreadsheet* and press **Connect**.

The tabs `app:settings` and `app:data` are created automatically.

### Two documents, one token

Settings and data can live in **separate spreadsheets**. Pasting the settings
document auto-fills the data document field, so the common "one document, two
tabs" case needs a single paste — but you can point the data field at a different
spreadsheet whenever you want. Turn the mirroring off with the *Auto-fill data
document* toggle.

### Sheet encodings

`app:settings` — two columns, human-editable:

| key | value |
|---|---|
| `theme` | `"dark"` |
| `columnFilters` | `{"0":">10"}` |

`app:data` — long format so many files share one grid:

| file | c1 | c2 |
|---|---|---|
| `a.csv` | Ticker | Price |
| `a.csv` | AAPL | 232.10 |
| `b.csv` | X | 1 |

### Security notes

- The access token lives **in memory only** — never in localStorage, never in the sheet.
- There is no client secret and no backend; this is the browser-only OAuth token flow.
- Device-scoped keys (`googleClientId`, `settingsDocumentId`, `dataDocumentId`,
  `backend`) are **never** overwritten by the remote sheet, so a shared spreadsheet
  cannot repoint another machine's wiring.

---

## CSV features

Ported from [daggerok/csv](https://github.com/daggerok/csv):

- **Heuristic parser** — strips preamble/postamble prose from broker exports by
  keeping the longest contiguous block matching the modal column width.
- **Column types** — `string` · `number` · `percent` · `currency` · `marketcap`,
  auto-detected by regex sampling, overridable by clicking the header badge.
- **Smart sort** — `$1.2B` outranks `$999M`; `(1,234.00)` reads as −1234;
  strings use natural order (`file2` before `file10`); blanks always sink.
- **Per-column filters** (debounced 250 ms):

  | Syntax | Meaning |
  |---|---|
  | `a b` | AND |
  | `a,b` | OR |
  | `!a` | NOT |
  | `"multi word"` | phrase |
  | `>10 <50` | numeric range |
  | `!22` | not equal to 22 |

- **Inline header rename**, **merge view** with dual-axis sticky banners,
  and CSV export (current tab / merged / one file per download).

---

## UI shell

The Debug (⌘) and Settings (⚙️) panels replicate
[daggerok/fundamentals](https://daggerok.github.io/fundamentals/):

- `role="dialog"` overlays that **never reflow the page**
- identical `w-[min(92vw,22rem)]` dimensions
- debug anchored **left**, settings anchored **right**
- both reset to closed on refresh and stay open until explicitly toggled

The Debug panel reports the active backend, which repository is serving each
role, live localStorage byte usage against the budget, the last write result,
the Google connection with both document IDs, and a rolling activity log.

---

## Testing

```bash
bun test
```

116 tests across three files:

- `storage.test.ts` — the five invariants, repository interface parity, sheet encodings, merge policy
- `csv-engine.test.ts` — parser, type detection, sorting, the full filter grammar, export
- `ui-shell.test.ts` — panel geometry/behaviour parity with fundamentals, project structure

---

## Scripts

| Script | Purpose |
|---|---|
| `bun run serve` | dev server on :1234 |
| `bun run build` | production build to `dist/` |
| `bun run build-github-pages` | build with `--public-url=/fidelity/` |
| `bun test` | run the test suite |
| `bun run clean` | remove `dist/` |
| `bun start` / `bun stop` / `bun run logs` | pm2 process control |

---

## License

MIT © Maksim Kostromin
