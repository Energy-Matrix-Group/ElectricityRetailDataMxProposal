const test = require('node:test');
const assert = require('node:assert/strict');
const { makeContext, ev, CORE } = require('./harness');

const FILES = [...CORE, '40-nem12.js', '41-nem12-sample.js'];
const boot = () => {
  const ctx = makeContext({ files: FILES });
  return { ctx, util: ev(ctx, 'util'), nem12: ev(ctx, 'nem12'), repo: ev(ctx, 'repo'), rawStore: ev(ctx, 'rawStore') };
};
const J = x => JSON.parse(JSON.stringify(x));

// ---- tiny NEM12 builders -----------------------------------------------------------------------------------------
const CRLF = '\r\n';
const vals = (n, v = 1) => Array(n).fill(v);
const header = (extra = '') => `100,NEM12,202607021200,MDP01,RETAIL1${extra}`;
const b200 = (o = {}) => ['200', o.nmi ?? '8001TEST01', o.config ?? 'E1Q1', o.reg ?? '1', o.suffix ?? 'E1', o.mdm ?? 'N1', o.serial ?? 'SN1', o.uom ?? 'kWh', o.il ?? '30', o.next ?? '20260801'].join(',');
const b300 = (date, values, q = 'A', rc = '', rd = '', upd = '20260702010000', load = '20260702011000') => ['300', date, ...values, q, rc, rd, upd, load].join(',');
const file = (...lines) => lines.join(CRLF) + CRLF;
const codes = r => r.issues.map(i => i.code);
const has = (r, code, sev) => r.issues.some(i => i.code === code && (!sev || i.sev === sev));

test('valid file: parses, no issues, rows follow the interval-ending convention', () => {
  const { nem12 } = boot();
  const txt = file(header(), b200(), b300('20260701', vals(48, 0.5)), b300('20260702', vals(48, 0.25)), '900');
  const r = nem12.parse(txt);
  assert.equal(r.fatal, false);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].N, 48);
  const rows = nem12.toReadingRows(r, 'F-1');
  assert.equal(rows.length, 96);
  assert.equal(rows[0].intervalDate, '2026-07-01');
  assert.equal(rows[0].intervalNo, 1);
  assert.equal(rows[0].startMinute, 0);            // interval 1 = 00:00-00:30 (the period ENDING 00:30)
  assert.equal(rows[12].startMinute, 360);         // interval 13 starts 06:00
  assert.equal(rows[47].startMinute, 1410);        // interval 48 = 23:30-00:00 (ends 00:00 next day)
  assert.equal(rows[47].intervalNo, 48);
  assert.equal(rows[0].sourceFileId, 'F-1');
  assert.equal(rows[0].updateDateTime, '20260702010000');
  assert.equal(rows[0].quality, 'A');
  assert.equal(rows[0].sourceLine, 3);
  const rep = nem12.buildReport(r);
  assert.equal(rep.status, 'Accepted');
  assert.equal(rep.streams[0].days, 2);
  assert.equal(rep.streams[0].intervals, 96);
  assert.equal(rep.counts[100] + rep.counts[200] + rep.counts[300] + rep.counts[900], 5);
});

test('interval length is read from the 200 record: 15-min => 96 values, 5-min => 288, 1-min => 1440', () => {
  const { nem12 } = boot();
  for (const [il, n] of [[15, 96], [5, 288], [1, 1440], [30, 48]]) {
    const r = nem12.parse(file(header(), b200({ il: String(il) }), b300('20260701', vals(n)), '900'));
    assert.equal(r.issues.length, 0, `il ${il}: ` + JSON.stringify(r.issues));
    assert.equal(r.blocks[0].N, n);
    const rows = nem12.toReadingRows(r, 'F');
    assert.equal(rows.length, n);
    assert.equal(rows[n - 1].startMinute, 1440 - il);
  }
  // 48 values on a 15-minute stream is a count error that names both numbers
  const bad = nem12.parse(file(header(), b200({ il: '15' }), b300('20260701', vals(48)), '900'));
  assert.ok(has(bad, 'VALUE_COUNT', 'error'));
  assert.match(bad.issues.find(i => i.code === 'VALUE_COUNT').msg, /96.*48/);
  assert.equal(nem12.toReadingRows(bad, 'F').length, 0);
  // unsupported lengths
  assert.ok(has(nem12.parse(file(header(), b200({ il: '7' }), b300('20260701', vals(48)), '900')), 'INTERVAL_LENGTH', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200({ il: 'x' }), b300('20260701', vals(48)), '900')), 'INTERVAL_LENGTH', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200({ il: '20' }), b300('20260701', vals(72)), '900')), 'INTERVAL_LENGTH_UNUSUAL', 'warning'));
});

