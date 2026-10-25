// Day-by-day view: points grouped into local calendar days, a day's route, stops and position at a time.
// Pure functions, tested in Node; the UI lives in app.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser.js'));
  else root.FogDay = factory(root.FogParser);
})(typeof self !== 'undefined' ? self : this, function (parser) {
  const { hopOk, distanceM } = parser;

  const STOP_RADIUS_M = 100;
  const STOP_MIN_MS = 10 * 60000;
  const GAP_MIN_M = 100; // shorter unlinked hops are standing still, not a gap worth drawing

  // Local midnight of the day containing t (DST-safe).
  function dayStart(t) {
    return new Date(t).setHours(0, 0, 0, 0);
  }

  // Map of local midnight -> point indices of that day sorted by time; only timed, included points.
  function byDay(data, include) {
    const days = new Map();
    for (let i = 0; i < data.t.length; i++) {
      const t = data.t[i];
      if (!Number.isFinite(t) || (include && !include[i])) continue;
      const d = dayStart(t);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(i);
    }
    for (const [d, idx] of days) days.set(d, Uint32Array.from(idx.sort((a, b) => data.t[a] - data.t[b])));
    return days;
  }

  // One day's track: time-sorted points, link[k] = 1 when points k and k+1 are joined by a line,
  // gap[k] = 1 when they aren't but are far apart (no data in between), distance in km and
  // stops (>= 10 min within ~100 m).
  function track(data, idx) {
    const n = idx.length;
    const t = new Float64Array(n),
      lat = new Float64Array(n),
      lng = new Float64Array(n),
      link = new Uint8Array(n),
      gap = new Uint8Array(n);
    let m = 0;
    for (let k = 0; k < n; k++) {
      t[k] = data.t[idx[k]];
      lat[k] = data.lat[idx[k]];
      lng[k] = data.lng[idx[k]];
      if (k + 1 === n) break;
      const d = distanceM(lat[k], lng[k], data.lat[idx[k + 1]], data.lng[idx[k + 1]]);
      if (hopOk(data, idx[k], idx[k + 1])) {
        link[k] = 1;
        m += d;
      } else if (d > GAP_MIN_M) gap[k] = 1;
    }

    const stops = [];
    for (let i = 0; i < n; ) {
      let cLat = lat[i],
        cLng = lng[i],
        j = i + 1;
      // Grow the cluster while points stay near its running centroid.
      for (; j < n && distanceM(cLat, cLng, lat[j], lng[j]) <= STOP_RADIUS_M; j++) {
        cLat += (lat[j] - cLat) / (j - i + 1);
        cLng += (lng[j] - cLng) / (j - i + 1);
      }
      if (t[j - 1] - t[i] < STOP_MIN_MS) {
        i++;
        continue;
      }
      const last = stops[stops.length - 1];
      if (last && distanceM(last.lat, last.lng, cLat, cLng) <= 2 * STOP_RADIUS_M) last.to = t[j - 1];
      else stops.push({ lat: cLat, lng: cLng, from: t[i], to: t[j - 1] });
      i = j;
    }

    return { t, lat, lng, link, gap, km: m / 1000, stops };
  }

  // Display copy of a track: each linked run rounded off by Chaikin corner cutting (ends kept),
  // so GPS jitter doesn't zigzag. Times are cut the same way, so positionAt works on it.
  function smooth(tr, rounds = 2) {
    const t = [],
      lat = [],
      lng = [],
      link = [];
    const n = tr.t.length;
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && tr.link[j]) j++;
      let run = [];
      for (let k = i; k <= j; k++) run.push([tr.t[k], tr.lat[k], tr.lng[k]]);
      for (let r = 0; r < rounds && run.length > 2; r++) {
        const out = [run[0]];
        for (let k = 0; k + 1 < run.length; k++) {
          const a = run[k],
            b = run[k + 1];
          const mix = (f) => a.map((v, c) => v + (b[c] - v) * f);
          if (k > 0) out.push(mix(0.25));
          if (k + 2 < run.length) out.push(mix(0.75));
        }
        out.push(run[run.length - 1]);
        run = out;
      }
      for (const p of run) {
        t.push(p[0]);
        lat.push(p[1]);
        lng.push(p[2]);
        link.push(1);
      }
      link[link.length - 1] = 0;
      i = j + 1;
    }
    return { t: Float64Array.from(t), lat: Float64Array.from(lat), lng: Float64Array.from(lng), link: Uint8Array.from(link) };
  }

  // [lat, lng] at time `at`: interpolated along a line, otherwise held at the last known point.
  function positionAt(tr, at) {
    const { t, lat, lng, link } = tr;
    let lo = 0,
      hi = t.length - 1;
    if (at <= t[0]) return [lat[0], lng[0]];
    if (at >= t[hi]) return [lat[hi], lng[hi]];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= at) lo = mid;
      else hi = mid;
    }
    if (!link[lo] || t[hi] === t[lo]) return [lat[lo], lng[lo]];
    const f = (at - t[lo]) / (t[hi] - t[lo]);
    return [lat[lo] + (lat[hi] - lat[lo]) * f, lng[lo] + (lng[hi] - lng[lo]) * f];
  }

  return { dayStart, byDay, track, smooth, positionAt };
});
