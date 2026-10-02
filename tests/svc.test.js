const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('node:crypto');
const { makeContext, ev, CORE } = require('./harness');

const FILES = [...CORE, '40-nem12.js', '41-nem12-sample.js', '50-seed.js', '60-engine.js', '70-svc.js'];
// Zip upload tests need JSZip (the app loads it from cdnjs in the browser). Run `npm i jszip` to enable them; otherwise they are skipped.
const JSZIP_SRC = (() => { try { return fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'), 'utf8'); } catch (e) { return null; } })();
function boot() {
  const ctx = makeContext({ files: FILES });
  if (JSZIP_SRC) vm.runInContext(JSZIP_SRC, ctx);
  const g = n => ev(ctx, n);
  const b = { ctx, util: g('util'), repo: g('repo'), rawStore: g('rawStore'), nem12: g('nem12'), engine: g('engine'), seed: g('seed'), svc: g('svc'), JSZip: JSZIP_SRC ? g('JSZip') : null };
  b.seed.run();
  return b;
}
const J = x => JSON.parse(JSON.stringify(x));
const approx = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b} got ${a}`);
const CRLF = '\r\n';
const mini = (nmi = '8001MINI01', dates = ['20260701'], extra = {}) => ['100,NEM12,202607021200,MDP,RET', `200,${nmi},E1,1,E1,N1,SN,kWh,30,20260801`,
  ...dates.map(d => ['300', d, ...Array(extra.count ?? 48).fill(1), extra.q ?? 'A', '', '', '20260702010000', ''].join(',')), '900'].join(CRLF) + CRLF;
const bytes = s => new TextEncoder().encode(s);

// one shared, expensive fixture: 13 months x 2 NMIs ingested once
let fx = null;
async function fixture() {
  if (fx) return fx;
  const b = boot();
  const sample = await b.svc.loadSampleData();
  b.svc.setupDemoEntities();
  fx = { ...b, sample };
  return fx;
}

test('ingest: raw file stored unchanged first, then every interval inserted as a versioned row; report kept with the file', async () => {
  const b = await fixture();
  const { repo, rawStore, util } = b;
  assert.equal(b.sample.results.length, 2);
  for (const r of b.sample.results) {
    assert.equal(r.status, 'Accepted', JSON.stringify(r.report && r.report.issues.slice(0, 3)));
    const raw = rawStore.get(r.fileId);
    assert.equal(raw.sha256, crypto.createHash('sha256').update(Buffer.from(raw.content, 'utf8')).digest('hex'));
    assert.equal(rawStore.verify(r.fileId), true);
    assert.match(raw.content, /^100,NEM12,/);                              // unchanged text incl. CRLF
    assert.ok(raw.content.includes('\r\n'));
    const mdf = repo.get('MeterDataFile', r.fileId);
    assert.equal(mdf.status, 'Accepted');
    assert.equal(mdf.validation.streams.length, 2);                        // validation report kept with the file
    assert.equal(mdf.intervalRowsInserted, 395 * 48 * 2);
    assert.equal(mdf.sha256, raw.sha256);
  }
  assert.equal(repo.count('IntervalReading'), 2 * 395 * 48 * 2);
  assert.equal(repo.count('MeterDataFile'), 2);
  const tail = repo.list('IntervalReading', r => r.nmi === '8001TEST01' && r.suffix === 'E1' && r.intervalDate === b.sample.window.to);
  assert.equal(tail.length, 48);
  assert.ok(tail.every(r => r.quality === 'E' && r.method === '52'));      // latest day delivered as forward estimate
  assert.ok(tail.every(r => r.sourceFileId && r.updateDateTime && r.sourceLine > 0));
});

test('ingest: NMIs are discovered, standing data snapshots captured from the 200 records, tasks raised for missing data', async () => {
  const { repo, svc } = await fixture();
  assert.deepEqual(J(repo.list('Nmi').map(n => n.nmi).sort()), ['8001TEST01', '8001TEST02']);
  const snaps = svc.snapshots('8001TEST01');
  assert.ok(snaps.length >= 2);                                            // NEM12 capture + manual tariff assignment
  const first = snaps[0];
  assert.equal(first.source, 'NEM12');
  assert.deepEqual(J(first.streams.map(s => [s.suffix, s.uom, s.intervalLength])), [['E1', 'kWh', 30], ['Q1', 'kvarh', 30]]);
  assert.equal(svc.standing('8001TEST01').networkTariffCode, 'RT34');
  assert.equal(svc.standing('8001TEST02').networkTariffCode, 'RT6');
  assert.ok(repo.list('Task').some(t => /Missing interval data for NMI 8001TEST01/.test(t.title)));
  assert.ok(repo.list('Task').filter(t => /^Assign NMI/.test(t.title)).every(t => t.status === 'Done'), 'assignment tasks closed by the demo setup');
});

test('ingest: a duplicate upload is detected before anything is stored; allowDuplicate stores it again', async () => {
  const b = boot();
  const f = bytes(mini());
  const first = await b.svc.ingestUpload({ fileName: 'a.csv', bytes: f });
  assert.equal(first.status, 'Accepted');
  const raws = b.rawStore.list().length;
  const dup = await b.svc.ingestUpload({ fileName: 'a-again.csv', bytes: f });
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.duplicates[0].fileId, first.fileId);
  assert.equal(b.rawStore.list().length, raws);
  const again = await b.svc.ingestUpload({ fileName: 'a-again.csv', bytes: f, allowDuplicate: true });
  assert.equal(again.status, 'Accepted');
  assert.equal(b.rawStore.list().length, raws + 1);
});

test('ingest: .zip with one CSV is unzipped and parsed; the zip itself is what rawStore keeps', { skip: !JSZIP_SRC && 'npm i jszip to run the zip tests' }, async () => {
  const b = boot();
  const zip = new b.JSZip();
  zip.file('NEM12#test.csv', mini('8001ZIP001'));
  const zbytes = await zip.generateAsync({ type: 'uint8array' });
  const r = await b.svc.ingestUpload({ fileName: 'data.zip', bytes: zbytes });
  assert.equal(r.status, 'Accepted');
  assert.equal(r.innerFileName, 'NEM12#test.csv');
  assert.equal(r.inserted, 48);
  const meta = b.rawStore.meta(r.fileId);
  assert.equal(meta.encoding, 'base64');
  assert.equal(meta.sha256, crypto.createHash('sha256').update(Buffer.from(zbytes)).digest('hex'));
  assert.deepEqual(Array.from(b.rawStore.getBytes(r.fileId)), Array.from(zbytes));       // bit-for-bit
  assert.equal(b.repo.get('MeterDataFile', r.fileId).kind, 'zip');
  // two CSVs in one zip: rejected (raw still kept), nothing ingested
  const z2 = new b.JSZip();
  z2.file('a.csv', mini('8001ZIP002')); z2.file('b.csv', mini('8001ZIP003'));
  const bad = await b.svc.ingestUpload({ fileName: 'two.zip', bytes: await z2.generateAsync({ type: 'uint8array' }) });
  assert.equal(bad.status, 'Rejected');
  assert.match(bad.report.issues[0].msg, /exactly one CSV.*2/);
  assert.equal(b.rawStore.list().length, 2);
  assert.equal(b.repo.count('IntervalReading'), 48);
  // zip without any csv; and garbage bytes with a .zip name
  const z3 = new b.JSZip(); z3.file('readme.txt', 'hello');
  assert.equal((await b.svc.ingestUpload({ fileName: 'none.zip', bytes: await z3.generateAsync({ type: 'uint8array' }) })).status, 'Rejected');
  assert.equal((await b.svc.ingestUpload({ fileName: 'junk.zip', bytes: bytes('not a zip at all') })).status, 'Rejected');
});

test('ingest: validation outcomes — partial (bad day skipped), strict mode rejects, headerless file is rejected; raw is always kept', async () => {
  const b = boot();
  const text = mini('8001PART01', ['20260701', '20260702']).replace('900', `300,20260703,1,2,3,A,,,20260704010000,${CRLF}900`);
  const partial = await b.svc.ingestUpload({ fileName: 'partial.csv', bytes: bytes(text) });
  assert.equal(partial.status, 'Partial');
  assert.equal(partial.inserted, 96);                                        // the two good days only
  assert.ok(partial.report.issues.some(i => i.code === 'VALUE_COUNT' && i.sev === 'error' && i.line === 5));
  assert.ok(b.repo.list('Task').some(t => /Review NEM12 validation errors in partial.csv/.test(t.title)));
  const strict = await b.svc.ingestUpload({ fileName: 'strict.csv', bytes: bytes(text + ' '), strict: true });
  assert.equal(strict.status, 'Rejected');
  assert.equal(strict.inserted, 0);
  assert.equal(b.repo.get('MeterDataFile', strict.fileId).status, 'Rejected');
  assert.ok(b.rawStore.get(strict.fileId).content.startsWith('100,NEM12'));
  const headerless = await b.svc.ingestUpload({ fileName: 'nohdr.csv', bytes: bytes(mini().split(CRLF).slice(1).join(CRLF)) });
  assert.equal(headerless.status, 'Rejected');
  assert.equal(b.repo.count('IntervalReading'), 96);
});

test('standing data: closed tariffs cannot be newly assigned; history is append-only; NMI records are linked to sites', async () => {
  const { svc, repo } = await fixture();
  assert.throws(() => svc.setStanding('8001TEST01', { networkTariffCode: 'RT4' }), /closed/);
  assert.throws(() => svc.setStanding('8001TEST01', { networkTariffCode: 'RT99' }), /Unknown/);
  const n = svc.snapshots('8001TEST01').length;
  svc.setStanding('8001TEST01', { networkTariffCode: 'RT2', effectiveFrom: '2026-10-01', notes: 'test' });
  assert.equal(svc.snapshots('8001TEST01').length, n + 1);
  assert.equal(svc.standing('8001TEST01').networkTariffCode, 'RT2');
  assert.equal(svc.standingAsAt('8001TEST01', '2026-09-30').networkTariffCode, 'RT34');   // as-at lookup respects EffectiveFrom
  svc.setStanding('8001TEST01', { networkTariffCode: 'RT34', effectiveFrom: '2026-10-02', notes: 'revert' });
  assert.equal(svc.standing('8001TEST01').networkTariffCode, 'RT34');
  assert.equal(repo.get('Nmi', '8001TEST01').siteId, repo.find('Site', { name: 'Perth CBD office' }).siteId);
});

test('reference period and coverage use the last complete months of data', async () => {
  const { svc, sample } = await fixture();
  const ref = svc.referencePeriod('8001TEST01', 12);
  assert.equal(ref.to, sample.window.to);
  assert.equal(ref.from, '2025-10-01');                                      // 12 months; Sep 2025 is the MD lead-in month
  assert.equal(svc.referencePeriod('8001TEST01', 13).from, '2025-09-01');
  assert.equal(svc.referencePeriod('NOPE', 12), null);
  assert.deepEqual(J(svc.lastBillablePeriod()), { from: '2026-09-01', to: '2026-09-30' });
});

test('quote: 12 months through the engine at the quote-start rates; tariff comparison; RT6 wins for the 24/7 site', async () => {
  const { svc, repo } = await fixture();
  const cust = repo.find('Customer', { name: 'Demo Cold Storage Pty Ltd' });
  const q = svc.createQuote({ customerId: cust.customerId, offerId: svc.DEMO_OFFER, items: [{ nmi: '8001TEST02' }], startDate: '2026-11-01' });
  const it = q.items[0];
  assert.equal(it.ok, true, JSON.stringify(it.notices));
  assert.equal(it.tariffCode, 'RT6');
  assert.equal(it.referenceDays, 365);
  assert.equal(it.refFrom, '2025-10-01'); assert.equal(it.refTo, '2026-09-30');
  assert.equal(it.monthly.length, 12);
  assert.ok(it.lines.some(l => l.code === 'NET.DEMAND') && it.lines.some(l => l.code === 'RET.ENERGY.ON_PEAK'));
  assert.equal(it.subtotalCents, it.lines.reduce((s, l) => s + l.amountExGstCents, 0));
  assert.equal(it.gstCents, Math.round(it.subtotalCents * 0.1));
  assert.equal(q.totals.totalCents, it.subtotalCents + it.gstCents);
  assert.ok(it.usage.mdMax > 1000, 'the planted surge puts MD in the 1,000–1,500 kVA band: ' + it.usage.mdMax);
  assert.ok(it.notices.some(n => n.code === 'DEMAND_LENGTH_NOT_CALCULATED'));
  const cmp = Object.fromEntries(it.comparison.map(c => [c.tariffCode, c]));
  assert.ok(cmp.RT2.ok && cmp.RT34.ok && cmp.RT6.ok);
  assert.ok(cmp.RT6.subtotalCents < cmp.RT34.subtotalCents && cmp.RT6.subtotalCents < cmp.RT2.subtotalCents, JSON.stringify(Object.values(cmp).map(c => [c.tariffCode, c.subtotalCents])));
  assert.equal(cmp.RT6.subtotalCents, it.subtotalCents);                     // the quoted tariff's comparison row equals the quote
  assert.match(q.quoteNumber, /^Q-2026-\d{4}$/);
  // the office site: TOU beats flat for a daytime load
  const o = svc.createQuote({ customerId: repo.find('Customer', { name: 'Demo Office Co Pty Ltd' }).customerId, offerId: svc.DEMO_OFFER, items: [{ nmi: '8001TEST01' }], startDate: '2026-11-01' });
  assert.equal(o.items[0].ok, true);
  assert.ok(o.items[0].usage.mdMax < 300);
  // tariff override per site, as the quote builder does
  const alt = svc.quoteItem({ nmi: '8001TEST01', tariffCode: 'RT2', offerId: svc.DEMO_OFFER, startDate: '2026-11-01', compare: false });
  assert.equal(alt.tariffCode, 'RT2');
  assert.ok(alt.ok);
});

test('quote and bill share one pricing path: the same month priced both ways agrees to the cent', async () => {
  const { svc, repo, engine } = await fixture();
  const nmi = '8001TEST02', month = { from: '2026-09-01', to: '2026-09-30' };
  const ctx = svc.nmiContext(nmi), book = svc.loadBook();
  const profile = svc.loadProfile(nmi, svc.leadInStart(month.from), month.to, { assumedPf: ctx.siteParams.assumedPf });
  const direct = svc.priceWith({ book, profile, ctx, period: month, options: { rateAsAt: '2026-09-01' } });     // what a quote does for that month
  const run = svc.runBill({ from: month.from, to: month.to, nmis: [nmi], name: 'parity' });
  const inv = repo.get('Invoice', run.invoiceIds[0]);
  const fin = engine.finalise(direct, { gstRate: 0.1 });
  assert.equal(inv.subtotalCents, fin.subtotalCents);
  assert.equal(inv.gstCents, fin.gstCents);
  assert.equal(inv.totalCents, fin.totalCents);
  const lines = repo.list('InvoiceLine', { invoiceId: inv.invoiceId });
  assert.deepEqual(J(lines.map(l => l.amountExGstCents)), J(fin.lines.map(l => l.amountExGstCents)));
  assert.equal(lines.reduce((s, l) => s + l.amountExGstCents, 0), inv.subtotalCents);
  // and the quote's own monthly figure for September equals the engine's unrounded total
  const q = svc.quoteItem({ nmi, offerId: svc.DEMO_OFFER, startDate: '2026-09-01', compare: false, mdBasis: 'rolling' });
  const sepMonthly = q.monthly.find(m => m.from === '2026-09-01');
  approx(sepMonthly.totalCents, direct.totals.totalCents, 1e-6);
});

test('quote MD basis: "annual" applies the reference year\'s peak to every month; "rolling" (as billed) understates early months', async () => {
  const { svc } = await fixture();
  const annual = svc.quoteItem({ nmi: '8001TEST02', offerId: svc.DEMO_OFFER, startDate: '2026-11-01', compare: false, mdBasis: 'annual' });
  const rolling = svc.quoteItem({ nmi: '8001TEST02', offerId: svc.DEMO_OFFER, startDate: '2026-11-01', compare: false, mdBasis: 'rolling' });
  assert.equal(annual.mdBasis, 'annual');
  assert.equal(new Set(annual.monthly.map(m => m.md)).size, 1, 'one MD for all 12 months');
  approx(annual.monthly[0].md, annual.annualMd, 1e-9);
  approx(annual.usage.mdMax, annual.annualMd, 1e-9);
  assert.ok(new Set(rolling.monthly.map(m => m.md)).size > 1, 'rolling MD varies as the window slides');
  assert.ok(rolling.monthly[0].md < annual.annualMd, 'the first reference month only sees 1-2 months of history');
  assert.ok(annual.subtotalCents >= rolling.subtotalCents, 'annual basis is never lower than rolling for the same data');
  assert.ok(rolling.notices.some(n => n.code === 'MD_SHORT_HISTORY'), 'rolling basis warns that history is short');
  assert.ok(!annual.notices.some(n => n.code === 'MD_SHORT_HISTORY'));
  assert.ok(annual.notices.some(n => n.code === 'MD_FIXED'));
  // RT2/RT34 have no demand charge, so the MD basis cannot change their price
  const a2 = svc.quoteItem({ nmi: '8001TEST01', tariffCode: 'RT34', offerId: svc.DEMO_OFFER, startDate: '2026-11-01', compare: false, mdBasis: 'annual' });
  const r2 = svc.quoteItem({ nmi: '8001TEST01', tariffCode: 'RT34', offerId: svc.DEMO_OFFER, startDate: '2026-11-01', compare: false, mdBasis: 'rolling' });
  assert.equal(a2.subtotalCents, r2.subtotalCents);
});

test('bill run: draft invoices with lines, usage and notices; duplicates skipped; unpriceable months fail with reasons; issue assigns numbers', async () => {
  const { svc, repo } = await fixture();
  const before = repo.count('Invoice');
  const run = svc.runBill({ from: '2026-08-01', to: '2026-08-31', nmis: ['8001TEST01', '8001TEST02'] });
  assert.equal(run.invoiceIds.length, 2);
  assert.equal(run.failures.length, 0);
  const inv = repo.get('Invoice', run.invoiceIds[0]);
  assert.equal(inv.status, 'Draft');
  assert.equal(inv.invoiceNumber, null);
  assert.equal(inv.dataWatermark, repo.maxReadingId());
  assert.ok(inv.usage.kwhTotal > 0 && inv.customerSnapshot.name && inv.siteSnapshot.name);
  assert.ok(repo.list('InvoiceLine', { invoiceId: inv.invoiceId }).length >= 5);
  // second run of the same month: skipped, not double billed
  const again = svc.runBill({ from: '2026-08-01', to: '2026-08-31', nmis: ['8001TEST01'] });
  assert.equal(again.invoiceIds.length, 0);
  assert.match(again.skipped[0].reason, /Already billed/);
  // June 2026 predates the loaded price list: cannot be priced, and says why
  const june = svc.runBill({ from: '2026-06-01', to: '2026-06-30', nmis: ['8001TEST01'] });
  assert.equal(june.invoiceIds.length, 0);
  assert.equal(june.failures.length, 1);
  assert.match(june.failures[0].messages.join(' '), /No .* is effective on 1 Jun 2026/);
  assert.ok(repo.list('Task').some(t => t.title === 'Bill run could not price NMI 8001TEST01'));
  assert.equal(repo.count('Invoice'), before + 2);
  const issued = svc.issueInvoices(run.invoiceIds);
  assert.equal(issued.length, 2);
  assert.match(issued[0].invoiceNumber, /^INV-\d{6}$/);
  assert.notEqual(issued[0].invoiceNumber, issued[1].invoiceNumber);
  assert.equal(issued[0].dueDate, require('./util-addDays')(issued[0].issueDate, 14));
  assert.equal(svc.issueInvoices(run.invoiceIds).length, 0, 'already issued: not re-issued');
  assert.equal(svc.voidInvoice(issued[0].invoiceId, 'test').status, 'Void');
});

test('voiding an invoice frees the NMI to be billed again for that period; only drafts can be recalculated', async () => {
  const { svc, repo } = await fixture();
  const first = svc.runBill({ from: '2026-07-01', to: '2026-07-31', nmis: ['8001TEST01'] });
  assert.equal(first.invoiceIds.length, 1);
  assert.equal(svc.runBill({ from: '2026-07-01', to: '2026-07-31', nmis: ['8001TEST01'] }).invoiceIds.length, 0, 'blocked while a live invoice exists');
  svc.voidInvoice(first.invoiceIds[0], 'wrong tariff');
  assert.equal(repo.get('Invoice', first.invoiceIds[0]).status, 'Void');
  assert.equal(repo.get('Invoice', first.invoiceIds[0]).voidReason, 'wrong tariff');
  const again = svc.runBill({ from: '2026-07-01', to: '2026-07-31', nmis: ['8001TEST01'] });
  assert.equal(again.invoiceIds.length, 1, 're-billed after the void');
  assert.equal(repo.list('InvoiceLine', { invoiceId: first.invoiceIds[0] }).length > 0, true, 'a voided invoice keeps its lines');
  // a billed-twice override is explicit
  assert.equal(svc.runBill({ from: '2026-07-01', to: '2026-07-31', nmis: ['8001TEST01'], includeBilled: true }).invoiceIds.length, 1);
  // quotes: only drafts recalc; recalculation picks up changed settings
  const cust = repo.find('Customer', { name: 'Demo Office Co Pty Ltd' });
  const q = svc.createQuote({ customerId: cust.customerId, offerId: svc.DEMO_OFFER, items: [{ nmi: '8001TEST01' }], startDate: '2026-11-01', compare: false });
  const before = q.totals.subtotalCents;
  svc.saveSetting('gstRate', 0.15);
  const re = svc.recalcQuote(q.quoteId);
  assert.equal(re.totals.subtotalCents, before, 'ex-GST price unchanged');
  assert.ok(re.totals.gstCents > Math.round(before * 0.14), 'GST now at 15%');
  svc.saveSetting('gstRate', 0.1);
  svc.setQuoteStatus(q.quoteId, 'Issued');
  assert.throws(() => svc.recalcQuote(q.quoteId), /Only draft/);
});

test('bill run refuses an NMI that has no site / no offer, and a failing NMI does not stop the others', async () => {
  const b = await fixture();
  b.repo.insert('Nmi', { nmi: '8001ORPH01', siteId: null, status: 'Discovered' });
  const run = b.svc.runBill({ from: '2026-07-01', to: '2026-07-31', nmis: ['8001ORPH01', '8001TEST01'], includeBilled: true });   // includeBilled: independent of earlier tests
  assert.equal(run.failures.length, 1);
  assert.match(run.failures[0].messages[0], /not assigned to a customer site/);
  assert.equal(run.invoiceIds.length, 1);
});

test('versioning: a corrected file revises intervals; invoices calculated earlier report the revision; time travel by watermark', async () => {
  const b = await fixture();
  const { svc, repo } = b;
  // an invoice for Sep 2026 exists from the parity test (watermark = before revision); issue a fresh bill for another NMI/month first
  const inv = repo.list('Invoice', i => i.nmi === '8001TEST01' && i.periodFrom === '2026-09-01')[0] || repo.get('Invoice', svc.runBill({ from: '2026-09-01', to: '2026-09-30', nmis: ['8001TEST01'] }).invoiceIds[0]);
  assert.equal(svc.revisedSinceBilling(inv).intervals, 0);
  const rowsBefore = repo.count('IntervalReading');
  const rev = await svc.loadSampleRevision();
  assert.ok(rev.results.every(r => r.status === 'Accepted'), JSON.stringify(rev.results.map(r => [r.status, r.report && r.report.issues.slice(0, 2)])));
  assert.ok(repo.count('IntervalReading') > rowsBefore);                     // appended, nothing overwritten
  const revised = svc.revisedSinceBilling(inv);
  assert.ok(revised.intervals >= 2 * 48, 'the two forward-estimate days at the end of September were corrected: ' + revised.intervals);
  const quality = repo.currentIntervals('8001TEST01', 'E1', '2026-09-29', '2026-09-30').map(r => r.quality);
  assert.ok(quality.every(q => q === 'A'));
  const then = repo.currentIntervals('8001TEST01', 'E1', '2026-09-29', '2026-09-30', { maxId: inv.dataWatermark }).map(r => r.quality);
  assert.ok(then.every(q => q === 'E'));                                     // the data as it was when the invoice was calculated
  // a re-priced month differs from the invoice only by the revision
  const ctx = svc.nmiContext('8001TEST01');
  const profileNow = svc.loadProfile('8001TEST01', svc.leadInStart('2026-09-01'), '2026-09-30');
  const profileThen = svc.loadProfile('8001TEST01', svc.leadInStart('2026-09-01'), '2026-09-30', { maxId: inv.dataWatermark });
  const book = svc.loadBook();
  const now = svc.priceWith({ book, profile: profileNow, ctx, period: { from: '2026-09-01', to: '2026-09-30' } });
  const then2 = svc.priceWith({ book, profile: profileThen, ctx, period: { from: '2026-09-01', to: '2026-09-30' } });
  assert.notEqual(Math.round(now.totals.totalCents), Math.round(then2.totals.totalCents));
  const fin = b.engine.finalise(then2, { gstRate: 0.1 });
  assert.equal(fin.subtotalCents, inv.subtotalCents, 'pricing the data as it was reproduces the invoice exactly');
});

test('market transactions create their follow-up tasks; status history is kept', async () => {
  const { svc, repo } = await fixture();
  const t = svc.createMarketTransaction({ type: 'Customer transfer request', nmi: '8001TEST01', proposedDate: '2026-11-01' });
  assert.equal(t.status, 'Draft');
  assert.equal(repo.list('Task', x => x.relatedId === t.txnId).length, 3);
  const adv = svc.advanceMarketTransaction(t.txnId, 'Submitted', 'sent');
  assert.equal(adv.status, 'Submitted');
  assert.equal(adv.history.length, 2);
});