test('value count vs IntervalLength: 47 and 49 values are errors, the day is not ingested', () => {
  const { nem12 } = boot();
  for (const n of [47, 49, 0]) {
    const r = nem12.parse(file(header(), b200(), b300('20260701', vals(n)), b300('20260702', vals(48)), '900'));
    assert.ok(has(r, 'VALUE_COUNT', 'error') || has(r, 'QUALITY_MISSING', 'error'), 'n=' + n);
    assert.equal(nem12.toReadingRows(r, 'F').length, 48, 'only the good day is ingested (n=' + n + ')');
    assert.equal(nem12.buildReport(r).status, 'Partial');
  }
});

test('UOM normalisation to kWh / kvarh', () => {
  const { nem12 } = boot();
  const cases = [['Wh', 123, 0.123, 'kWh'], ['kWh', 1.5, 1.5, 'kWh'], ['MWh', 0.0123, 12.3, 'kWh'], ['varh', 250, 0.25, 'kvarh'], ['kvarh', 2, 2, 'kvarh'], ['Mvarh', 0.001, 1, 'kvarh']];
  for (const [uom, raw, expect, unit] of cases) {
    const r = nem12.parse(file(header(), b200({ uom, suffix: uom.toLowerCase().includes('var') ? 'Q1' : 'E1' }), b300('20260701', vals(48, raw)), '900'));
    const rows = nem12.toReadingRows(r, 'F');
    assert.equal(rows[0].value, expect, uom);
    assert.equal(rows[0].rawValue, raw);
    assert.equal(rows[0].unit, unit);
    assert.equal(rows[0].uom, uom);
  }
  const bad = nem12.parse(file(header(), b200({ uom: 'kW' }), b300('20260701', vals(48)), '900'));
  assert.ok(has(bad, 'UOM_UNSUPPORTED', 'error'));
  assert.equal(bad.issueTotals.error >= 1, true);
  assert.ok(has(nem12.parse(file(header(), b200({ uom: 'kvarh', suffix: 'E1' }), b300('20260701', vals(48)), '900')), 'UOM_SUFFIX_MISMATCH', 'warning'));
});

test('datastream suffixes: E consumption, B export, Q/K reactive; unknown suffix warns', () => {
  const { nem12 } = boot();
  assert.equal(nem12.kindOfSuffix('E1'), 'consumption');
  assert.equal(nem12.kindOfSuffix('E2'), 'consumption');
  assert.equal(nem12.kindOfSuffix('B1'), 'export');
  assert.equal(nem12.kindOfSuffix('Q1'), 'reactive');
  assert.equal(nem12.kindOfSuffix('K1'), 'reactive');
  assert.equal(nem12.kindOfSuffix('X1'), 'other');
  const r = nem12.parse(file(header(), b200({ suffix: 'X1', config: 'X1' }), b300('20260701', vals(48)), '900'));
  assert.ok(has(r, 'SUFFIX_UNKNOWN', 'warning'));
  assert.equal(nem12.toReadingRows(r, 'F').length, 48);                 // stored anyway
  assert.ok(has(nem12.parse(file(header(), b200({ suffix: 'E9', config: 'E1' }), b300('20260701', vals(48)), '900')), 'SUFFIX_NOT_IN_CONFIG', 'warning'));
  assert.ok(has(nem12.parse(file(header(), b200({ suffix: '' }), b300('20260701', vals(48)), '900')), 'SUFFIX_INVALID', 'error'));
});

