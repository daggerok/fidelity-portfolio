// ui-shell.test.ts
/**
 * ============================================================================
 * TESTS: UI shell contract
 * ============================================================================
 * Mirrors the approach used by daggerok/fundamentals — the shell is asserted by
 * reading the source, which keeps these checks fast and DOM-free while still
 * pinning the exact panel geometry and toggle semantics the design requires.
 *
 * The debug/settings popovers must stay visually and behaviourally identical to
 * https://daggerok.github.io/fundamentals/:
 *   • both are `role="dialog"` overlays that never reflow the page
 *   • identical `w-[min(92vw,22rem)]` popover dimensions
 *   • debug anchored LEFT, settings anchored RIGHT
 *   • both default to closed on every refresh and only close on explicit toggle
 * ============================================================================
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ============================================================================
// PANEL GEOMETRY — parity with fundamentals
// ============================================================================

describe('debug & settings popovers match the fundamentals shell', () => {
  test('both use the same popover dimensions, anchored on opposite sides', () => {
    expect(main).toContain('role="dialog"');
    expect(main).toContain('absolute left-0 top-full mt-2 w-[min(92vw,22rem)] z-[60]');
    expect(main).toContain('absolute right-0 top-full mt-2 w-[min(92vw,22rem)] z-[60]');
  });

  test('both panels are plain useState toggles that reset on refresh', () => {
    expect(main).toContain('const [showDebug, setShowDebug] = useState(false)');
    expect(main).toContain('const [showSettings, setShowSettings] = useState(false)');
    // Panel state must NOT be persisted into settings — refresh always closes.
    expect(main).not.toContain('settings.showDebug');
    expect(main).not.toContain('settings.showSettings');
  });

  test('each panel is toggled from exactly one place', () => {
    expect(main.match(/setShowDebug\(/g)).toHaveLength(1);
    expect(main.match(/setShowSettings\(/g)?.length).toBeLessThanOrEqual(2); // toggle + explicit Close
  });

  test('panels expose accessible expansion state', () => {
    expect(main).toContain('aria-expanded={showDebug}');
    expect(main).toContain('aria-expanded={showSettings}');
  });

  test('the debug trigger is the ⌘ glyph and settings is the gear', () => {
    expect(main).toContain('⌘');
    expect(main).toContain('⚙️');
  });
});

// ============================================================================
// DEBUG PANEL CONTENT
// ============================================================================

describe('debug panel sections', () => {
  test('renders the documented sections', () => {
    for (const key of ['debug.overview', 'debug.storage', 'debug.connection', 'debug.activity']) {
      expect(main).toContain(`t('${key}', lang)`);
    }
  });

  test('surfaces both repository identities and both documents', () => {
    expect(main).toContain("t('debug.settingsRepo', lang)");
    expect(main).toContain("t('debug.dataRepo', lang)");
    expect(main).toContain("t('debug.settingsDoc', lang)");
    expect(main).toContain("t('debug.dataDoc', lang)");
  });

  test('shows the local byte budget', () => {
    expect(main).toContain("t('debug.budget', lang)");
    expect(main).toContain('DATA_BUDGET_MB');
  });

  test('verbose console logging stays behind ?debug=true', () => {
    expect(main).toContain("get('debug') === 'true'");
    expect(main).toContain('if (DEBUG_ENABLED) console.log');
  });
});

// ============================================================================
// SETTINGS PANEL CONTENT
// ============================================================================

describe('settings panel sections', () => {
  test('renders display, table, data and google groups', () => {
    for (const key of ['settings.display', 'settings.table', 'settings.data', 'settings.google']) {
      expect(main).toContain(`t('${key}', lang)`);
    }
  });

  test('offers separate spreadsheet inputs for settings and data', () => {
    expect(main).toContain("t('settings.settingsDoc', lang)");
    expect(main).toContain("t('settings.dataDoc', lang)");
    expect(main).toContain('updateSettingsDocument');
  });

  test('auto-fill mirrors the settings document into the data document', () => {
    expect(main).toContain("t('settings.autoFill', lang)");
    expect(main).toContain('autoFillDataDocument');
    // The mirror must not clobber a value the user deliberately changed.
    expect(main).toContain("prev.dataDocumentId.trim() === prev.settingsDocumentId.trim()");
  });

  test('backend switching goes through the guarded helpers', () => {
    expect(main).toContain('switchToGoogle');
    expect(main).toContain('switchToLocal');
  });
});

// ============================================================================
// STORAGE INVARIANTS AS WIRED IN THE SHELL
// ============================================================================

describe('the shell honours the storage invariants', () => {
  test('I1 — settings are saved to localStorage on every change', () => {
    expect(main).toContain('void localSettingsRepo.save(settings)');
  });

  test('I4 — the shell calls the one-way sync helper and nothing else', () => {
    expect(main).toContain('syncDataFromGoogleToLocal');
    expect(main).not.toContain('syncDataFromLocalToGoogle');
  });

  test('I5 — a shutdown flusher is registered', () => {
    expect(main).toContain('createShutdownFlusher');
    expect(main).toContain('keepaliveWrite');
  });

  test('the UI depends on the Repository abstraction, not on raw storage calls', () => {
    // No direct localStorage.setItem for data/settings outside the repositories.
    expect(main).not.toContain('localStorage.setItem');
  });

  test('active repositories are resolved in one place', () => {
    expect(main).toContain('const activeDataRepo: DataRepository');
    expect(main).toContain("const activeBackend: BackendKind");
  });
});

// ============================================================================
// CSV FEATURE SURFACE
// ============================================================================

describe('csv viewer feature parity', () => {
  test('imports the engine rather than re-implementing it', () => {
    expect(main).toContain("from './csv-engine'");
    expect(main).toContain('extractValidTableData');
    expect(main).toContain('applyFilters');
    expect(main).toContain('getComparator');
  });

  test('renders both the tab table and the merge view', () => {
    expect(main).toContain('settings.mergeFiles ?');
    expect(main).toContain('FILE [');
  });

  test('supports inline header renaming and per-column type cycling', () => {
    expect(main).toContain('InlineHeaderEditor');
    expect(main).toContain('onTypeChange');
    expect(main).toContain('columnCustomNames');
  });

  test('filter input is debounced', () => {
    expect(main).toContain('FILTER_DEBOUNCE_MS');
  });

  test('exports tab, merged and per-file CSV', () => {
    expect(main).toContain('exportTabCSV');
    expect(main).toContain('exportMergedCSV');
    expect(main).toContain('exportAllCSV');
  });
});

// ============================================================================
// PROJECT STRUCTURE — must match daggerok/csv and daggerok/google
// ============================================================================

describe('project structure parity with csv & google repos', () => {
  test('parcel entrypoint is src/index.html', () => {
    expect(pkg.source).toBe('src/index.html');
  });

  test('ships the same script set', () => {
    for (const script of ['clean', 'build', 'serve', 'build-github-pages', 'start', 'stop', 'logs', 'test']) {
      expect(pkg.scripts).toHaveProperty(script);
    }
  });

  test('github pages build is scoped to the fidelity path', () => {
    expect(pkg.scripts['build-github-pages']).toContain('--public-url=/fidelity/');
  });

  test('index.html wires favicon, stylesheet and the tsx module', () => {
    expect(html).toContain('./favicon.ico');
    expect(html).toContain('./index.css');
    expect(html).toContain('./main.tsx');
    expect(html).toContain('id="root"');
  });

  test('tailwind v4 is configured CSS-first with the scoped dark variant', () => {
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain('@custom-variant dark (&:where(.dark, .dark *))');
    expect(pkg.postcss.plugins).toHaveProperty('@tailwindcss/postcss');
  });

  test('themed scrollbars are defined for the table and tab strip', () => {
    expect(css).toContain('.table-container');
    expect(css).toContain('.themed-scroll');
  });
});
