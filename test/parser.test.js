const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { KIND, parse, merge, buildSegments, parseCoord, parseTime } = require('../parser.js');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const kinds = (d) => Array.from(d.kind);

test('parseCoord handles every coordinate encoding', () => {
  assert.deepEqual(parseCoord('52.2297°, 21.0122°'), [52.2297, 21.0122]);
  assert.deepEqual(parseCoord('geo:41.3851,2.1734'), [41.3851, 2.1734]);
  assert.equal(parseCoord('-33.8688°, 191.2093°'), null); // lng out of range
  assert.deepEqual(parseCoord('-33.8688°, 151.2093°'), [-33.8688, 151.2093]);
  assert.deepEqual(parseCoord({ latLng: '1.5°, 2.5°' }), [1.5, 2.5]);
  assert.deepEqual(parseCoord({ latitudeE7: 407128000, longitudeE7: -740060000 }), [40.7128, -74.006]);
  assert.deepEqual(parseCoord({ latE7: 10, lngE7: 20 }), [1e-6, 2e-6]);
  assert.equal(parseCoord({ latitude: 0, longitude: 0 }), null);
  assert.equal(parseCoord('nonsense'), null);
});

test('parseTime handles ISO, ms and seconds', () => {
  assert.equal(parseTime('2019-03-01T12:00:00.000Z'), 1551441600000);
  assert.equal(parseTime('1551441660000'), 1551441660000);
  assert.equal(parseTime('1600000000'), 1600000000000);
  assert.ok(Number.isNaN(parseTime(undefined)));
});

test('android Timeline.json: paths, visits, activities, raw signals', () => {
  const d = parse(fixture('android-timeline.json'));
  assert.equal(d.format, 'android-timeline');
  // 3 path + 1 visit + 2 activity + 1 raw (the 2000 m CELL fix is dropped)
  assert.deepEqual(kinds(d), [0, 0, 0, 1, 2, 2, 0]);
  assert.equal(d.lat[3], 52.233);
  assert.equal(d.t[0], Date.parse('2025-05-01T08:00:00.000+02:00'));
});

test('iPhone export: geo: strings and minute offsets', () => {
  const d = parse(fixture('iphone-timeline.json'));
  assert.equal(d.format, 'iphone-timeline');
  assert.deepEqual(kinds(d), [1, 2, 2, 0, 0, 0]);
  const start = Date.parse('2024-07-10T10:00:00.000+02:00');
  assert.equal(d.t[4], start + 10 * 60000);
  assert.equal(d.lng[5], 2.1744);
});

test('legacy Records.json: drops inaccurate and 0,0 fixes', () => {
  const d = parse(fixture('takeout-records.json'));
  assert.equal(d.format, 'takeout-records');
  assert.equal(d.lat.length, 2);
  assert.equal(d.t[1], 1551441660000);
});

test('legacy Semantic Location History: waypoints get interpolated times', () => {
  const d = parse(fixture('takeout-semantic.json'));
  assert.equal(d.format, 'takeout-semantic');
  assert.deepEqual(kinds(d), [2, 2, 0, 0, 0, 1]);
  const start = Date.parse('2018-06-01T10:00:00Z');
  assert.equal(d.t[3], start + 10 * 60000);
  assert.equal(d.t[5], 1527848400000);
});

test('Google Photos sidecar falls back to EXIF location', () => {
  const d = parse(fixture('photo.json'));
  assert.equal(d.format, 'google-photos');
  assert.deepEqual([d.lat[0], d.lng[0], d.kind[0]], [48.8584, 2.2945, KIND.PHOTO]);
  assert.equal(d.t[0], 1600000000000);
});

test('manual places: date-only means local midday, always kind MANUAL', () => {
  const d = parse({ source: 'manual', places: [{ name: 'San Marino', lat: 43.9356, lng: 12.4473, date: '2015-07-20' }] });
  assert.equal(d.format, 'manual');
  assert.deepEqual([d.lat[0], d.lng[0], d.kind[0]], [43.9356, 12.4473, KIND.MANUAL]);
  assert.equal(d.t[0], new Date(2015, 6, 20, 12).getTime());
});

test('unknown JSON yields no points', () => {
  const d = parse({ hello: 'world' });
  assert.equal(d.format, 'unknown');
  assert.equal(d.lat.length, 0);
});

test('merge drops duplicates across files', () => {
  const a = parse(fixture('android-timeline.json'));
  const b = parse(fixture('iphone-timeline.json'));
  const m = merge([a, a, b]);
  assert.equal(m.lat.length, a.lat.length + b.lat.length);
});

test('buildSegments joins walking hops but not the flight gap', () => {
  const d = parse(fixture('android-timeline.json'));
  const segs = Array.from(buildSegments(d));
  // Warsaw walk: 0-1, 1-2. Kraków raw point is 2.5 h later, not joined.
  assert.deepEqual(segs, [0, 1, 1, 2]);
});

test('buildSegments rejects implausible speed', () => {
  const d = {
    lat: Float64Array.from([52.0, 52.5]),
    lng: Float64Array.from([21.0, 21.0]),
    t: Float64Array.from([0, 60000]), // 55 km in 1 min
    kind: Uint8Array.from([0, 0]),
  };
  assert.equal(buildSegments(d).length, 0);
});