test('quality flags: A E F S N accepted; unknown flag is an error; methods are kept', () => {
  const { nem12 } = boot();
  for (const q of ['A', 'E52', 'F14', 'S14', 'N']) {
    const r = nem12.parse(file(header(), b200(), b300('20260701', vals(48, q === 'N' ? 0 : 1), q, '0', 'reason'), '900'));
    assert.equal(r.issues.length, 0, q + ' ' + JSON.stringify(r.issues));
    const row = nem12.toReadingRows(r, 'F')[0];
    assert.equal(row.quality, q[0]);
    assert.equal(row.method, q.slice(1));
  }
  const x = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'X'), b300('20260702', vals(48), 'a'), '900'));
  assert.equal(x.issues.filter(i => i.code === 'UNKNOWN_FLAG' && i.sev === 'error').length, 2);
  assert.equal(nem12.toReadingRows(x, 'F').length, 0);
  assert.equal(nem12.buildReport(x).status, 'Rejected');
  // N with non-zero values is suspicious
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48, 3), 'N'), '900')), 'N_NONZERO', 'warning'));
  // S without a reason code
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'S14', '', ''), '900')), 'REASON_MISSING', 'warning'));
});

test('quality V: per-interval flags come from 400 records that must cover the day with no gaps', () => {
  const { nem12 } = boot();
  const good = nem12.parse(file(header(), b200(), b300('20260701', vals(48, 1), 'V'), '400,1,14,A,,', '400,15,26,N,0,Comms failure', '400,27,48,S14,0,Like day', '900'));
  assert.equal(good.issues.length, 0, JSON.stringify(good.issues));
  const rows = nem12.toReadingRows(good, 'F');
  assert.equal(rows.length, 48);
  assert.equal(rows[0].quality, 'A');
  assert.equal(rows[13].quality, 'A');
  assert.equal(rows[14].quality, 'N');
  assert.equal(rows[25].quality, 'N');
  assert.equal(rows[26].quality, 'S');
  assert.equal(rows[26].method, '14');
  assert.equal(rows[26].reasonDescription, 'Like day');
  assert.equal(rows[47].quality, 'S');

  const gap = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,1,10,A,,', '400,20,48,A,,', '900'));
  const gi = gap.issues.find(i => i.code === 'V_COVERAGE_GAP');
  assert.ok(gi && gi.sev === 'error');
  assert.match(gi.msg, /11–19/);
  assert.equal(nem12.toReadingRows(gap, 'F').length, 0);

  const overlap = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,1,30,A,,', '400,25,48,A,,', '900'));
  assert.match(overlap.issues.find(i => i.code === 'V_COVERAGE_OVERLAP').msg, /25–30/);

  const none = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), b300('20260702', vals(48)), '900'));
  assert.ok(has(none, 'V_NO_400', 'error'));
  assert.equal(nem12.toReadingRows(none, 'F').length, 48);               // only the second (A) day

  const missingTail = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,1,47,A,,', '900'));
  assert.match(missingTail.issues.find(i => i.code === 'V_COVERAGE_GAP').msg, /48/);

  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,1,48,V,,', '900')), 'EVENT_FLAG_V', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,0,48,A,,', '900')), 'EVENT_RANGE', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,1,49,A,,', '900')), 'EVENT_RANGE', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,1,48,Z,,', '900')), 'UNKNOWN_FLAG', 'error'));
  // 400 coverage is judged against N for the stream's own interval length
  const il15 = nem12.parse(file(header(), b200({ il: '15' }), b300('20260701', vals(96), 'V'), '400,1,48,A,,', '400,49,96,S14,0,x', '900'));
  assert.equal(il15.issues.length, 0, JSON.stringify(il15.issues));
  // a 400 after a non-V 300 is kept for audit but warned about
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'A'), '400,1,48,A,,', '900')), 'EVENT_ON_NON_V', 'warning'));
});

