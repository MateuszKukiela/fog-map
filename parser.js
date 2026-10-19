// Parses Google location exports into flat point arrays.
// Supported:
//   - Android on-device Timeline export   (Timeline.json: semanticSegments + rawSignals)
//   - iPhone on-device Timeline export    (location-history.json: array of segments, "geo:" coords)
//   - Legacy Takeout Records.json         (locations[] with latitudeE7)
//   - Legacy Takeout Semantic Location History monthly files (timelineObjects[])
//   - Google Photos Takeout sidecar JSON  (geoData)
//   - Immich export from immich-export.mjs ({source: 'immich', photos[]})
//   - Hand-written places ({source: 'manual', places: [{name, lat, lng, date, to?}]})
// Works in the browser (window.FogParser) and in Node (module.exports) for tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FogParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // PATH points are real GPS samples and get connected into tracks.
  // The rest are standalone places.
  const KIND = { PATH: 0, VISIT: 1, ACTIVITY: 2, PHOTO: 3, MANUAL: 4 };

  const MAX_ACCURACY_M = 500;
  // Consecutive PATH points are joined only when the hop looks like real travel,
  // so flights, gaps and phone hand-overs don't paint straight lines across the map.
  const MAX_HOP_M = 30000;
  const MAX_HOP_MS = 30 * 60 * 1000;
  const MAX_SPEED_MPS = 300 / 3.6; // 300 km/h

  function validLatLng(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null; // "no location" placeholder in Photos
    return [lat, lng];
  }

  function fromE7(v) {
    v = Number(v);
    // Old Records.json stored some values as overflowed unsigned ints.
    if (v > 1800000000) v -= 4294967296;
    return v / 1e7;
  }

  const COORD_RE = /(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/;

  // Accepts "52.2297°, 21.0122°", "geo:52.2297,21.0122", {latLng}, {LatLng}, {latitudeE7,...}, {latE7,...},
  // {latitude, longitude}, {lat, lng|lon}
  function parseCoord(v) {
    if (v == null) return null;
    if (typeof v === 'string') {
      const m = COORD_RE.exec(v);
      return m ? validLatLng(parseFloat(m[1]), parseFloat(m[2])) : null;
    }
    if (typeof v !== 'object') return null;
    if (v.latLng != null) return parseCoord(v.latLng);
    if (v.LatLng != null) return parseCoord(v.LatLng);
    if (v.latitudeE7 != null) return validLatLng(fromE7(v.latitudeE7), fromE7(v.longitudeE7));
    if (v.latE7 != null) return validLatLng(fromE7(v.latE7), fromE7(v.lngE7));
    if (v.latitude != null) return validLatLng(Number(v.latitude), Number(v.longitude));
    if (v.lat != null) return validLatLng(Number(v.lat), Number(v.lng != null ? v.lng : v.lon));
    return null;
  }

  // ISO string, epoch ms (number or digit string) or epoch seconds -> epoch ms (NaN if unknown).
  function parseTime(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }

  function createSink() {
    const lat = [],
      lng = [],
      t = [],
      kind = [];
    return {
      lat,
      lng,
      t,
      kind,
      add(coord, time, k) {
        if (!coord) return;
        lat.push(coord[0]);
        lng.push(coord[1]);
        t.push(time);
        kind.push(k);
      },
    };
  }

  // One segment of the on-device Timeline (Android and iPhone share the shape,
  // only coordinate strings and path timing differ).
  function readSegment(seg, sink) {
    if (!seg || typeof seg !== 'object') return;
    const start = parseTime(seg.startTime);
    const end = parseTime(seg.endTime);

    if (seg.visit) {
      const cand = seg.visit.topCandidate || {};
      // Start and end, so the stay's length is known (an overnight hotel vs a fuel stop).
      sink.add(parseCoord(cand.placeLocation), start, KIND.VISIT);
      if (end > start) sink.add(parseCoord(cand.placeLocation), end, KIND.VISIT);
    }
    if (seg.activity) {
      sink.add(parseCoord(seg.activity.start), start, KIND.ACTIVITY);
      sink.add(parseCoord(seg.activity.end), end, KIND.ACTIVITY);
    }
    if (Array.isArray(seg.timelinePath)) {
      for (const p of seg.timelinePath) {
        let time = parseTime(p.time);
        if (!Number.isFinite(time) && p.durationMinutesOffsetFromStartTime != null) {
          time = start + Number(p.durationMinutesOffsetFromStartTime) * 60000;
        }
        sink.add(parseCoord(p.point), time, KIND.PATH);
      }
    }
  }

  function readRawSignal(sig, sink) {
    const pos = sig?.position;
    if (!pos) return;
    if (Number(pos.accuracyMeters) > MAX_ACCURACY_M) return;
    sink.add(parseCoord(pos), parseTime(pos.timestamp), KIND.PATH);
  }

  function readRecord(loc, sink) {
    if (Number(loc.accuracy) > MAX_ACCURACY_M) return;
    sink.add(parseCoord(loc), parseTime(loc.timestamp != null ? loc.timestamp : loc.timestampMs), KIND.PATH);
  }

  function durationStart(d) {
    return d ? parseTime(d.startTimestamp != null ? d.startTimestamp : d.startTimestampMs) : NaN;
  }
  function durationEnd(d) {
    return d ? parseTime(d.endTimestamp != null ? d.endTimestamp : d.endTimestampMs) : NaN;
  }

  function readTimelineObject(obj, sink) {
    if (obj.placeVisit) {
      const v = obj.placeVisit;
      const vs = durationStart(v.duration),
        ve = durationEnd(v.duration);
      sink.add(parseCoord(v.location), vs, KIND.VISIT);
      if (ve > vs) sink.add(parseCoord(v.location), ve, KIND.VISIT);
    }
    if (obj.activitySegment) {
      const a = obj.activitySegment;
      const start = durationStart(a.duration);
      const end = durationEnd(a.duration);
      sink.add(parseCoord(a.startLocation), start, KIND.ACTIVITY);
      sink.add(parseCoord(a.endLocation), end, KIND.ACTIVITY);
      const raw = a.simplifiedRawPath?.points;
      if (Array.isArray(raw)) {
        for (const p of raw) {
          if (Number(p.accuracyMeters) > MAX_ACCURACY_M) continue;
          sink.add(parseCoord(p), parseTime(p.timestamp != null ? p.timestamp : p.timestampMs), KIND.PATH);
        }
      }
      // Waypoints carry no timestamps; spread them evenly over the activity.
      const wps = a.waypointPath?.waypoints;
      if (Array.isArray(wps)) {
        const n = wps.length;
        wps.forEach((w, i) => {
          const time = n > 1 ? start + (end - start) * (i / (n - 1)) : start;
          sink.add(parseCoord(w), time, KIND.PATH);
        });
      }
    }
  }

  function readPhoto(obj, sink) {
    const taken = obj.photoTakenTime || obj.creationTime || {};
    sink.add(parseCoord(obj.geoData) || parseCoord(obj.geoDataExif), parseTime(taken.timestamp), KIND.PHOTO);
  }

  // Returns { format, lat, lng, t, kind } with typed arrays.
  function parse(json) {
    const sink = createSink();
    let format = 'unknown';

    if (Array.isArray(json)) {
      format = 'iphone-timeline';
      for (const seg of json) readSegment(seg, sink);
    } else if (json && typeof json === 'object') {
      if (Array.isArray(json.semanticSegments) || Array.isArray(json.rawSignals)) {
        format = 'android-timeline';
        for (const seg of json.semanticSegments || []) readSegment(seg, sink);
        for (const sig of json.rawSignals || []) readRawSignal(sig, sink);
      } else if (Array.isArray(json.locations)) {
        format = 'takeout-records';
        for (const loc of json.locations) readRecord(loc, sink);
      } else if (Array.isArray(json.timelineObjects)) {
        format = 'takeout-semantic';
        for (const obj of json.timelineObjects) readTimelineObject(obj, sink);
      } else if (json.source === 'immich' && Array.isArray(json.photos)) {
        format = 'immich';
        for (const p of json.photos) sink.add(parseCoord(p), parseTime(p.time), KIND.PHOTO);
      } else if (json.source === 'manual' && Array.isArray(json.places)) {
        format = 'manual';
        // Date-only entries mean midday local time, so they land on the right day.
        const midday = (d) => parseTime(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : d);
        for (const p of json.places) {
          const start = midday(p.date),
            end = p.to ? midday(p.to) : start;
          // One point per day of a stay; setDate keeps midday across DST changes.
          for (const d = new Date(start); d.getTime() <= end; d.setDate(d.getDate() + 1)) {
            sink.add(parseCoord(p), d.getTime(), KIND.MANUAL);
          }
        }
      } else if (json.geoData || json.geoDataExif) {
        format = 'google-photos';
        readPhoto(json, sink);
      }
    }

    return {
      format,
      lat: Float64Array.from(sink.lat),
      lng: Float64Array.from(sink.lng),
      t: Float64Array.from(sink.t),
      kind: Uint8Array.from(sink.kind),
    };
  }

  // Concatenates parsed files, dropping exact duplicates (same file loaded twice,
  // overlapping exports from two phones).
  function merge(parts) {
    const seen = new Set();
    const sink = createSink();
    for (const p of parts) {
      for (let i = 0; i < p.lat.length; i++) {
        const key = p.kind[i] + '|' + p.t[i] + '|' + p.lat[i].toFixed(6) + '|' + p.lng[i].toFixed(6);
        if (seen.has(key)) continue;
        seen.add(key);
        sink.add([p.lat[i], p.lng[i]], p.t[i], p.kind[i]);
      }
    }
    return {
      lat: Float64Array.from(sink.lat),
      lng: Float64Array.from(sink.lng),
      t: Float64Array.from(sink.t),
      kind: Uint8Array.from(sink.kind),
    };
  }

  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371008.8;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Joins time-ordered PATH points into segments. Returns Uint32Array of index pairs.
  function buildSegments(data) {
    const idx = [];
    for (let i = 0; i < data.lat.length; i++) {
      if (data.kind[i] === KIND.PATH && Number.isFinite(data.t[i])) idx.push(i);
    }
    idx.sort((a, b) => data.t[a] - data.t[b]);

    const pairs = [];
    for (let k = 1; k < idx.length; k++) {
      const a = idx[k - 1],
        b = idx[k];
      const dt = data.t[b] - data.t[a];
      if (dt > MAX_HOP_MS) continue;
      const d = distanceM(data.lat[a], data.lng[a], data.lat[b], data.lng[b]);
      if (d < 1 || d > MAX_HOP_M) continue;
      if (dt > 0 ? d / (dt / 1000) > MAX_SPEED_MPS : d > 1000) continue;
      pairs.push(a, b);
    }
    return Uint32Array.from(pairs);
  }

  return { KIND, parse, merge, buildSegments, parseCoord, parseTime, distanceM };
});
