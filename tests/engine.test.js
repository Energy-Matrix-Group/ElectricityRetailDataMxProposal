const test = require('node:test');
const assert = require('node:assert/strict');
const { makeContext, ev, CORE } = require('./harness');

const FILES = [...CORE, '50-seed.js', '60-engine.js'];
const ctx = makeContext({ files: FILES });
const util = ev(ctx, 'util'), seed = ev(ctx, 'seed'), engine = ev(ctx, 'engine'), repo = ev(ctx, 'repo');
const J = x => JSON.parse(JSON.stringify(x));
const approx = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b} got ${a}`);

// ---- builders --------------------------------------------------------------------------------------------------
function rowsFor(from, to, fn, { suffix = 'E1', L = 30, quality = 'A', unit = 'kWh' } = {}) {
  const rows = [], N = 1440 / L;
  for (const date of util.dateRange(from, to)) {
    for (let i = 0; i < N; i++) {
      const v = fn(date, i, i * L);
      rows.push({ nmi: 'T', suffix, registerId: '1', intervalDate: date, intervalNo: i + 1, intervalLength: L, startMinute: i * L, uom: unit, unit, rawValue: v, value: v,
        quality: typeof quality === 'function' ? quality(date, i) : quality, method: '', updateDateTime: '20260101000000', sourceFileId: 'F' });
    }
  }
  return rows;
}
const HOL = new Set(seed.holidays.map(h => h.date));
const base = extra => ({ tariffs: seed.tariffs, components: seed.components, timeBands: seed.timeBands, rates: seed.rates, holidays: HOL, ...extra });
const price = (tariffCode, from, to, consumption, extra = {}) => engine.priceBillingPeriod(base({ tariffCode, period: { from, to }, consumption, ...extra }));
const line = (res, code) => res.lines.filter(l => l.code === code);
const codesOf = res => res.notices.map(n => n.code);
const kva = (kw, kvar) => Math.hypot(kw, kvar);

// ---- seed data ------------------------------------------------------------------------------------------------------
test('seed: the Western Power 2026-27 price list is loaded exactly as published', () => {
  const rate = (t, c, b = '') => seed.rates.find(r => r.tariffCode === t && r.componentCode === c && r.bandCode === b);
  assert.equal(rate('RT2', 'FIXED').value, 250.075);
  assert.equal(rate('RT2', 'ENERGY', 'ALL').value, 15.100);
  assert.equal(rate('RT2', 'METERING').value, 12.545);
  assert.equal(rate('RT34', 'FIXED').value, 250.075);
  assert.equal(rate('RT34', 'METERING').value, 12.545);
  assert.deepEqual(J(['ON_PEAK', 'SHOULDER', 'OFF_PEAK', 'SUPER_OFF_PEAK'].map(b => rate('RT34', 'ENERGY', b).value)), [24.710, 12.355, 9.505, 6.289]);
  assert.equal(rate('RT6', 'METERING').value, 21.492);
  const bands = [['B1', 0, 300, 1359.249, 114.894], ['B2', 300, 1000, 34468.200, 88.518], ['B3', 1000, 1500, 96430.800, 46.173]];
  for (const [b, lo, hi, fixed, rt] of bands) {
    assert.equal(rate('RT6', 'DEMAND_FIXED', b).value, fixed); assert.equal(rate('RT6', 'DEMAND_RATE', b).value, rt);
    assert.equal(rate('RT6', 'DEMAND_RATE', b).lowerKva, lo); assert.equal(rate('RT6', 'DEMAND_RATE', b).upperKva, hi);
  }
  assert.equal(rate('RT6', 'PARAM', 'DF').value, 0.30);
  const addons = Object.fromEntries(seed.rates.filter(r => r.componentCode === 'METERING_ADDON').map(r => [r.bandCode, r.value]));
  assert.deepEqual(J(addons), { M1: 3.613, M3: 41.244, M4: 82.490, M5: 22.039, 'M7-SIM': 191.058, 'M7-AMI': 3.613 });
  for (const r of seed.rates) { assert.equal(r.effectiveFrom, '2026-07-01'); assert.equal(r.effectiveTo, '2027-06-30'); assert.equal(r.ownerCode, 'WP'); }
});

test('seed: RT4, RT18, RT20, RT22 are closed (grandfathered) with no rates; open tariffs are open', () => {
  for (const c of ['RT4', 'RT18', 'RT20', 'RT22']) {
    const t = seed.tariffs.find(x => x.tariffCode === c);
    assert.equal(t.status, 'closed');
    assert.equal(seed.rates.filter(r => r.tariffCode === c).length, 0);
  }
  for (const c of ['RT2', 'RT34', 'RT6']) assert.equal(seed.tariffs.find(x => x.tariffCode === c).status, 'open');
});

test('seed: every open tariff has full time-band coverage (no gaps, no overlaps) on every day type incl. public holidays', () => {
  for (const c of ['RT2', 'RT34', 'RT6']) {
    const cov = engine.bandCoverage(seed.timeBands.filter(b => b.tariffCode === c));
    assert.equal(cov.ok, true, c + ' ' + JSON.stringify(cov.issues));
  }
  // and the checker really detects problems
  const gap = engine.bandCoverage(seed.timeBands.filter(b => b.tariffCode === 'RT34' && b.timeBandId !== 'RT34.SHOULDER.2'));
  assert.equal(gap.ok, false);
  assert.ok(gap.issues.some(i => i.kind === 'gap' && i.fromMin === 360 && i.toMin === 540));
  const overlap = engine.bandCoverage([...seed.timeBands.filter(b => b.tariffCode === 'RT2'), { ...seed.timeBands.find(b => b.tariffCode === 'RT2'), bandCode: 'X', startMinute: 0, endMinute: 60 }]);
  assert.ok(overlap.issues.some(i => i.kind === 'overlap'));
});

test('seed: WA public holidays fall on the right weekdays and cover 2025-2027', () => {
  const dow = d => util.dow(d);
  const byName = (n, y) => seed.holidays.find(h => h.name === n && h.date.startsWith(y));
  for (const y of ['2025', '2026', '2027']) {
    assert.equal(dow(byName('Labour Day', y).date), 1);
    assert.equal(dow(byName('Western Australia Day', y).date), 1);
    assert.equal(dow(byName("King's Birthday", y).date), 1);
    assert.equal(dow(byName('Good Friday', y).date), 5);
    assert.equal(dow(byName('Easter Sunday', y).date), 0);
    assert.equal(dow(byName('Easter Monday', y).date), 1);
    assert.ok(byName("New Year's Day", y) && byName('Christmas Day', y) && byName('Boxing Day', y) && byName('Anzac Day', y) && byName('Australia Day', y));
  }
  // first Monday of March / June, last Monday of September
  assert.equal(byName('Labour Day', '2026').date, '2026-03-02');
  assert.equal(byName('Western Australia Day', '2026').date, '2026-06-01');
  assert.equal(byName("King's Birthday", '2026').date, '2026-09-28');
  assert.equal(byName('Good Friday', '2026').date, '2026-04-03');
  // weekend holidays get their additional weekday
  assert.ok(HOL.has('2026-12-28'));   // Boxing Day Sat 26 Dec 2026 -> Mon 28
  assert.ok(HOL.has('2027-12-27') && HOL.has('2027-12-28'));
  assert.ok(HOL.has('2025-01-27'));   // Australia Day Sun 26 Jan 2025 -> Mon 27
  assert.equal(new Set(seed.holidays.map(h => h.date)).size, seed.holidays.length, 'no duplicate dates');
});

test('seed.run(): seeds once, never overwrites edits, restoreMissing only adds what is gone', () => {
  assert.equal(repo.count('Rate'), 0);
  assert.equal(seed.run(), true);
  assert.equal(seed.run(), false);
  assert.equal(repo.count('Rate'), seed.rates.length);
  assert.equal(repo.count('NetworkTariff'), 7);
  const id = seed.rates[0].rateId;
  repo.update('Rate', id, { value: 999 });
  repo.remove('Rate', seed.rates[1].rateId);
  const added = seed.restoreMissing(['Rate']);
  assert.equal(added.Rate, 1);
  assert.equal(repo.get('Rate', id).value, 999);   // edit preserved
});

// ---- time bands ---------------------------------------------------------------------------------------------------
test('RT34 bands by interval START time (boundaries), same on public holidays', () => {
  const r = engine.makeBandResolver(seed.timeBands.filter(b => b.tariffCode === 'RT34'));
  const expect = [[0, 'OFF_PEAK'], [359, 'OFF_PEAK'], [360, 'SHOULDER'], [539, 'SHOULDER'], [540, 'SUPER_OFF_PEAK'], [899, 'SUPER_OFF_PEAK'],
    [900, 'ON_PEAK'], [1259, 'ON_PEAK'], [1260, 'SHOULDER'], [1379, 'SHOULDER'], [1380, 'OFF_PEAK'], [1439, 'OFF_PEAK']];
  for (const dow of [0, 1, 3, 6]) for (const hol of [false, true]) for (const [m, b] of expect) assert.equal(r.bandAt(dow, hol, m), b, `dow ${dow} hol ${hol} min ${m}`);
});

test('RT6 bands: Mon-Fri excl. holidays 15:00-21:00 on-peak, everything else off-peak', () => {
  const r = engine.makeBandResolver(seed.timeBands.filter(b => b.tariffCode === 'RT6'));
  for (const dow of [1, 2, 3, 4, 5]) {
    assert.equal(r.bandAt(dow, false, 899), 'OFF_PEAK'); assert.equal(r.bandAt(dow, false, 900), 'ON_PEAK');
    assert.equal(r.bandAt(dow, false, 1259), 'ON_PEAK'); assert.equal(r.bandAt(dow, false, 1260), 'OFF_PEAK');
    assert.equal(r.bandAt(dow, true, 1000), 'OFF_PEAK');          // public holiday
  }
  for (const dow of [0, 6]) for (const hol of [false, true]) for (const m of [0, 900, 1000, 1259, 1439]) assert.equal(r.bandAt(dow, hol, m), 'OFF_PEAK');
});

test('interval numbering: interval 1 ends 00:30; assignment is by START time (interval 31 = first on-peak interval)', () => {
  const only = n => (d, i) => (i + 1 === n ? 1 : 0);
  const bandKwh = n => Object.fromEntries(Object.entries(price('RT34', '2026-08-03', '2026-08-03', rowsFor('2026-08-03', '2026-08-03', only(n)), { rates: seed.rates }).usage.kwhByBand).filter(([, v]) => v > 0));
  assert.deepEqual(J(bandKwh(1)), { OFF_PEAK: 1 });             // 00:00-00:30 (ends 00:30)
  assert.deepEqual(J(bandKwh(12)), { OFF_PEAK: 1 });            // 05:30-06:00
  assert.deepEqual(J(bandKwh(13)), { SHOULDER: 1 });            // 06:00-06:30
  assert.deepEqual(J(bandKwh(19)), { SUPER_OFF_PEAK: 1 });      // 09:00-09:30
  assert.deepEqual(J(bandKwh(30)), { SUPER_OFF_PEAK: 1 });      // 14:30-15:00 (ends 15:00)
  assert.deepEqual(J(bandKwh(31)), { ON_PEAK: 1 });             // 15:00-15:30
  assert.deepEqual(J(bandKwh(42)), { ON_PEAK: 1 });             // 20:30-21:00
  assert.deepEqual(J(bandKwh(43)), { SHOULDER: 1 });            // 21:00-21:30
  assert.deepEqual(J(bandKwh(46)), { SHOULDER: 1 });            // 22:30-23:00
  assert.deepEqual(J(bandKwh(47)), { OFF_PEAK: 1 });            // 23:00-23:30
  assert.deepEqual(J(bandKwh(48)), { OFF_PEAK: 1 });            // 23:30-00:00 next day
});

// ---- RT2 / RT34 -----------------------------------------------------------------------------------------------------------
test('RT2 for July 2026, 1 kWh per half-hour: fixed + energy + metering, then GST', () => {
  const res = price('RT2', '2026-07-01', '2026-07-31', rowsFor('2026-07-01', '2026-07-31', () => 1));
  assert.equal(res.ok, true, JSON.stringify(res.notices));
  assert.equal(res.usage.kwhTotal, 1488);
  const fixed = line(res, 'NET.FIXED')[0], energy = line(res, 'NET.ENERGY.ALL')[0], metering = line(res, 'NET.METERING')[0];
  assert.equal(fixed.quantity, 31); approx(fixed.amountCents, 31 * 250.075);
  assert.equal(energy.quantity, 1488); approx(energy.amountCents, 1488 * 15.1);
  assert.equal(metering.quantity, 31); approx(metering.amountCents, 31 * 12.545);
  approx(res.totals.totalCents, 31 * 250.075 + 1488 * 15.1 + 31 * 12.545);
  assert.equal(res.lines.length, 3);
  const fin = engine.finalise(res, { gstRate: 0.1 });
  assert.deepEqual(J(fin.lines.map(l => l.amountExGstCents)), [7752, 22469, 389]);   // each line rounded to whole cents
  assert.equal(fin.subtotalCents, 30610);
  assert.equal(fin.gstCents, 3061);
  assert.equal(fin.totalCents, 33671);
  assert.equal(fin.byGroup.metering, 389);
});

test('RT34 for July 2026: kWh split across the four bands and priced per band', () => {
  const res = price('RT34', '2026-07-01', '2026-07-31', rowsFor('2026-07-01', '2026-07-31', () => 1));
  assert.deepEqual(J(res.usage.kwhByBand), { OFF_PEAK: 434, SHOULDER: 310, SUPER_OFF_PEAK: 372, ON_PEAK: 372 });
  const amt = c => line(res, c)[0].amountCents;
  approx(amt('NET.ENERGY.ON_PEAK'), 372 * 24.710);
  approx(amt('NET.ENERGY.SHOULDER'), 310 * 12.355);
  approx(amt('NET.ENERGY.OFF_PEAK'), 434 * 9.505);
  approx(amt('NET.ENERGY.SUPER_OFF_PEAK'), 372 * 6.289);
  approx(res.totals.totalCents, 31 * 250.075 + 31 * 12.545 + 372 * 24.710 + 310 * 12.355 + 434 * 9.505 + 372 * 6.289);
  assert.deepEqual(J(res.usage.bandOrder), ['OFF_PEAK', 'SHOULDER', 'SUPER_OFF_PEAK', 'ON_PEAK']);
});

test('RT34 bands apply on public holidays: result is identical with and without the holiday calendar', () => {
  const rows = rowsFor('2026-09-21', '2026-09-30', (d, i) => 1 + (i % 5));   // spans King's Birthday Mon 28 Sep 2026
  const a = price('RT34', '2026-09-21', '2026-09-30', rows);
  const b = price('RT34', '2026-09-21', '2026-09-30', rows, { holidays: new Set(['2026-09-28']) });
  const c = price('RT34', '2026-09-21', '2026-09-30', rows, { holidays: new Set(['2026-09-28', '2026-09-29', '2026-09-30', '2026-01-01']) });
  approx(a.totals.totalCents, b.totals.totalCents, 1e-9);
  approx(b.totals.totalCents, c.totals.totalCents, 1e-9);
  assert.deepEqual(J(a.usage.kwhByBand), J(c.usage.kwhByBand));
});

test('missing / quality-N intervals are counted; E/S/F counted as estimated; no data is an error', () => {
  const q = (d, i) => (d === '2026-07-03' && i < 6 ? 'N' : d === '2026-07-04' && i < 10 ? 'S' : d === '2026-07-05' && i < 4 ? 'E' : d === '2026-07-06' && i < 2 ? 'F' : 'A');
  const rows = rowsFor('2026-07-01', '2026-07-07', (d, i) => (q(d, i) === 'N' ? 0 : 1), { quality: q });
  const res = price('RT2', '2026-07-01', '2026-07-07', rows);
  assert.equal(res.usage.quality.N, 6);
  assert.equal(res.usage.missingIntervals, 6);
  assert.equal(res.usage.estimatedIntervals, 10 + 4 + 2);
  assert.ok(codesOf(res).includes('DATA_MISSING') && codesOf(res).includes('DATA_ESTIMATED'));
  // a whole missing day counts 48 missing intervals
  const gap = rowsFor('2026-07-01', '2026-07-07', () => 1).filter(r => r.intervalDate !== '2026-07-04');
  const g = price('RT2', '2026-07-01', '2026-07-07', gap);
  assert.equal(g.usage.missingIntervals, 48);
  assert.equal(g.usage.daysWithData, 6);
  const none = price('RT2', '2026-08-01', '2026-08-07', rowsFor('2026-07-01', '2026-07-07', () => 1));
  assert.equal(none.ok, false);
  assert.ok(codesOf(none).includes('NO_DATA'));
});

// ---- RT6 --------------------------------------------------------------------------------------------------------------------------------
const rb = engine.makeRateBook(seed.rates, { ownerCode: 'WP', tariffCode: 'RT6' });
const bands = rb.demandBands('2026-07-15');
const P = { DF: 0.3, taperStart: 1000, taperEnd: 1500 };

test('RT6 band table is applied exactly as published', () => {
  assert.deepEqual(J(bands.map(b => [b.bandCode, b.lower, b.fixed, b.rate])), [['B1', 0, 1359.249, 114.894], ['B2', 300, 34468.2, 88.518], ['B3', 1000, 96430.8, 46.173]]);
  approx(engine.demandCharge(0, bands).amount, 1359.249);
  approx(engine.demandCharge(100, bands).amount, 1359.249 + 114.894 * 100);
  approx(engine.demandCharge(600, bands).amount, 34468.2 + 88.518 * 300);
  approx(engine.demandCharge(1200, bands).amount, 96430.8 + 46.173 * 200);
});

test('RT6 300 kVA: published fixed amounts step at 300 (just below vs just above)', () => {
  const below = engine.rt6Daily(299.999, 0, bands, P), at = engine.rt6Daily(300, 0, bands, P), above = engine.rt6Daily(300.001, 0, bands, P);
  assert.equal(below.band.bandCode, 'B1'); assert.equal(at.band.bandCode, 'B2'); assert.equal(above.band.bandCode, 'B2');
  approx(below.amount, 1359.249 + 114.894 * 299.999, 1e-9);
  approx(at.amount, 34468.2, 1e-9);
  approx(above.amount, 34468.2 + 88.518 * 0.001, 1e-9);
  approx(at.amount - below.amount, -1359.249 + 114.894 * 0.001, 1e-6, 'a step DOWN of about 1,359.249 c/day when MD crosses 300 kVA');
  assert.ok(at.amount < below.amount);
  // the continuity of 300-1000 -> 1000-1500 at 1000 kVA
  approx(engine.demandCharge(1000, bands).amount, 96430.8, 1e-9);
  approx(engine.demandCharge(999.999, bands).amount, 34468.2 + 88.518 * 699.999, 1e-9);
  assert.ok(Math.abs(engine.demandCharge(1000, bands).amount - engine.demandCharge(999.999, bands).amount) < 0.1);
});

test('RT6 MD at or above the top published band is flagged as extrapolated', () => {
  const d = engine.demandCharge(1500, bands);
  assert.equal(d.extrapolated, true);
  approx(d.amount, 96430.8 + 46.173 * 500);
  assert.equal(engine.demandCharge(1499.9, bands).extrapolated, false);
});

test('RT6 discount: share x DF below 1000 kVA, tapering to zero at 1500 kVA', () => {
  approx(engine.demandDiscount(0, 0.8, P), 0.24);
  approx(engine.demandDiscount(999.9, 0.8, P), 0.24);
  approx(engine.demandDiscount(1000, 0.8, P), 0.24);             // ((1500-1000)/500) = 1
  approx(engine.demandDiscount(1250, 0.8, P), 0.12);             // ((1500-1250)/500) = 0.5
  approx(engine.demandDiscount(1499, 0.8, P), (1 / 500) * 0.8 * 0.3, 1e-12);                // ((1500-1499)/500) * share * DF
  assert.equal(engine.demandDiscount(1500, 0.8, P), 0);
  assert.equal(engine.demandDiscount(2000, 0.8, P), 0);
  assert.equal(engine.demandDiscount(500, 0, P), 0);
  approx(engine.demandDiscount(500, 1, P), 0.3);
  const r = engine.rt6Daily(1250, 0.8, bands, P);
  approx(r.net, (96430.8 + 46.173 * 250) * (1 - 0.12));
});

test('RT6 monthly bill: flat 100 kW, no Q datastream => assumed PF 0.9, warning, discount from the off-peak share', () => {
  const rows = rowsFor('2025-07-01', '2026-08-31', () => 50);          // 100 kW every half hour
  const res = price('RT6', '2026-08-01', '2026-08-31', rows, { site: { assumedPf: 0.9 } });
  assert.equal(res.ok, true, JSON.stringify(res.notices));
  const md = 100 / 0.9;
  // independent off-peak share: Aug 2026 has 21 weekdays (no WA holidays in August)
  let on = 0, total = 0;
  for (const d of util.dateRange('2026-08-01', '2026-08-31')) { total += 48; if (util.dow(d) >= 1 && util.dow(d) <= 5 && !HOL.has(d)) on += 12; }
  const share = (total - on) / total;
  approx(res.demand.offPeakShare, share, 1e-12);
  approx(res.demand.mdEnd, md, 1e-9);
  const gross = 1359.249 + 114.894 * md;
  const dem = line(res, 'NET.DEMAND'); assert.equal(dem.length, 1); assert.equal(dem[0].quantity, 31);
  approx(dem[0].amountCents, 31 * gross, 1e-6);
  const disc = line(res, 'NET.DEMAND.DISCOUNT')[0];
  approx(disc.amountCents, -31 * gross * share * 0.3, 1e-6);
  approx(line(res, 'NET.METERING')[0].amountCents, 31 * 21.492);
  approx(res.totals.totalCents, 31 * gross * (1 - share * 0.3) + 31 * 21.492, 1e-6);
  assert.equal(line(res, 'NET.ENERGY').length, 0, 'no per-kWh network energy charge on RT6');
  assert.ok(codesOf(res).includes('PF_ASSUMED'));
  assert.ok(!codesOf(res).includes('MD_SHORT_HISTORY'), 'a full 12 months of history exists');
});

test('RT6 uses real Q data when present: kVA = sqrt(kW^2 + kvar^2) per half hour; no PF warning', () => {
  const e = rowsFor('2025-07-01', '2026-08-31', () => 50);
  const q = rowsFor('2025-07-01', '2026-08-31', () => 25, { suffix: 'Q1', unit: 'kvarh' });       // 50 kvar
  const res = price('RT6', '2026-08-01', '2026-08-31', e, { reactive: q });
  approx(res.demand.mdEnd, kva(100, 50), 1e-9);
  assert.ok(!codesOf(res).includes('PF_ASSUMED'));
  // power factor assumption is per site and changes the result
  const res95 = price('RT6', '2026-08-01', '2026-08-31', e, { site: { assumedPf: 0.95 } });
  approx(res95.demand.mdEnd, 100 / 0.95, 1e-9);
  // a Q stream with a hole falls back to the assumed PF for those half hours and says so
  const holey = q.filter(r => !(r.intervalDate === '2026-08-10' && r.intervalNo <= 4));
  const rh = price('RT6', '2026-08-01', '2026-08-31', e, { reactive: holey });
  assert.ok(codesOf(rh).includes('PF_ASSUMED'));
  assert.match(rh.notices.find(n => n.code === 'PF_ASSUMED').message, /4 half-hours/);
});

test('RT6 demand uses MAXIMUM HALF-HOURLY kVA: 5-minute data is summed to the half hour first', () => {
  // 5-minute data: one 10 kWh interval (120 kW over 5 minutes) and zero otherwise => the half-hour average is only 20 kW
  const spike = rowsFor('2026-08-01', '2026-08-31', (d, i) => (d === '2026-08-15' && i === 100 ? 10 : 0.5), { L: 5 });
  const prof = engine.buildProfile({ consumption: spike, assumedPf: 1 });
  const slotKw = (10 + 5 * 0.5) * 2;     // slot containing interval 100 (minute 495 -> slot 16): 12.5 kWh -> 25 kW
  approx(prof.days.get('2026-08-15').maxKva, slotKw, 1e-9);
  approx(prof.days.get('2026-08-16').maxKva, 6 * 0.5 * 2, 1e-9);      // 3 kWh per half hour = 6 kW
  assert.equal(prof.days.get('2026-08-16').missingSlots, 0);
});

test('RT6 rolling 12-month MD: a peak drops out exactly 12 months later; period-end mode applies one MD to all days', () => {
  const rows = rowsFor('2025-01-01', '2026-12-31', (d, i) => (d === '2025-07-15' && i === 20 ? 250 : 25));   // base 50 kW, one 500 kW spike
  const spikeKva = 500 / 0.9, baseKva = 50 / 0.9;
  const res = price('RT6', '2026-07-01', '2026-07-31', rows);
  const runs = res.demand.runs;
  assert.equal(runs.length, 2);
  assert.deepEqual(J(runs.map(r => [r.from, r.to, r.days])), [['2026-07-01', '2026-07-14', 14], ['2026-07-15', '2026-07-31', 17]]);
  approx(runs[0].md, spikeKva, 1e-9); approx(runs[1].md, baseKva, 1e-9);
  assert.equal(line(res, 'NET.DEMAND').length, 2);
  const pe = price('RT6', '2026-07-01', '2026-07-31', rows, { options: { mdMode: 'period-end' } });
  assert.equal(pe.demand.runs.length, 1);
  approx(pe.demand.runs[0].md, baseKva, 1e-9);
  // 365-day window includes the spike day itself on its 12-month anniversary minus one
  const edge = price('RT6', '2026-07-14', '2026-07-15', rows);
  approx(edge.demand.runs[0].md, spikeKva, 1e-9);
  approx(edge.demand.runs[1].md, baseKva, 1e-9);
});

test('RT6 options.mdFixedKva applies one MD to every day (a quote\'s steady-state annual peak) and says so', () => {
  const rows = rowsFor('2026-05-01', '2026-08-31', () => 25);              // only 4 months of history: a rolling MD would warn
  const res = price('RT6', '2026-08-01', '2026-08-31', rows, { options: { mdFixedKva: 600 } });
  assert.equal(res.ok, true, JSON.stringify(res.notices));
  assert.equal(res.demand.runs.length, 1);
  approx(res.demand.runs[0].md, 600, 1e-12);
  assert.equal(res.demand.runs[0].bandCode, 'B2');
  assert.equal(res.demand.mdMode, 'fixed');
  assert.ok(codesOf(res).includes('MD_FIXED'));
  assert.ok(!codesOf(res).includes('MD_SHORT_HISTORY'));
  approx(line(res, 'NET.DEMAND')[0].amountCents, 31 * (34468.2 + 88.518 * 300), 1e-6);
  assert.match(line(res, 'NET.DEMAND')[0].detail, /MD 600\.0 kVA · band 300–1,000 kVA/);
  assert.equal(line(res, 'NET.DEMAND')[0].description, 'Metered demand charge (RT6)');   // long formula text lives in .detail, not the description
  const rolling = price('RT6', '2026-08-01', '2026-08-31', rows);
  approx(rolling.demand.mdMax, 25 * 2 / 0.9, 1e-9);                         // without the option the (short-history) rolling MD is used
});

test('RT6 short history is flagged when less than 12 months precede the period', () => {
  const rows = rowsFor('2026-05-01', '2026-08-31', () => 50);
  const res = price('RT6', '2026-08-01', '2026-08-31', rows);
  assert.ok(codesOf(res).includes('MD_SHORT_HISTORY'));
});

test('RT6 MD above 1,000 kVA: top band + discount taper + "demand-length charge not calculated" notice', () => {
  const rows = rowsFor('2025-07-01', '2026-08-31', (d, i) => (d === '2026-08-10' && i === 24 ? 600 : 100));   // 200 kW base, 1,200 kW spike
  const q = rowsFor('2025-07-01', '2026-08-31', (d, i) => (d === '2026-08-10' && i === 24 ? 0 : 0), { suffix: 'Q1', unit: 'kvarh' });
  const res = price('RT6', '2026-08-01', '2026-08-31', rows, { reactive: q });
  const md = 1200;
  assert.equal(res.demand.runs.find(r => r.from === '2026-08-10').bandCode, 'B3');
  approx(res.demand.mdMax, md, 1e-9);
  const n = res.notices.find(x => x.code === 'DEMAND_LENGTH_NOT_CALCULATED');
  assert.ok(n && n.level === 'warn');
  assert.match(n.message, /22 day/);          // 10th..31st inclusive
  assert.match(n.message, /not calculated/i);
  const run = res.demand.runs.find(r => r.from === '2026-08-10');
  approx(run.discountRate, ((1500 - md) / 500) * res.demand.offPeakShare * 0.3, 1e-9);
  // MD of exactly 1,000 kVA is not "above 1,000"
  const rows2 = rowsFor('2025-07-01', '2026-08-31', () => 500);
  const q2 = rowsFor('2025-07-01', '2026-08-31', () => 0, { suffix: 'Q1', unit: 'kvarh' });
  const r2 = price('RT6', '2026-08-01', '2026-08-31', rows2, { reactive: q2 });
  approx(r2.demand.mdMax, 1000, 1e-9);
  assert.ok(!codesOf(r2).includes('DEMAND_LENGTH_NOT_CALCULATED'));
  assert.equal(r2.demand.runs[0].bandCode, 'B3');
});

test('RT6 off-peak share treats public holidays as off-peak: 28 Sep 2026 (King\'s Birthday) is not on-peak', () => {
  const rows = rowsFor('2025-10-01', '2026-09-30', () => 50);
  const withHol = price('RT6', '2026-09-01', '2026-09-30', rows);
  const noHol = price('RT6', '2026-09-01', '2026-09-30', rows, { holidays: new Set(['2025-12-25', '2026-01-01', '2026-09-27']) });
  const onPeakDays = h => util.dateRange('2026-09-01', '2026-09-30').filter(d => util.dow(d) >= 1 && util.dow(d) <= 5 && !h.has(d)).length;
  approx(withHol.demand.offPeakShare, 1 - onPeakDays(HOL) * 12 / (30 * 48), 1e-12);
  assert.ok(withHol.demand.offPeakShare > noHol.demand.offPeakShare);
  approx(noHol.demand.offPeakShare - withHol.demand.offPeakShare, -12 / (30 * 48), 1e-12);
});

test('RT6: a missing holiday table for the period year raises a warning', () => {
  const rows = rowsFor('2026-07-01', '2026-07-31', () => 50);
  const res = price('RT6', '2026-07-01', '2026-07-31', rows, { holidays: new Set(['2024-01-01']) });
  assert.ok(codesOf(res).includes('NO_HOLIDAYS'));
});

// ---- rates over time ----------------------------------------------------------------------------------------------------------------------
const fy2526 = [
  { rateId: 'T1', ownerCode: 'WP', tariffCode: 'RT2', componentCode: 'FIXED', bandCode: '', value: 200, unit: 'c/day', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30' },
  { rateId: 'T2', ownerCode: 'WP', tariffCode: 'RT2', componentCode: 'ENERGY', bandCode: 'ALL', value: 14, unit: 'c/kWh', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30' },
  { rateId: 'T3', ownerCode: 'WP', tariffCode: 'RT2', componentCode: 'METERING', bandCode: '', value: 10, unit: 'c/day', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30' },
];

test('a bill spanning 1 July uses each day\'s own rate set (two lines per charge); prices are data, not code', () => {
  const rows = rowsFor('2026-06-15', '2026-07-14', () => 1);
  const res = price('RT2', '2026-06-15', '2026-07-14', rows, { rates: [...seed.rates, ...fy2526] });
  assert.equal(res.ok, true, JSON.stringify(res.notices));
  const fixed = line(res, 'NET.FIXED');
  assert.deepEqual(J(fixed.map(l => [l.from, l.to, l.quantity, l.rate])), [['2026-06-15', '2026-06-30', 16, 200], ['2026-07-01', '2026-07-14', 14, 250.075]]);
  const energy = line(res, 'NET.ENERGY.ALL');
  assert.deepEqual(J(energy.map(l => [l.quantity, l.rate])), [[16 * 48, 14], [14 * 48, 15.1]]);
  approx(res.totals.totalCents, 16 * 200 + 14 * 250.075 + 16 * 48 * 14 + 14 * 48 * 15.1 + 16 * 10 + 14 * 12.545);
});

test('no rate effective => RATE_MISSING error (ok=false); rateAsAt re-prices at a chosen date; fallback "latest" assumes current rates with a warning', () => {
  const rows = rowsFor('2026-06-15', '2026-07-14', () => 1);
  const miss = price('RT2', '2026-06-15', '2026-07-14', rows);
  assert.equal(miss.ok, false);
  const m = miss.notices.filter(n => n.code === 'RATE_MISSING');
  assert.ok(m.length >= 3);
  assert.match(m[0].message, /16 days/);
  const jun = rowsFor('2026-06-01', '2026-06-30', () => 1);
  const asAt = price('RT2', '2026-06-01', '2026-06-30', jun, { options: { rateAsAt: '2026-07-01' } });
  assert.equal(asAt.ok, true);
  approx(line(asAt, 'NET.FIXED')[0].rate, 250.075);
  const jul27 = rowsFor('2027-07-01', '2027-07-31', () => 1);
  const err = price('RT2', '2027-07-01', '2027-07-31', jul27);
  assert.equal(err.ok, false);
  const fb = price('RT2', '2027-07-01', '2027-07-31', jul27, { options: { rateFallback: 'latest' } });
  assert.equal(fb.ok, true);
  assert.ok(codesOf(fb).includes('RATE_ASSUMED'));
  approx(line(fb, 'NET.ENERGY.ALL')[0].rate, 15.1);
});

test('overlapping rate rows: the row with the latest EffectiveFrom wins', () => {
  const extra = [{ rateId: 'X', ownerCode: 'WP', tariffCode: 'RT2', componentCode: 'ENERGY', bandCode: 'ALL', value: 99, unit: 'c/kWh', effectiveFrom: '2026-07-10', effectiveTo: null }];
  const res = price('RT2', '2026-07-01', '2026-07-31', rowsFor('2026-07-01', '2026-07-31', () => 1), { rates: [...seed.rates, ...extra] });
  assert.deepEqual(J(line(res, 'NET.ENERGY.ALL').map(l => [l.rate, l.quantity])), [[15.1, 9 * 48], [99, 22 * 48]]);
});

// ---- metering add-ons -----------------------------------------------------------------------------------------------------------------------
test('metering: total metering charge = tariff metering charge + the site\'s reference service add-on', () => {
  const rows = rowsFor('2026-07-01', '2026-07-31', () => 1);
  const expectCents = { M1: 3.613, M3: 41.244, M4: 82.490, M5: 22.039, 'M7-SIM': 191.058, 'M7-AMI': 3.613 };
  for (const [code, cents] of Object.entries(expectCents)) {
    const res = price('RT2', '2026-07-01', '2026-07-31', rows, { site: { meteringService: code } });
    const add = line(res, 'NET.METERING.ADDON')[0];
    assert.equal(add.quantity, 31); approx(add.amountCents, 31 * cents);
    approx(res.totals.meteringCents, 31 * 12.545 + 31 * cents);
  }
  const other = price('RT2', '2026-07-01', '2026-07-31', rows, { site: { meteringService: 'OTHER', meteringOtherCents: 55.5 } });
  approx(other.totals.meteringCents, 31 * 12.545 + 31 * 55.5);
  const none = price('RT2', '2026-07-01', '2026-07-31', rows, { site: { meteringService: 'NONE' } });
  approx(none.totals.meteringCents, 31 * 12.545);
  const rt6 = price('RT6', '2026-07-01', '2026-07-31', rowsFor('2025-07-01', '2026-07-31', () => 50), { site: { meteringService: 'M5' } });
  approx(rt6.totals.meteringCents, 31 * 21.492 + 31 * 22.039);
  const bad = price('RT2', '2026-07-01', '2026-07-31', rows, { site: { meteringService: 'M9' } });
  assert.equal(bad.ok, false);
});

test('closed tariffs cannot be priced until rates are loaded', () => {
  const res = price('RT4', '2026-07-01', '2026-07-31', rowsFor('2026-07-01', '2026-07-31', () => 1));
  assert.equal(res.ok, false);
  assert.ok(codesOf(res).includes('CLOSED_NO_RATES'));
  assert.equal(price('RT99', '2026-07-01', '2026-07-31', []).ok, false);
});

test('an uncovered time band is an error, not a silent zero', () => {
  const tb = seed.timeBands.filter(b => b.timeBandId !== 'RT34.SHOULDER.2');
  const res = price('RT34', '2026-07-01', '2026-07-07', rowsFor('2026-07-01', '2026-07-07', () => 1), { timeBands: tb });
  assert.equal(res.ok, false);
  assert.ok(codesOf(res).includes('BAND_UNCOVERED'));
});

// ---- retail offer ------------------------------------------------------------------------------------------------------------------------------
const retailRates = [
  ...[['ON_PEAK', 20], ['SHOULDER', 12], ['OFF_PEAK', 9], ['SUPER_OFF_PEAK', 5]].map(([b, v]) => ({ rateId: 'RE' + b, ownerCode: 'OF-T', tariffCode: 'RT34', componentCode: 'RET_ENERGY', bandCode: b, value: v, unit: 'c/kWh', effectiveFrom: '2026-07-01', effectiveTo: null })),
  { rateId: 'RF', ownerCode: 'OF-T', tariffCode: '*', componentCode: 'RET_FIXED', bandCode: '', value: 100, unit: 'c/day', effectiveFrom: '2026-07-01', effectiveTo: null, note: 'Retail service fee' },
  { rateId: 'RO', ownerCode: 'OF-T', tariffCode: '*', componentCode: 'RET_OTHER_KWH', bandCode: 'ENV', value: 2, unit: 'c/kWh', effectiveFrom: '2026-07-01', effectiveTo: null, note: 'Market and environmental charges' },
  { rateId: 'RD', ownerCode: 'OF-T', tariffCode: '*', componentCode: 'RET_OTHER_DAY', bandCode: 'ACCT', value: 10, unit: 'c/day', effectiveFrom: '2026-07-01', effectiveTo: null, note: 'Account fee' },
];

test('retail offer lines use the same bands and rate-resolution as the network lines; margin on network charges', () => {
  const rows = rowsFor('2026-07-01', '2026-07-31', () => 1);
  const res = price('RT34', '2026-07-01', '2026-07-31', rows, { rates: [...seed.rates, ...retailRates], retail: { offerId: 'OF-T', networkMarginPct: 5 } });
  assert.equal(res.ok, true, JSON.stringify(res.notices));
  const amt = c => line(res, c).reduce((s, l) => s + l.amountCents, 0);
  approx(amt('RET.ENERGY.ON_PEAK'), 372 * 20);
  approx(amt('RET.ENERGY.SHOULDER'), 310 * 12);
  approx(amt('RET.ENERGY.OFF_PEAK'), 434 * 9);
  approx(amt('RET.ENERGY.SUPER_OFF_PEAK'), 372 * 5);
  approx(amt('RET.FIXED'), 31 * 100);
  approx(amt('RET.OTHER.ENV'), 1488 * 2);
  approx(amt('RET.OTHER.ACCT'), 31 * 10);
  const net = res.totals.networkCents + res.totals.meteringCents;
  approx(amt('RET.NETWORK_MARGIN'), net * 0.05, 1e-6);
  approx(res.totals.totalCents, res.totals.networkCents + res.totals.meteringCents + res.totals.retailCents);
  assert.ok(res.totals.retailCents > 0);
  // an offer with no energy rate for the site's tariff cannot be priced
  const rt2 = price('RT2', '2026-07-01', '2026-07-31', rows, { rates: [...seed.rates, ...retailRates], retail: { offerId: 'OF-T' } });
  assert.equal(rt2.ok, false);
  assert.match(rt2.notices.find(n => n.code === 'RATE_MISSING').message, /retail energy rate/);
});

test('retail rate with tariffCode "*" and bandCode "*" is a catch-all, exact rows beat it', () => {
  const rates = [{ rateId: 'W', ownerCode: 'OF-W', tariffCode: '*', componentCode: 'RET_ENERGY', bandCode: '*', value: 10, unit: 'c/kWh', effectiveFrom: '2026-07-01', effectiveTo: null },
    { rateId: 'E', ownerCode: 'OF-W', tariffCode: 'RT34', componentCode: 'RET_ENERGY', bandCode: 'ON_PEAK', value: 30, unit: 'c/kWh', effectiveFrom: '2026-07-01', effectiveTo: null }];
  const res = price('RT34', '2026-07-01', '2026-07-31', rowsFor('2026-07-01', '2026-07-31', () => 1), { rates: [...seed.rates, ...rates], retail: { offerId: 'OF-W' } });
  const amt = c => line(res, c)[0].amountCents;
  approx(amt('RET.ENERGY.ON_PEAK'), 372 * 30);
  approx(amt('RET.ENERGY.OFF_PEAK'), 434 * 10);
});

// ---- exports & aggregation -----------------------------------------------------------------------------------------------------------------------
test('export (B) energy is reported but never credited', () => {
  const e = rowsFor('2026-07-01', '2026-07-31', () => 1), b = rowsFor('2026-07-01', '2026-07-31', () => 0.4, { suffix: 'B1' });
  const withB = price('RT2', '2026-07-01', '2026-07-31', e, { exports: b }), without = price('RT2', '2026-07-01', '2026-07-31', e);
  approx(withB.totals.totalCents, without.totals.totalCents, 1e-9);
  approx(withB.usage.exportKwh, 31 * 48 * 0.4, 1e-9);
  assert.ok(codesOf(withB).includes('EXPORT_NOT_CREDITED'));
});

test('multiple E registers are summed (E1 + E2); one prepared profile can price many periods identically', () => {
  const e1 = rowsFor('2025-07-01', '2026-09-30', () => 20), e2 = rowsFor('2025-07-01', '2026-09-30', () => 30, { suffix: 'E2' });
  const sum = rowsFor('2025-07-01', '2026-09-30', () => 50);
  const profile = engine.buildProfile({ consumption: [...e1, ...e2], assumedPf: 0.9 });
  const a = price('RT6', '2026-08-01', '2026-08-31', null, { profile });
  const b = price('RT6', '2026-08-01', '2026-08-31', sum);
  approx(a.totals.totalCents, b.totals.totalCents, 1e-6);
  approx(a.usage.kwhTotal, 31 * 48 * 50, 1e-6);
});

test('a quote is twelve billing periods through the same engine: aggregate equals the sum of the months', () => {
  const rows = rowsFor('2025-09-01', '2026-09-30', (d, i) => 20 + 30 * Math.sin((util.dayNum(d) + i) / 50) ** 2);
  const profile = engine.buildProfile({ consumption: rows });
  const periods = engine.monthPeriods('2025-10-01', '2026-09-30');
  assert.equal(periods.length, 12);
  assert.deepEqual(J(periods[0]), { from: '2025-10-01', to: '2025-10-31' });
  assert.deepEqual(J(periods[4]), { from: '2026-02-01', to: '2026-02-28' });
  const results = periods.map(p => engine.priceBillingPeriod(base({ tariffCode: 'RT34', period: p, profile, options: { rateAsAt: '2026-07-01' } })));
  assert.ok(results.every(r => r.ok));
  const agg = engine.aggregate(results);
  approx(agg.totals.totalCents, results.reduce((s, r) => s + r.totals.totalCents, 0), 1e-6);
  approx(agg.usage.kwhTotal, results.reduce((s, r) => s + r.usage.kwhTotal, 0), 1e-6);
  assert.equal(agg.usage.days, 365);
  assert.equal(agg.ok, true);
  // each month priced alone equals the same month priced as a "bill"
  const bill = engine.priceBillingPeriod(base({ tariffCode: 'RT34', period: periods[3], consumption: rows, options: { rateAsAt: '2026-07-01' } }));
  approx(bill.totals.totalCents, results[3].totals.totalCents, 1e-9);
  assert.equal(engine.monthPeriods('2026-01-15', '2026-03-10').length, 3);
});

test('finalise: each line rounds to whole cents, GST is 10% of the rounded subtotal', () => {
  const fake = { lines: [{ amountCents: 100.4, group: 'Network' }, { amountCents: 200.5, group: 'Metering' }, { amountCents: -50.5, group: 'Network' }, { amountCents: 0.5, group: 'Retail' }] };
  const f = engine.finalise(fake, { gstRate: 0.1 });
  assert.deepEqual(J(f.lines.map(l => l.amountExGstCents)), [100, 201, -51, 1]);
  assert.equal(f.subtotalCents, 251);
  assert.equal(f.gstCents, 25);
  assert.equal(f.totalCents, 276);
});

// ---- found by the independent numerics review -------------------------------------------------------------------
const rt6Day = (date, kvaOfSlot20, { pf = 0.9, withQ = true } = {}) => {
  const kw = kvaOfSlot20 * (withQ ? 1 : pf);
  const e = rowsFor(date, date, (d, i) => (i === 20 ? kw / 2 : 0.5));
  const q = rowsFor(date, date, () => 0, { suffix: 'Q1', unit: 'kvarh' });
  return { e, q };
};

test('RT6: a band whose fixed amount or rate is missing is an error, never silently priced from the neighbouring band', () => {
  const without = (comp, band) => seed.rates.filter(r => !(r.tariffCode === 'RT6' && r.componentCode === comp && r.bandCode === band));
  const { e, q } = rt6Day('2026-08-15', 100);
  for (const [comp, band] of [['DEMAND_FIXED', 'B1'], ['DEMAND_RATE', 'B1'], ['DEMAND_RATE', 'B2'], ['DEMAND_RATE', 'B3']]) {
    const res = price('RT6', '2026-08-15', '2026-08-15', e, { reactive: q, rates: without(comp, band) });
    assert.equal(res.ok, false, `${comp} ${band} deleted must not price`);
    assert.ok(res.notices.some(n => n.code === 'RATE_MISSING' && n.message.includes(band)), `${comp} ${band}: ${JSON.stringify(res.notices.map(n => n.message))}`);
    assert.equal(line(res, 'NET.DEMAND').length, 0, 'no demand line is produced from an incomplete table');
  }
  const ok = price('RT6', '2026-08-15', '2026-08-15', e, { reactive: q });
  assert.equal(ok.ok, true);
  approx(line(ok, 'NET.DEMAND')[0].rate, 1359.249 + 114.894 * 100, 1e-6);
});

test('RT6: a band table with a gap, an overlap or a start above 0 kVA is rejected with RATE_TABLE_INVALID', () => {
  const { e, q } = rt6Day('2026-08-15', 100);
  const edit = (band, field, value) => seed.rates.map(r => (r.tariffCode === 'RT6' && r.componentCode === 'DEMAND_RATE' && r.bandCode === band ? { ...r, [field]: value } : r));
  const cases = [['gap', edit('B2', 'lowerKva', 350), /gap between 300 and 350/], ['overlap', edit('B2', 'lowerKva', 250), /overlapping bands around 250/], ['start', edit('B1', 'lowerKva', 50), /starts at 50 kVA/]];
  for (const [name, rates, re] of cases) {
    const res = price('RT6', '2026-08-15', '2026-08-15', e, { reactive: q, rates });
    assert.equal(res.ok, false, name);
    const n = res.notices.find(x => x.code === 'RATE_TABLE_INVALID');
    assert.ok(n && re.test(n.message), `${name}: ${n && n.message}`);
    assert.equal(line(res, 'NET.DEMAND').length, 0);
  }
});

test('RT6: kVA derived through an assumed power factor lands exactly on the 300 / 1,000 / 1,500 boundaries (no floating-point noise)', () => {
  // 240 kW at PF 0.8 is exactly 300 kVA; the raw hypot gives 299.99999999999994 and used to bill band 1 ($13.59/day too much)
  const res = price('RT6', '2026-08-15', '2026-08-15', rowsFor('2026-08-15', '2026-08-15', (d, i) => (i === 20 ? 120 : 1)), { site: { assumedPf: 0.8 } });
  assert.equal(res.demand.mdEnd, 300);
  assert.equal(res.demand.runs[0].bandCode, 'B2');
  approx(line(res, 'NET.DEMAND')[0].rate, 34468.2, 1e-9);
  // PF 0.75 with 375 kWh in a half hour is exactly 1,000 kVA: not above the 1,000 kVA demand-length trigger
  const r1000 = price('RT6', '2026-08-15', '2026-08-15', rowsFor('2026-08-15', '2026-08-15', (d, i) => (i === 20 ? 375 : 1)), { site: { assumedPf: 0.75 } });
  assert.equal(r1000.demand.mdEnd, 1000);
  assert.ok(!codesOf(r1000).includes('DEMAND_LENGTH_NOT_CALCULATED'), 'MD of exactly 1,000 kVA is not above the threshold');
});

test('RT6: days whose MD differs by a fraction of a kVA are not merged into one run at the first day\'s MD', () => {
  const a = rt6Day('2026-08-10', 500.0001), b = rt6Day('2026-08-11', 500.0004);
  const res = price('RT6', '2026-08-10', '2026-08-11', [...a.e, ...b.e], { reactive: [...a.q, ...b.q] });
  assert.equal(line(res, 'NET.DEMAND').length, 2, 'two different MDs => two lines');
  const share = res.demand.offPeakShare;
  const net = md => (34468.2 + 88.518 * (md - 300)) * (1 - share * 0.3);
  approx(res.totals.networkCents, net(500.0001) + net(500.0004), 1e-6);
});