test('record order: 100 first, 200 before 300, 400/500 placement, 900 last', () => {
  const { nem12 } = boot();
  assert.ok(has(nem12.parse(file(b200(), b300('20260701', vals(48)), '900')), 'REC_ORDER', 'error'));
  assert.equal(nem12.parse(file(b200(), b300('20260701', vals(48)), '900')).fatal, true);
  assert.ok(has(nem12.parse(file(header(), b300('20260701', vals(48)), '900')), 'REC_ORDER', 'error'));           // 300 before 200
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48)))), 'NO_900', 'error'));            // no 900
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48)), '900', b300('20260702', vals(48)))), 'REC_ORDER', 'error'));   // after 900
  assert.ok(has(nem12.parse(file(header(), header(), b200(), b300('20260701', vals(48)), '900')), 'REC_ORDER', 'error'));  // two 100s
  assert.ok(has(nem12.parse(file(header(), '400,1,48,A,,', b200(), b300('20260701', vals(48)), '900')), 'REC_ORDER', 'error'));  // 400 before any 300
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48)), '500,O,SO1,20260701120000,', '400,1,48,A,,', '900')), 'REC_ORDER', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200(), '500,O,SO1,20260701120000,', '900')), 'REC_ORDER', 'error'));  // 500 with no 300
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', vals(48)), '777,1,2', '900')), 'REC_UNKNOWN', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200(), '900')), 'NO_300', 'warning'));
  assert.ok(has(nem12.parse(file(header(), '900')), 'NO_200', 'error'));
  // a proper 300,400,500 sequence and multiple 200 blocks are fine
  const ok = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'V'), '400,1,48,A,,', '500,O,SO1,20260701120000,12345',
    b200({ suffix: 'Q1', uom: 'kvarh', reg: '2' }), b300('20260701', vals(48)), '900'));
  assert.equal(ok.issues.length, 0, JSON.stringify(ok.issues));
  assert.equal(ok.counts[500], 1);
  assert.equal(ok.blocks.length, 2);
  assert.equal(ok.blocks[0].days[0].b2b[0].transCode, 'O');
});

test('bad dates are reported with line numbers (300 IntervalDate, header, next read, update times)', () => {
  const { nem12 } = boot();
  const r = nem12.parse(file(header(), b200(), b300('20260231', vals(48)), b300('2026-07-01', vals(48)), b300('20261301', vals(48)), b300('20260701', vals(48)), '900'));
  const bad = r.issues.filter(i => i.code === 'BAD_DATE' && i.sev === 'error');
  assert.equal(bad.length, 3);
  assert.deepEqual(J(bad.map(i => i.line)), [3, 4, 5]);
  assert.equal(nem12.toReadingRows(r, 'F').length, 48);
  assert.ok(has(nem12.parse(file('100,NEM12,20261301xxxx,A,B', b200(), b300('20260701', vals(48)), '900')), 'BAD_DATE', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200({ next: '20260230' }), b300('20260701', vals(48)), '900')), 'BAD_DATE', 'warning'));
  const u = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'A', '', '', '2026070201', ''), '900'));
  assert.ok(has(u, 'BAD_DATETIME', 'warning'));
  assert.equal(nem12.toReadingRows(u, 'F')[0].updateDateTime, '20260702120000');       // falls back to header time so versions can be ordered
  const m = nem12.parse(file(header(), b200(), b300('20260701', vals(48), 'A', '', '', '', ''), '900'));
  assert.ok(has(m, 'UPDATE_DT_MISSING', 'warning'));
});

