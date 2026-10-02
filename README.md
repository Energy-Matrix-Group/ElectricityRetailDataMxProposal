# Electricity retail prototype

`electricity-retail-prototype.html` is a **single, self-contained file** (HTML + CSS + JS, no build step, no backend) that shows how selling electricity to contestable business customers on Western Power's SWIS network would work. It is a **mock-up and communication tool, not production software**, styled to match Energy Matrix Group's *How we build software* page. Open it in a browser (double-click is fine). Data is kept in `localStorage`; use **Export all data (JSON)** / **Import data (JSON)** (left navigation) to back it up.

External libraries come only from `cdnjs.cloudflare.com`, pinned with SRI hashes: **JSZip 3.10.1** (`.zip` uploads) and **SheetJS 0.18.5** (Excel export). If the CDN is unreachable the app still works; `.zip` upload and Excel export degrade with a clear message.

## Look and feel

The styling follows the Energy Matrix Group *How we build software* page so the mock-up reads as part of the same family: Montserrat (embedded as base64 so the file stays self-contained; SIL Open Font License 1.1), the navy / coral palette, square corners, tracked-caps labels, diamond motifs, the group logo in the sidebar, and light and dark themes. The half-circle button in the sidebar cycles *auto → light → dark*; the choice is stored with the other settings.

* **Quotes and invoices are the retailer's documents.** They carry the company name from *Data & settings* (placeholder "Your Company Pty Ltd") with the navy / coral accents, not the Energy Matrix Group logo.
* **Chart colours were checked** with the dataviz palette validator (colour-blind separation, contrast, ordinal ramp). The series blue is the brand navy lifted slightly in chroma (`#3B66A3` light, `#5C8DD6` dark) so it separates from coral; time bands use a fixed light-blue ramp from cheap to dear, with coral kept for on-peak.
* Unit symbols (kW, kVA, kWh, MWh) are never upper-cased by the styling.

## Try it in two minutes

1. **Dashboard → Load full demo.** Generates 13 months of 30-minute NEM12 data (E1 kWh + Q1 kvarh) for two test NMIs, ingests it through the normal pipeline, and creates two demo customers, sites, tariffs and an *illustrative* retail offer.
2. **Quotes → New quote.** Prices the customer's own 12 months of data; compares RT2 / RT34 / RT6; prints to PDF.
3. **Billing → Run bill.** Draft invoices for the last full month; review, issue, print.
4. **Tariff book → RT6 checks** shows the visible test of the charge just below and just above 300 kVA.

## Code map (search the file for `SECTION`)

| Section | Role | Production equivalent |
|---|---|---|
| `util` | dates (WST, timezone-free), formatting, SHA-256, CSV | shared library |
| `storage` + `rawStore` | write-once file store `{ fileId, fileName, uploadedAt, sha256, content }` | Azure Blob Storage |
| `repo` | one collection per table: Customer, Site, Nmi, StandingDataSnapshot, MeterDataFile, IntervalReading, NetworkTariff, TariffComponent, TimeBand, Rate, PublicHoliday, RetailOffer, Quote, BillRun, Invoice, InvoiceLine, MarketTransaction, Task (+ Setting). `get / list / insert / update / currentIntervals` | SQL Server |
| `nem12` | parser + validator (pure), plus the sample-data generator | parsing service |
| `seed` | Western Power 2026-27 price list, time bands, WA holidays as **data rows** | data load |
| `engine` | the calculation engine (pure). **Quotes and bills both call `engine.priceBillingPeriod()`** | pricing library |
| `svc` | ingestion pipeline, pricing orchestration, quotes, bill runs | application services |
| `ui` | screens | web front end |

Key behaviours: every interval is stored as a **new versioned row** (UpdateDateTime + sourceFileId, nothing overwritten); `repo.currentIntervals(nmi, suffix, from, to)` returns the latest version per interval; bills record a data watermark so a past invoice can be reproduced exactly; rates are dated rows resolved per billing day, so next year's price list is an import, not a code change (Tariff book → Rates → Import CSV / Roll forward).

## Decisions to confirm (please read)

* **The brief was cut off** mid-sentence at "Public holidays: editable table. Seed WA public…". Public holidays are seeded for 2025-2027 (with weekend substitute days) from the WA calendar and flagged *verify against the official list*. Retail offers, quotes, bill runs, invoices, market transactions and tasks were built from the table list in the architecture section; their exact rules were not in the received text.
* **RT6 step at 300 kVA.** The band table is implemented exactly as published. The published 300–1,000 fixed amount (34,468.200) equals 300 × 114.894, which omits the 0–300 band's own fixed 1,359.249, so the charge falls by 1,359.134 c/day (about $13.59/day) as MD crosses 300 kVA. The Tariff book shows this live. Confirm against Western Power's calculator.
* **MD method.** Bills: highest half-hourly kVA in the 12 calendar months (365 or 366 days) ending on each billing day (daily rolling). A "period end" variant is selectable in Data & settings. Quotes default to the reference year's annual peak applied to every month (a rolling window cannot be filled for early months with 13 months of data); "rolling as billed" is selectable.
* Sub-30-minute data is summed to the half hour before kVA is computed; reactive = Q + K datastreams; consumption = all E suffixes; **B (export) is shown but not credited**.
* Browser storage is roughly 5 M characters. The 13-month demo uses about 1.5 M because interval rows are persisted packed (one block per 300 record); SQL Server would hold one row per interval.
* Demand-length charge (MD > 1,000 kVA) is not calculated and is flagged wherever it would apply.

## Tests

```
node --test            # Node 20+; no dependencies. Runs against the HTML file itself.
npm i jszip            # optional: also runs the .zip upload test
```

The suite (91 tests) loads the file's `<script data-section="…">` blocks into Node and covers: storage quota and rollback, rawStore write-once/integrity, repo versioning and backup/restore, NEM12 parsing and validation (record order, value counts for any interval length, V + 400 coverage, bad dates, flags, UOM), the sample generator, hand-calculated RT2 / RT34 / RT6 bills, the 300 / 1,000 / 1,500 kVA boundaries, rate changeover on 1 July, quote-versus-bill parity, bill runs, void and re-bill. The app also has an in-browser **Tests** screen.
