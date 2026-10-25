const test = require('node:test');
const assert = require('node:assert/strict');
const { byDay, track, smooth, positionAt } = require('../day.js');

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();
// Home 08:00-08:30, walk ~1.1 km east in 15 min, café 08:45-09:15, then late evening the day before.
const rows = [
  [52.23, 21.0, at(8)],
  [52.2301, 21.0001, at(8, 15)],
  [52.23, 21.0, at(8, 30)],
  [52.23, 21.008, at(8, 37)],
  [52.23, 21.016, at(8, 45)],
  [52.2301, 21.016, at(9)],
  [52.23, 21.016, at(9, 15)],
  [52.25, 21.016, at(11)], // 2 km north, nearly 2 h later: no data in between
  [50, 19, at(23, 0, 11)],
];
const data = {
  lat: Float64Array.from(rows, (r) => r[0]),
  lng: Float64Array.from(rows, (r) => r[1]),
  t: Float64Array.from(rows, (r) => r[2]),
  kind: new Uint8Array(rows.length),
};

test('byDay groups by local day, sorted, honoring include', () => {
  const days = byDay(data, null);
  assert.deepEqual([...days.keys()].sort(), [at(0, 0, 11), at(0)]);
  assert.deepEqual([...days.get(at(0))], [0, 1, 2, 3, 4, 5, 6, 7]);
  const include = new Uint8Array(rows.length).fill(1);
  include[8] = 0;
  assert.deepEqual([...byDay(data, include).keys()], [at(0)]);
});

test('track finds stops, distance and positions along the route', () => {
  const tr = track(data, byDay(data, null).get(at(0)));
  assert.equal(tr.stops.length, 2);
  assert.equal(tr.stops[0].from, at(8));
  assert.equal(tr.stops[0].to, at(8, 30));
  assert.equal(tr.stops[1].from, at(8, 45));
  assert.ok(tr.km > 1 && tr.km < 1.3, String(tr.km));
  assert.deepEqual(positionAt(tr, at(7)), [52.23, 21.0]); // before the first point: hold it
  const [lat, lng] = positionAt(tr, at(8, 41));
  assert.equal(lat, 52.23);
  assert.ok(lng > 21.008 && lng < 21.016);
  assert.deepEqual(positionAt(tr, at(10)), [52.23, 21.016]); // in the gap: hold the last fix
  assert.deepEqual(positionAt(tr, at(22)), [52.25, 21.016]);
  assert.deepEqual([...tr.gap], [0, 0, 0, 0, 0, 0, 1, 0]); // only the 2 km jump, not standing still
});

test('smooth rounds runs, keeps their ends, gaps and time order', () => {
  const tr = track(data, byDay(data, null).get(at(0)));
  const sm = smooth(tr);
  assert.ok(sm.t.length > tr.t.length);
  for (let k = 1; k < sm.t.length; k++) assert.ok(sm.t[k] >= sm.t[k - 1]);
  assert.equal(sm.t[0], tr.t[0]);
  assert.equal(sm.lat[sm.t.length - 1], 52.25); // the point after the gap stays put
  assert.equal(sm.link.filter((l) => !l).length, tr.link.filter((l) => !l).length); // same breaks
  const [lat, lng] = positionAt(sm, at(8, 41));
  assert.ok(Math.abs(lat - 52.23) < 1e-4 && lng > 21.008 && lng < 21.016);
});