test('malformed values: non-numeric, negative, quality missing, short 300 record', () => {
  const { nem12 } = boot();
  const nonNum = vals(48); nonNum[5] = 'abc';
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', nonNum), '900')), 'BAD_VALUE', 'error') || has(nem12.parse(file(header(), b200(), b300('20260701', nonNum), '900')), 'VALUE_COUNT', 'error'));
  const neg = vals(48); neg[3] = -1;
  assert.ok(has(nem12.parse(file(header(), b200(), b300('20260701', neg), '900')), 'NEGATIVE_VALUE', 'error'));
  assert.ok(has(nem12.parse(file(header(), b200(), '300,20260701,1,2,3', '900')), 'QUALITY_MISSING', 'error'));
  const blank = vals(48); blank[10] = '';
  assert.ok(nem12.parse(file(header(), b200(), b300('20260701', blank), '900')).issueTotals.error >= 1);
  // scientific notation and integers (Wh) are numbers
  const sci = vals(48, '1.5E-1');
  assert.equal(nem12.parse(file(header(), b200(), b300('20260701', sci), '900')).issues.length, 0);
});

test('line endings: LF-only and mixed endings warn; the data still parses; blank lines are tolerated', () => {
  const { nem12 } = boot();
  const lf = [header(), b200(), b300('20260701', vals(48)), '900'].join('\n') + '\n';
  const r = nem12.parse(lf);
  assert.ok(has(r, 'LINE_ENDINGS', 'warning'));
  assert.equal(nem12.toReadingRows(r, 'F').length, 48);
  assert.ok(has(nem12.parse([header(), b200()].join('\r\n') + '\n' + b300('20260701', vals(48)) + '\r\n900\r\n'), 'LINE_ENDINGS', 'warning'));
  assert.equal(nem12.parse(file(header(), b200(), b300('20260701', vals(48)), '900')).issues.length, 0);
  assert.ok(has(nem12.parse(file(header(), '', b200(), b300('20260701', vals(48)), '900')), 'BLANK_LINE', 'warning'));
  assert.equal(nem12.parse('').fatal, true);
  assert.equal(nem12.parse('   \r\n').fatal, true);
});

test('NEM13 and non-NEM12 headers are rejected', () => {
  const { nem12 } = boot();
  const r = nem12.parse(file('100,NEM13,202607021200,A,B', b200(), b300('20260701', vals(48)), '900'));
  assert.ok(has(r, 'NOT_NEM12', 'error'));
  assert.equal(nem12.buildReport(r).status, 'Rejected');
  assert.ok(has(nem12.parse(file('100,XYZ,202607021200,A,B', b200(), b300('20260701', vals(48)), '900')), 'HEADER_VERSION', 'error'));
});

test('date gaps inside a stream are reported; duplicate days in one file are flagged but kept', () => {
  const { nem12 } = boot();
  const r = nem12.parse(file(header(), b200(), b300('20260701', vals(48)), b300('20260704', vals(48)), '900'));
  const g = r.issues.find(i => i.code === 'DATE_GAP');
  assert.ok(g);
  assert.match(g.msg, /2026-07-02 to 2026-07-03/);
  assert.equal(r.streams[0].gaps[0].days, 2);
  const d = nem12.parse(file(header(), b200(), b300('20260701', vals(48, 1)), b300('20260701', vals(48, 2), 'A', '', '', '20260703010000'), '900'));
  assert.ok(has(d, 'DUPLICATE_DAY', 'warning'));
  assert.equal(nem12.toReadingRows(d, 'F').length, 96);
});

test('versioning end-to-end: every interval inserted as a new row; currentIntervals returns the latest UpdateDateTime', () => {
  const { nem12, repo } = boot();
  const f1 = file(header(), b200(), b300('20260701', vals(48, 1), 'S14', '0', 'sub', '20260702010000'), '900');
  const f2 = file(header(), b200(), b300('20260701', vals(48, 2), 'A', '', '', '20260710010000'), '900');
  repo.insertReadings(nem12.toReadingRows(nem12.parse(f1), 'F-A'));
  repo.insertReadings(nem12.toReadingRows(nem12.parse(f2), 'F-B'));
  assert.equal(repo.count('IntervalReading'), 96);
  const cur = repo.currentIntervals('8001TEST01', 'E1', '2026-07-01', '2026-07-01');
  assert.equal(cur.length, 48);
  assert.ok(cur.every(r => r.value === 2 && r.quality === 'A' && r.sourceFileId === 'F-B'));
  assert.equal(repo.readingVersions('8001TEST01', 'E1', '2026-07-01').filter(r => r.intervalNo === 1).length, 2);
});

