import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePersonalStats } from '../public/js/personal-stats.js';

const pick = (round_no, team_name, points, settled, is_double = false) => (
  { round_no, team_name, points, settled, is_double }
);

test('personal stats return empty counts and null rates without picks', () => {
  assert.deepEqual(calculatePersonalStats([]), {
    totalPicks: 0, settledPicks: 0, pendingPicks: 0, hits: 0, misses: 0,
    hitRate: null, confirmedPoints: 0, doubleUsed: 0, doubleSettled: 0,
    doublePending: 0, doubleHits: 0, doubleMisses: 0, doubleHitRate: null,
    bestRounds: [], bestClubs: [],
  });
  assert.deepEqual(calculatePersonalStats(), calculatePersonalStats([]));
});

test('positive scores including away draws are hits; live scores remain pending', () => {
  const stats = calculatePersonalStats([
    pick(1, 'Arsenal', 1, true),
    pick(2, 'Chelsea', 0, 1),
    pick(3, 'Fulham', 12, false),
  ]);
  assert.equal(stats.totalPicks, 3);
  assert.equal(stats.settledPicks, 2);
  assert.equal(stats.pendingPicks, 1);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 50);
  assert.equal(stats.confirmedPoints, 1);
  assert.deepEqual(stats.bestRounds, [{ round: 1, points: 1 }]);
  assert.deepEqual(stats.bestClubs, [{ name: 'Arsenal', points: 1 }]);
});

test('pending DOUBLE uses do not enter the DOUBLE hit-rate denominator', () => {
  const stats = calculatePersonalStats([
    pick(1, 'Arsenal', 4, true, 1),
    pick(2, 'Chelsea', 0, 1, true),
    pick(3, 'Fulham', 10, 0, '1'),
    pick(4, 'Everton', 2, true),
  ]);
  assert.equal(stats.doubleUsed, 3);
  assert.equal(stats.doubleSettled, 2);
  assert.equal(stats.doublePending, 1);
  assert.equal(stats.doubleHits, 1);
  assert.equal(stats.doubleMisses, 1);
  assert.equal(stats.doubleHitRate, 50);
  assert.equal(stats.confirmedPoints, 6);
  assert.equal(stats.hitRate, 100 * 2 / 3);
});

test('authoritative imported settlement counts, while provisional match state does not', () => {
  const stats = calculatePersonalStats([
    { ...pick(1, 'Arsenal', 0, true, 1), imported_points: 0, match_status: 'SCHEDULED' },
    { ...pick(2, 'Chelsea', 12, 1, 1), imported_points: 12, match_status: null },
    { ...pick(3, 'Fulham', 2, false, 1), match_status: 'FINISHED' },
    { ...pick(4, 'Everton', 8, false, 1), match_status: 'IN_PLAY' },
  ]);
  assert.equal(stats.confirmedPoints, 12);
  assert.equal(stats.settledPicks, 2);
  assert.equal(stats.pendingPicks, 2);
  assert.equal(stats.doubleHitRate, 50);
  assert.deepEqual(stats.bestRounds, [{ round: 2, points: 12 }]);
});

test('best rounds and aggregated clubs retain ties in deterministic order', () => {
  const stats = calculatePersonalStats([
    pick(4, 'Chelsea', 6, true),
    pick(2, 'Arsenal', 3, true),
    pick(3, 'Bournemouth', 6, true),
    pick(1, 'Arsenal', 3, true),
    pick(5, 'Bournemouth', 0, true),
    pick(6, 'Everton', 2, true),
    pick(7, 'Everton', 50, false),
  ]);
  assert.deepEqual(stats.bestRounds, [{ round: 3, points: 6 }, { round: 4, points: 6 }]);
  assert.deepEqual(stats.bestClubs, [
    { name: 'Arsenal', points: 6 },
    { name: 'Bournemouth', points: 6 },
    { name: 'Chelsea', points: 6 },
  ]);
  assert.equal(stats.confirmedPoints, 20);
});

test('invalid points and non-explicit settlement remain pending', () => {
  const invalid = [null, undefined, '', ' ', true, false, NaN, Infinity, -1, 'no', {}, [], ' -2 '];
  const rows = invalid.map((points, index) => pick(index + 1, 'Arsenal', points, true, 1));
  rows.push(pick(20, 'Chelsea', 5, '1', 1));
  const stats = calculatePersonalStats(rows);
  assert.equal(stats.pendingPicks, rows.length);
  assert.equal(stats.doublePending, rows.length);
  assert.equal(stats.settledPicks, 0);
  assert.equal(stats.confirmedPoints, 0);
  assert.equal(stats.hitRate, null);
  assert.equal(stats.doubleHitRate, null);
  assert.deepEqual(stats.bestRounds, []);
  assert.deepEqual(stats.bestClubs, []);
  const numericStrings = calculatePersonalStats([pick(1, 'Arsenal', ' 2 ', 1), pick(2, 'Chelsea', '0', true)]);
  assert.equal(numericStrings.settledPicks, 2);
  assert.equal(numericStrings.confirmedPoints, 2);
  assert.equal(numericStrings.hitRate, 50);
});

test('only true, 1 and string 1 are counted as DOUBLE use', () => {
  const flags = [true, 1, '1', false, 0, '0', 2, 'true', {}, null];
  const stats = calculatePersonalStats(flags.map((flag, index) => pick(index + 1, 'Arsenal', 2, 1, flag)));
  assert.equal(stats.doubleUsed, 3);
  assert.equal(stats.doubleSettled, 3);
  assert.equal(stats.doubleHits, 3);
  assert.equal(stats.doubleHitRate, 100);
});

test('all-zero settled picks have zero hit rates and no positive bests', () => {
  const stats = calculatePersonalStats([pick(1, 'Arsenal', 0, 1, 1), pick(2, 'Chelsea', 0, true)]);
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 2);
  assert.equal(stats.hitRate, 0);
  assert.equal(stats.doubleHitRate, 0);
  assert.deepEqual(stats.bestRounds, []);
  assert.deepEqual(stats.bestClubs, []);
});

test('calculating and sorting results never mutates input rows', () => {
  const rows = [pick(3, 'Chelsea', 4, true, 1), pick(1, 'Arsenal', 4, true, true)];
  const before = structuredClone(rows);
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  const stats = calculatePersonalStats(rows);
  assert.deepEqual(rows, before);
  assert.deepEqual(stats.bestRounds, [{ round: 1, points: 4 }, { round: 3, points: 4 }]);
});
