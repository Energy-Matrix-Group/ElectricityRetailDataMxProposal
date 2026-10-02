const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeContext, ev, CORE } = require('./harness');

const boot = (opts = {}) => {
  const ctx = makeContext({ files: CORE, ...opts });
  return { ctx, util: ev(ctx, 'util'), storage: ev(ctx, 'storage'), rawStore: ev(ctx, 'rawStore'), repo: ev(ctx, 'repo') };
};
// plain-JSON view (vm contexts have their own Array/Object prototypes, so compare via JSON)
const J = x => JSON.parse(JSON.stringify(x));

test('util: calendar arithmetic is timezone-free and correct', () => {
  const { util } = boot();
  assert.equal(util.dow('2026-10-02'), 5);                 // Friday
  assert.equal(util.dow('2026-09-28'), 1);                 // Monday (King's Birthday 2026)
  assert.equal(util.dow('1970-01-01'), 4);                 // Thursday
  assert.equal(util.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(util.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(util.addMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(util.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(util.addMonths('2026-03-15', -12), '2025-03-15');
  assert.equal(util.monthEnd('2026-02-10'), '2026-02-28');
  assert.equal(util.monthEnd('2028-02-10'), '2028-02-29');
  assert.equal(util.daysBetween('2026-07-01', '2027-06-30'), 364);
  assert.equal(util.dateRange('2026-06-29', '2026-07-02').length, 4);
  assert.equal(util.isIsoDate('2026-02-30'), false);
  assert.equal(util.isIsoDate('2026-02-28'), true);
  assert.equal(util.parseCCYYMMDD('20260231'), null);
  assert.equal(util.parseCCYYMMDD('20260228'), '2026-02-28');
  assert.equal(util.parseDT14('20260228235959').hh, 23);
  assert.equal(util.parseDT14('20260228246000'), null);
  assert.equal(util.parseDT12('202602282359').mm, 59);
  assert.equal(util.hhmmToMin('24:00'), 1440);
  assert.equal(util.hhmmToMin('25:00'), null);
  assert.equal(util.minToHHMM(930), '15:30');
});

test('util: UOM normalisation covers Wh/kWh/MWh/varh/kvarh/Mvarh without float noise', () => {
  const { util } = boot();
  const n = (raw, u) => util.normaliseValue(raw, util.uomInfo(u).factor);
  assert.equal(n(123, 'Wh'), 0.123);
  assert.equal(n(1.5, 'kWh'), 1.5);
  assert.equal(n(0.0123, 'MWh'), 12.3);
  assert.equal(n(250, 'varh'), 0.25);
  assert.equal(n(2, 'KVARH'), 2);
  assert.equal(n(0.001, 'Mvarh'), 1);
  assert.equal(util.uomInfo('kvarh').unit, 'kvarh');
  assert.equal(util.uomInfo('MWh').unit, 'kWh');
  assert.equal(util.uomInfo('kW'), null);
});

test('util: sha256 matches node crypto for many lengths (padding edge cases)', () => {
  const { util } = boot();
  for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100003]) {
    const buf = crypto.randomBytes(len);
    assert.equal(util.sha256Hex(new Uint8Array(buf)), crypto.createHash('sha256').update(buf).digest('hex'), 'len ' + len);
  }
  assert.equal(util.sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('util: csv round trip with quotes, commas and newlines', () => {
  const { util } = boot();
  const rows = [['a', 'b,c', 'd"e'], ['1', 'line1\nline2', ''], ['x', '', 'y']];
  assert.deepEqual(J(util.csvParse(util.csvStringify(rows))), rows);
  assert.deepEqual(J(util.csvParse('﻿a,b\r\n1,2\r\n')), [['a', 'b'], ['1', '2']]);
});

test('util: rounding is half-away-from-zero and tolerant of float noise', () => {
  const { util } = boot();
  assert.equal(util.roundCents(2.5), 3);
  assert.equal(util.roundCents(-2.5), -3);
  assert.equal(util.roundCents(1.005 * 100), 101);   // 100.49999999999999 in binary
  assert.equal(util.roundCents(7752.325), 7752);
  assert.equal(util.fmtMoney(1234.5), '$1,234.50');
  assert.equal(util.fmtMoney(-12.345, 2), '-$12.35');
  assert.equal(util.fmtMoney(-0.001, 2), '$0.00');
});

test('rawStore: keeps files unchanged, write-once, text vs binary encoding, integrity check', () => {
  const { util, rawStore } = boot();
  const csv = util.utf8Bytes('100,NEM12,202601010000,A,B\r\n900\r\n');
  const m = rawStore.put({ fileName: 'a.csv', bytes: csv });
  assert.equal(m.encoding, 'utf8');
  assert.equal(m.sha256, crypto.createHash('sha256').update(Buffer.from(csv)).digest('hex'));
  assert.equal(rawStore.get(m.fileId).content, '100,NEM12,202601010000,A,B\r\n900\r\n');   // CRLF preserved
  const zipLike = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
  const z = rawStore.put({ fileName: 'a.zip', bytes: zipLike });
  assert.equal(z.encoding, 'base64');
  assert.deepEqual(Array.from(rawStore.getBytes(z.fileId)), Array.from(zipLike));
  assert.equal(rawStore.verify(z.fileId), true);
  assert.throws(() => rawStore.update(), /write-once/);
  assert.throws(() => rawStore.remove(), /write-once/);
  assert.equal(rawStore.list().length, 2);
  assert.equal(rawStore.findBySha(m.sha256).length, 1);
});

test('rawStore: survives reload from storage and stores nothing when quota is exceeded', () => {
  const store = new Map();
  let b = boot({ store });
  const m = b.rawStore.put({ fileName: 'a.csv', bytes: b.util.utf8Bytes('hello') });
  b = boot({ store });   // fresh context, same storage
  assert.equal(b.rawStore.list().length, 1);
  assert.equal(b.rawStore.get(m.fileId).content, 'hello');
  const small = boot({ quotaChars: 400 });
  assert.throws(() => small.rawStore.put({ fileName: 'big.csv', bytes: small.util.utf8Bytes('x'.repeat(1000)) }), e => e.name === 'StorageError' && e.quota === true);
  assert.equal(small.rawStore.list().length, 0);
  assert.equal(small.storage.keys('raw.c.').length, 0);   // nothing half-written
});

test('storage: falls back to memory when localStorage is blocked', () => {
  const { storage, rawStore, util } = boot({ noStorage: true });
  assert.equal(storage.mode, 'memory');
  const m = rawStore.put({ fileName: 'x.csv', bytes: util.utf8Bytes('abc') });
  assert.equal(rawStore.get(m.fileId).content, 'abc');
});

test('repo: CRUD, key generation, frozen rows, timestamps, immutability rules', () => {
  const { repo } = boot();
  const c = repo.insert('Customer', { name: 'Acme' });
  assert.match(c.customerId, /^C-/);
  assert.equal(repo.get('Customer', c.customerId).name, 'Acme');
  assert.throws(() => { 'use strict'; repo.get('Customer', c.customerId).name = 'x'; }, TypeError);
  const u = repo.update('Customer', c.customerId, { name: 'Acme 2', abn: '1' });
  assert.equal(u.name, 'Acme 2');
  assert.equal(u.createdAt, c.createdAt);
  assert.throws(() => repo.insert('Nmi', { nmi: 'X' }) && repo.insert('Nmi', { nmi: 'X' }), /duplicate key/);
  assert.equal(repo.list('Site', { customerId: 'nope' }).length, 0);
  assert.equal(repo.remove('Customer', c.customerId), true);
  assert.equal(repo.count('Customer'), 0);
  assert.throws(() => repo.update('StandingDataSnapshot', 'x', {}), /append-only/);
  assert.throws(() => repo.remove('IntervalReading', 1), /append-only/);
  assert.throws(() => repo.insert('IntervalReading', {}), /insertReadings/);
  assert.throws(() => repo.list('Nope'), /Unknown table/);
});

test('repo: the 18 required tables exist', () => {
  const { repo } = boot();
  for (const t of ['Customer', 'Site', 'Nmi', 'StandingDataSnapshot', 'MeterDataFile', 'IntervalReading', 'NetworkTariff', 'TariffComponent', 'TimeBand', 'Rate', 'PublicHoliday', 'RetailOffer', 'Quote', 'BillRun', 'Invoice', 'InvoiceLine', 'MarketTransaction', 'Task']) {
    assert.ok(repo.TABLES[t], t);
    assert.equal(typeof repo.count(t), 'number');
  }
});

test('repo: atomic() rolls back every touched table when a later step fails', () => {
  const { repo } = boot();
  repo.insert('Customer', { customerId: 'C1', name: 'keep' });
  assert.throws(() => repo.atomic(() => {
    repo.insert('Customer', { customerId: 'C2', name: 'temp' });
    repo.update('Customer', 'C1', { name: 'changed' });
    repo.insert('Invoice', { invoiceId: 'I1' });
    repo.nextSeq('invoice');
    throw new Error('boom');
  }), /boom/);
  assert.equal(repo.count('Customer'), 1);
  assert.equal(repo.get('Customer', 'C1').name, 'keep');
  assert.equal(repo.count('Invoice'), 0);
  assert.equal(repo.nextSeq('invoice'), 1);   // counter rolled back too
});

test('repo: ordinary-table writes persist, and are rolled back when the quota is hit', () => {
  const store = new Map();
  let b = boot({ store });
  b.repo.insert('Customer', { customerId: 'C1', name: 'Persisted' });
  b = boot({ store });
  assert.equal(b.repo.get('Customer', 'C1').name, 'Persisted');
  const tiny = boot({ quotaChars: 300 });
  assert.throws(() => tiny.repo.insert('Customer', { customerId: 'C1', name: 'x'.repeat(500) }), e => e.name === 'StorageError');
  assert.equal(tiny.repo.count('Customer'), 0);   // memory matches storage: no phantom row
});

// ---- interval readings ------------------------------------------------------------------------------
const row = (o) => ({
  nmi: '8001TEST01', suffix: 'E1', registerId: '1', meterSerial: 'SN1', intervalDate: '2026-07-01', intervalNo: 1, intervalLength: 30,
  startMinute: 0, uom: 'kWh', unit: 'kWh', rawValue: 1, value: 1, quality: 'A', method: '', reasonCode: '', reasonDescription: '',
  updateDateTime: '20260702010000', msatsLoadDateTime: '', sourceFileId: 'F-1', sourceLine: 3, ...o,
});
const day = (date, upd, fileId, values, extra = {}) => values.map((v, i) => row({ intervalDate: date, intervalNo: i + 1, startMinute: i * 30, rawValue: v, value: v, updateDateTime: upd, sourceFileId: fileId, ...extra }));

test('repo.currentIntervals: latest UpdateDateTime wins per interval; nothing is ever overwritten', () => {
  const { repo } = boot();
  const v48 = n => Array(48).fill(n);
  const first = repo.insertReadings(day('2026-07-01', '20260702010000', 'F-1', v48(1)));
  assert.equal(first.inserted, 48);
  // revision file re-sends the same day with later UpdateDateTime; only intervals 5..6 differ in value
  const rev = v48(1); rev[4] = 9; rev[5] = 8;
  repo.insertReadings(day('2026-07-01', '20260705090000', 'F-2', rev, { quality: 'A' }));
  assert.equal(repo.count('IntervalReading'), 96);   // both versions are kept
  const cur = repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01');
  assert.equal(cur.length, 48);
  assert.equal(cur[4].value, 9);
  assert.equal(cur[5].value, 8);
  assert.equal(cur[0].sourceFileId, 'F-2');
  // watermark: as known after the first file only
  const old = repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01', { maxId: first.lastId });
  assert.equal(old[4].value, 1);
  // as-at an UpdateDateTime between the two versions
  const asAt = repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01', { asAt: '20260703000000' });
  assert.equal(asAt[4].value, 1);
  // an OLDER UpdateDateTime loaded LATER must not win
  repo.insertReadings(day('2026-07-01', '20260701120000', 'F-3', v48(77)));
  assert.equal(repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01')[0].value, 1);
  // equal UpdateDateTime: later load wins
  repo.insertReadings(day('2026-07-02', '20260703000000', 'F-4', v48(2)));
  repo.insertReadings(day('2026-07-02', '20260703000000', 'F-5', v48(3)));
  assert.equal(repo.currentIntervals('8001TEST01', 'E1', '2026-07-02', '2026-07-02')[10].value, 3);
  assert.equal(repo.readingVersions('8001TEST01', 'E1', '2026-07-01').filter(r => r.intervalNo === 5).length, 3);
});

test('repo.currentIntervals: ranges, other streams and rows are isolated; rows are frozen', () => {
  const { repo } = boot();
  repo.insertReadings([...day('2026-07-01', '20260702010000', 'F-1', Array(48).fill(1)), ...day('2026-07-03', '20260704010000', 'F-1', Array(48).fill(3)),
    ...day('2026-07-01', '20260702010000', 'F-1', Array(48).fill(5), { suffix: 'Q1', uom: 'kvarh', unit: 'kvarh' })]);
  assert.equal(repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-03').length, 96);   // 07-02 has no rows
  assert.equal(repo.currentIntervals('8001TEST01', 'E1', '2026-07-02', '2026-07-02').length, 0);
  assert.equal(repo.currentIntervals('8001TEST01', 'Q1', '2026-07-01', '2026-07-03').length, 48);
  assert.equal(repo.currentIntervals('NOPE', 'E1', '2026-07-01', '2026-07-03').length, 0);
  const r = repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01')[0];
  assert.throws(() => { 'use strict'; r.value = 99; }, TypeError);
});

test('repo.currentIntervals: if the winning version changes interval length, older-length rows are ignored', () => {
  const { repo } = boot();
  repo.insertReadings(day('2026-07-01', '20260702010000', 'F-1', Array(48).fill(1)));
  const fifteen = Array.from({ length: 96 }, (_, i) => row({ intervalDate: '2026-07-01', intervalNo: i + 1, intervalLength: 15, startMinute: i * 15, rawValue: 0.5, value: 0.5, updateDateTime: '20260709000000', sourceFileId: 'F-2' }));
  repo.insertReadings(fifteen);
  const cur = repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01');
  assert.equal(cur.length, 96);
  assert.ok(cur.every(r => r.intervalLength === 15));
});

test('repo: interval data persists in packed form and reloads identically (incl. quality runs, methods, ids)', () => {
  const store = new Map();
  let b = boot({ store });
  const vals = Array.from({ length: 48 }, (_, i) => +(i * 0.0125).toFixed(4));
  const rows = day('2026-07-01', '20260702010000', 'F-1', vals);
  rows.forEach((r, i) => { if (i >= 10 && i < 20) Object.assign(r, { quality: 'S', method: '14', reasonCode: '0', reasonDescription: 'Like day' }); if (i >= 30 && i < 34) Object.assign(r, { quality: 'N', value: 0, rawValue: 0 }); });
  const res = b.repo.insertReadings(rows);
  const maxBefore = b.repo.maxReadingId();
  assert.equal(res.lastId, 48);
  const before = J(b.repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01'));
  b = boot({ store });
  const after = J(b.repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01'));
  assert.deepEqual(after, before);
  assert.equal(b.repo.maxReadingId(), maxBefore);
  assert.equal(after[12].quality, 'S');
  assert.equal(after[12].method, '14');
  assert.equal(after[31].quality, 'N');
  assert.equal(after[0].quality, 'A');
  // ids continue after reload
  const more = b.repo.insertReadings(day('2026-07-02', '20260703010000', 'F-2', Array(48).fill(1)));
  assert.equal(more.firstId, maxBefore + 1);
  // packed form is compact: far below the row-per-interval JSON size
  const chunk = store.get('erp1.iv.F-1');
  assert.ok(chunk.length < 1500, 'chunk chars ' + chunk.length);
});

test('repo: packed storage handles non-contiguous interval numbers and normalised units', () => {
  const store = new Map();
  let b = boot({ store });
  const rs = [1, 2, 3, 7, 8].map(n => row({ intervalNo: n, startMinute: (n - 1) * 30, rawValue: n * 100, value: n * 0.1, uom: 'Wh' }));
  b.repo.insertReadings(rs);
  b = boot({ store });
  const cur = b.repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01');
  assert.deepEqual(J(cur.map(r => r.intervalNo)), [1, 2, 3, 7, 8]);
  assert.deepEqual(J(cur.map(r => r.value)), [0.1, 0.2, 0.3, 0.7, 0.8]);
});

test('repo.insertReadings: quota failure leaves memory and storage unchanged', () => {
  const b = boot({ quotaChars: 2500 });
  const ok = b.repo.insertReadings(day('2026-07-01', '20260702010000', 'F-1', Array(48).fill(1)));
  assert.equal(ok.inserted, 48);
  const countBefore = b.repo.count('IntervalReading');
  const many = [];
  for (let d = 2; d < 20; d++) many.push(...day('2026-07-' + String(d).padStart(2, '0'), '20260802010000', 'F-2', Array.from({ length: 48 }, (_, i) => i / 7)));
  assert.throws(() => b.repo.insertReadings(many), e => e.name === 'StorageError' && e.quota);
  assert.equal(b.repo.count('IntervalReading'), countBefore);
  assert.equal(b.storage.keys('iv.F-2').length, 0);
  assert.equal(b.repo.currentIntervals('8001TEST01', 'E1', '2026-07-02', '2026-07-19').length, 0);
});

test('repo.intervalStreams summarises current rows, versions and quality', () => {
  const { repo } = boot();
  repo.insertReadings(day('2026-07-01', '20260702010000', 'F-1', Array(48).fill(1)));
  repo.insertReadings(day('2026-07-01', '20260709010000', 'F-2', Array(48).fill(2), { quality: 'S' }));
  const [s] = repo.intervalStreams();
  assert.equal(s.nmi, '8001TEST01');
  assert.equal(s.rowsTotal, 96);
  assert.equal(s.rowsCurrent, 48);
  assert.equal(s.quality.S, 48);
  assert.equal(s.firstDate, '2026-07-01');
});

test('repo: export -> reset -> import restores everything (tables, intervals, raw files, counters)', () => {
  const store = new Map();
  let b = boot({ store });
  b.repo.insert('Customer', { customerId: 'C1', name: 'Acme' });
  const f = b.rawStore.put({ fileName: 'a.csv', bytes: b.util.utf8Bytes('100,NEM12\r\n900\r\n') });
  b.repo.insertReadings(day('2026-07-01', '20260702010000', f.fileId, Array.from({ length: 48 }, (_, i) => i)));
  b.repo.nextSeq('quote');
  const json = b.repo.exportJson();
  const doc = JSON.parse(json);
  assert.equal(doc.format, 'electricity-retail-prototype-backup');
  assert.deepEqual(J(b.repo.exportAll().tables), J(doc.tables));
  b.repo.resetAll();
  assert.equal(b.repo.count('Customer'), 0);
  assert.equal(b.repo.count('IntervalReading'), 0);
  assert.equal(b.rawStore.list().length, 0);
  b.repo.importAll(doc);
  assert.equal(b.repo.get('Customer', 'C1').name, 'Acme');
  assert.equal(b.repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01')[47].value, 47);
  assert.equal(b.rawStore.get(f.fileId).content, '100,NEM12\r\n900\r\n');
  assert.equal(b.rawStore.verify(f.fileId), true);
  assert.equal(b.repo.nextSeq('quote'), 2);
  // and it is really in storage
  b = boot({ store });
  assert.equal(b.repo.count('IntervalReading'), 48);
});

test('repo.importAll: rejects foreign files and rolls back completely when storage is too small', () => {
  const big = boot();
  big.repo.insert('Customer', { customerId: 'C1', name: 'x'.repeat(2000) });
  const doc = JSON.parse(big.repo.exportJson());
  const store = new Map();
  const small = boot({ store, quotaChars: 1500 });
  small.repo.insert('Customer', { customerId: 'KEEP', name: 'still here' });
  assert.throws(() => small.repo.importAll({ nope: 1 }), /Not a backup/);
  assert.throws(() => small.repo.importAll({ ...doc, schemaVersion: 99 }), /newer/);
  assert.throws(() => small.repo.importAll(doc), e => e.name === 'StorageError');
  assert.equal(small.repo.get('Customer', 'KEEP').name, 'still here');   // old data restored
  assert.equal(small.repo.get('Customer', 'C1'), null);
});