// ---- sample generator ---------------------------------------------------------------------------------------------------
const WINDOW = { from: '2025-09-01', to: '2026-09-30', now: '20261002100000', seed: 1 };

test('sample generator: 13 months, two NMIs, E1+Q1, valid NEM12 with zero errors', () => {
  const { nem12, util } = boot();
  const hol = new Set(['2025-09-29', '2025-12-25', '2025-12-26', '2026-01-01', '2026-01-26', '2026-03-02', '2026-04-03', '2026-04-05', '2026-04-06', '2026-04-25', '2026-06-01']);
  const s = nem12.generateSample({ ...WINDOW, holidays: hol });
  assert.equal(s.files.length, 2);
  const nDays = util.daysBetween(WINDOW.from, WINDOW.to) + 1;
  assert.equal(nDays, 395);
  for (const f of s.files) {
    assert.match(f.text, /\r\n/);
    assert.ok(!/[^\r]\n/.test(f.text), 'every line ends CRLF');
    const r = nem12.parse(f.text);
    assert.equal(r.fatal, false);
    assert.equal(r.issueTotals.error, 0, JSON.stringify(r.issues.slice(0, 5)));
    assert.equal(r.issueTotals.warning, 0, JSON.stringify(r.issues.slice(0, 5)));
    const rep = nem12.buildReport(r);
    assert.equal(rep.status, 'Accepted');
    assert.deepEqual(J(rep.streams.map(x => x.suffix)), ['E1', 'Q1']);
    for (const st of rep.streams) { assert.equal(st.days, nDays); assert.equal(st.intervals, nDays * 48); assert.equal(st.firstDate, WINDOW.from); assert.equal(st.lastDate, WINDOW.to); assert.equal(st.intervalLength, 30); }
    const q = rep.streams[0].quality;
    assert.ok(q.A > 0 && q.S > 0 && q.E > 0 && q.N > 0, 'has S, E and N intervals: ' + JSON.stringify(q));
    assert.equal(r.counts[300], nDays * 2);
    assert.ok(r.counts[400] >= 3, '400 records present for the V day');
  }
});

test('sample generator: realistic magnitudes (kVA, power factor, annual energy), no negatives, deterministic', () => {
  const { nem12, repo, util } = boot();
  const hol = new Set(['2025-12-25', '2026-01-01']);
  const a = nem12.generateSample({ ...WINDOW, holidays: hol });
  const b = nem12.generateSample({ ...WINDOW, holidays: hol });
  assert.equal(a.files[0].text, b.files[0].text);     // same seed => same file
  assert.notEqual(a.files[0].text, nem12.generateSample({ ...WINDOW, holidays: hol, seed: 2 }).files[0].text);
  const stats = {};
  for (const f of a.files) {
    const rows = nem12.toReadingRows(nem12.parse(f.text), 'F-' + f.nmi);
    assert.ok(rows.every(r => r.value >= 0));
    repo.insertReadings(rows);
    const E = repo.currentIntervals(f.nmi, 'E1', WINDOW.from, WINDOW.to), Q = repo.currentIntervals(f.nmi, 'Q1', WINDOW.from, WINDOW.to);
    let maxKva = 0, kwhYear = 0, pfSum = 0, pfN = 0;
    E.forEach((e, i) => {
      const kva = Math.hypot(e.value * 2, Q[i].value * 2);
      if (kva > maxKva) maxKva = kva;
      if (e.value > 0) { pfSum += e.value * 2 / kva; pfN++; }
      if (e.intervalDate >= '2025-10-01' && e.intervalDate <= '2026-09-30') kwhYear += e.value;
    });
    stats[f.nmi] = { maxKva, mwh: kwhYear / 1000, pf: pfSum / pfN };
  }
  const s1 = stats['8001TEST01'], s2 = stats['8001TEST02'];
  console.log('    sample stats', JSON.stringify(stats));
  assert.ok(s1.maxKva > 70 && s1.maxKva < 200, 'NMI1 peak kVA ' + s1.maxKva);
  assert.ok(s2.maxKva > 900 && s2.maxKva < 1500, 'NMI2 peak kVA ' + s2.maxKva);
  assert.ok(s1.mwh > 100 && s1.mwh < 400, 'NMI1 MWh ' + s1.mwh);
  assert.ok(s2.mwh > 3000 && s2.mwh < 8000, 'NMI2 MWh ' + s2.mwh);
  assert.ok(s1.pf > 0.8 && s1.pf < 0.97 && s2.pf > 0.85 && s2.pf < 0.97);
});

