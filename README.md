# Fidelity reports [![CI](https://github.com/daggerok/fidelity-portfolio/actions/workflows/ci.yaml/badge.svg)](https://github.com/daggerok/fidelity-portfolio/actions/workflows/ci.yaml) [![GitHub Pages](https://github.com/daggerok/fidelity-portfolio/actions/workflows/github-pages.yml/badge.svg)](https://github.com/daggerok/fidelity-portfolio/actions/workflows/github-pages.yml)

[Open the app](https://daggerok.github.io/fidelity-portfolio/)

A static web page that replaces the Fidelity jobs of [scio-examples](https://github.com/daggerok/scio-examples). Import Fidelity `Portfolio_Positions` CSV exports (one per account or an all-accounts file) and get the same reports the Scala jobs wrote to `target/`:

| Tab | Scala job | What it shows |
| --- | --- | --- |
| Watchlists | `BuildFidelityAccountsWatchlistScioApp` | tickers by market cap: All, All Stocks, All ETFs and one list per account |
| Investments | `BuildFidelityInvestmentsScioApp` | dollars still missing to reach $2 ... $100 per position |
| Dividends | `BuildFidelityDividendsScioApp` | dollars needed so a payout buys 0.001 share, at 1x ... 100000x |
| DRIPs | `BuildFidelityDRIPsScioApp` | DRIP shortfall in dollars and shares, future ex and pay dates |

- Files: every imported file as a table. Preamble lines, blank lines and the quoted disclaimers at the end are ignored, an all-accounts export is split by account. A CSV that is not a Fidelity positions export is shown but not used in the reports
- The reports are built in a web worker while you look at the files; a spinner sits on each report tab until it is ready
- Every table sorts (click a header), filters with the grammar of the ETF apps (space AND, comma OR, `!` NOT, `?` empty, `>10 <50`, ranges `10..50`, `K M B T`, `=exact ^starts ends$ /regex/`, dates), has a Columns menu, Copy Tickers, Export .csv and Export .txt. Column types are detected and can be changed with the badge in the header (Shift+click resets)
- Download all reports: one zip with `watchlist/`, `investments/`, `dividends/` and `DRIPs/`, in the Scala output format
- Nothing leaves the browser. Files are kept across reloads only when "Remember files" is on (off by default)

## Differences from the Scala jobs

- The Scala All, All Stocks and All ETFs watchlists read every file with the header of one file (`take(1)` over the union). Exports with other columns (`Sleeve name`, 38, 39 or 41 columns) lose their tickers there: 242 instead of 449 tickers on the 2026-10-02 exports. The web app reads each file with its own header, so All is the union of the account lists
- Rows with an equal sort key (the same market cap in a watchlist, the same first diff in dividends) have no defined order in Beam; here they keep the file order

## Development

```bash
bun install -E
bun test src                                  # report math and CSV reading
bun run build                                 # Parcel build into dist/
bun run serve                                 # http://localhost:1234
bun scripts/compare-scio.ts ../scio-examples  # compare with the Scala outputs in scio-examples/target
```

`compare-scio.ts` runs the reports on `scio-examples/src/main/resources/input` and compares them with `target/{watchlist,investments,dividends,DRIPs}`. DRIPs show only dates after the day the Scala job ran, taken from the time of `target/DRIPs/1.csv` (or pass it: `... ../scio-examples 2026-10-03`).

The money math uses `decimal.js` with 34 digits and HALF_EVEN, like Scala's `BigDecimal`, so every cent matches.

## License

MIT