test('sample revision: re-sends S/N/E days with a later UpdateDateTime; currentIntervals shows the corrected quality', () => {
  const { nem12, repo } = boot();
  const hol = new Set();
  const base = nem12.generateSample({ ...WINDOW, holidays: hol });
  const f1 = base.files[0];
  repo.insertReadings(nem12.toReadingRows(nem12.parse(f1.text), 'F-BASE'));
  const before = repo.currentIntervals(f1.nmi, 'E1', WINDOW.from, WINDOW.to);
  const countQ = rows => rows.reduce((m, r) => (m[r.quality] = (m[r.quality] || 0) + 1, m), {});
  const qBefore = countQ(before);
  assert.ok(qBefore.S > 0 && qBefore.N > 0 && qBefore.E > 0);
  const rev = nem12.generateRevision({ ...WINDOW, now: '20261005090000', holidays: hol });
  const rf = rev.files[0];
  const rp = nem12.parse(rf.text);
  assert.equal(rp.issueTotals.error, 0, JSON.stringify(rp.issues.slice(0, 5)));
  assert.equal(rp.streams[0].days, f1.plan.length);
  const revRows = nem12.toReadingRows(rp, 'F-REV');
  repo.insertReadings(revRows);
  assert.equal(repo.count('IntervalReading'), nem12.toReadingRows(nem12.parse(f1.text), 'x').length + revRows.length);   // nothing overwritten
  const after = repo.currentIntervals(f1.nmi, 'E1', WINDOW.from, WINDOW.to);
  assert.equal(after.length, before.length);
  const qAfter = countQ(after);
  assert.equal(qAfter.S || 0, 0);
  assert.equal(qAfter.N || 0, 0);
  assert.equal(qAfter.E || 0, 0);
  // the substituted day now equals the true series, which differs from the like-day substitution
  const sDay = f1.plan.find(p => p.type === 'S_DAY').date;
  const b = before.filter(r => r.intervalDate === sDay), a = after.filter(r => r.intervalDate === sDay);
  assert.ok(b.every(r => r.quality === 'S') && a.every(r => r.quality === 'A'));
  assert.notEqual(b.map(r => r.value).join(), a.map(r => r.value).join());
  // as-known-before-the-revision is still reproducible via the watermark
  const watermark = repo.currentIntervals(f1.nmi, 'E1', WINDOW.from, WINDOW.to, { maxId: Math.max(...before.map(r => r.readingId)) });
  assert.deepEqual(J(countQ(watermark)), J(qBefore));
});

test('sample generator default window is the 13 most recent complete months', () => {
  const { nem12 } = boot();
  assert.deepEqual(J(nem12.defaultSampleWindow('2026-10-02')), { from: '2025-09-01', to: '2026-09-30' });
  assert.deepEqual(J(nem12.defaultSampleWindow('2026-03-01')), { from: '2025-02-01', to: '2026-02-28' });
  assert.deepEqual(J(nem12.defaultSampleWindow('2028-03-15')), { from: '2027-02-01', to: '2028-02-29' });
});
