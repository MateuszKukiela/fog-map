(function () {
  'use strict';
  const { parse, merge, buildSegments, distanceM } = window.FogParser;
  const { prepare, stats, FogLayer } = window.Fog;

  const $ = (id) => document.getElementById(id);
  const state = { data: null, segments: null, parts: [], years: new Set() }; // parts: [{name, data}], one per file

  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [15, 50],
    zoom: 3,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    maxPitch: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  const fog = new FogLayer(map);

  // ---------- loading ----------

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  async function readFiles(files) {
    let added = 0;
    for (const f of files) {
      if (!/\.json$/i.test(f.name)) continue;
      setStatus(`Reading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
      await new Promise(requestAnimationFrame);
      try {
        const d = parse(JSON.parse(await f.text()));
        if (d.lat.length) {
          // Same file name again = newer version of that file, replace it.
          state.parts = state.parts.filter((p) => p.name !== f.name);
          state.parts.push({ name: f.name, data: d });
          added++;
        }
      } catch (err) {
        console.warn(f.name, err);
      }
    }
    if (!added) {
      setStatus('No location points found. Expected Timeline.json, location-history.json, Records.json, immich-photos.json or manual-places.json.', true);
      return;
    }
    rebuild(true);
  }

  function rebuild(fit) {
    save();
    if (!state.parts.length) {
      state.data = null;
      fog.setData(null);
      document.body.classList.remove('has-data');
      return;
    }
    setData(state.parts.length === 1 ? state.parts[0].data : merge(state.parts.map((p) => p.data)), fit);
  }

  // Folder drops (Takeout "Semantic Location History", Photos) arrive as directory entries.
  async function filesFromDrop(dt) {
    const entries = Array.from(dt.items || []).map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return Array.from(dt.files);
    const out = [];
    async function walk(entry) {
      if (entry.isFile) {
        out.push(await new Promise((res, rej) => entry.file(res, rej)));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e);
    return out;
  }

  function setData(data, fit) {
    state.data = data;
    state.segments = buildSegments(data);
    state.countryIdx = classifyCountries(data);
    state.airport = airportMask(data);
    state.credible = credibility(data, state.countryIdx, state.airport);
    const years = new Set();
    for (const t of data.t) if (Number.isFinite(t)) years.add(new Date(t).getFullYear());
    state.allYears = Array.from(years).sort();
    state.years = new Set();
    renderYears();
    renderAbroad();
    applyFilter();
    document.body.classList.add('has-data');
    setStatus('');
    if (fit) fitToData();
  }

  function fitToData() {
    const { lat, lng } = state.data;
    let s = 90, n = -90, w = 180, e = -180;
    for (let i = 0; i < lat.length; i++) {
      if (lat[i] < s) s = lat[i];
      if (lat[i] > n) n = lat[i];
      if (lng[i] < w) w = lng[i];
      if (lng[i] > e) e = lng[i];
    }
    map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 12, duration: 0 });
  }

  // ---------- filtering + stats ----------

  function applyFilter() {
    const { data, segments, years } = state;
    const include = state.credible.slice();
    if (years.size) {
      for (let i = 0; i < include.length; i++) {
        const t = data.t[i];
        if (!(Number.isFinite(t) && years.has(new Date(t).getFullYear()))) include[i] = 0;
      }
    }
    fog.setData(prepare(data, segments, include));
    renderStats(stats(data, segments, include), countCountries(include));
  }

  // ---------- countries (Natural Earth borders, countries.js) ----------

  const COUNTRY_CELL_DEG = 0.01; // ~1 km lookup cache
  const COAST_TOLERANCE_DEG = 0.05; // ~5 km: airports on reclaimed land, beaches, ferries
  const MIN_COUNTRY_WEIGHT = 3; // 3 GPS points, or any visit/photo, so border noise doesn't add countries

  function inPolygon(rings, x, y) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  function countryAt(lng, lat) {
    for (let k = 0; k < COUNTRIES.length; k++) {
      const b = COUNTRIES[k].b;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      for (const poly of COUNTRIES[k].p) if (inPolygon(poly, lng, lat)) return k;
    }
    return nearestCountry(lng, lat);
  }

  // Fallback for points just outside the simplified coastline.
  function nearestCountry(lng, lat) {
    const tol = COAST_TOLERANCE_DEG;
    const sx = Math.cos(lat * Math.PI / 180);
    let best = -1, bestD = tol * tol;
    for (let k = 0; k < COUNTRIES.length; k++) {
      const b = COUNTRIES[k].b;
      if (lng < b[0] - tol || lng > b[2] + tol || lat < b[1] - tol || lat > b[3] + tol) continue;
      for (const poly of COUNTRIES[k].p) {
        for (const r of poly) {
          for (let i = 2; i < r.length; i += 2) {
            const ax = (r[i - 2] - lng) * sx, ay = r[i - 1] - lat;
            const bx = (r[i] - lng) * sx, by = r[i + 1] - lat;
            const dx = bx - ax, dy = by - ay;
            const len = dx * dx + dy * dy;
            const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
            const d = (ax + t * dx) ** 2 + (ay + t * dy) ** 2;
            if (d < bestD) { bestD = d; best = k; }
          }
        }
      }
    }
    return best;
  }

  function classifyCountries(data) {
    const out = new Int16Array(data.lat.length);
    const cache = new Map();
    for (let i = 0; i < out.length; i++) {
      const ix = Math.floor(data.lng[i] / COUNTRY_CELL_DEG);
      const iy = Math.floor(data.lat[i] / COUNTRY_CELL_DEG);
      const key = ix * 100000 + iy;
      let k = cache.get(key);
      if (k === undefined) {
        k = countryAt((ix + 0.5) * COUNTRY_CELL_DEG, (iy + 0.5) * COUNTRY_CELL_DEG);
        cache.set(key, k);
      }
      out[i] = k;
    }
    return out;
  }

  function countCountries(include) {
    const { data, countryIdx } = state;
    const weight = new Map();
    for (let i = 0; i < countryIdx.length; i++) {
      if ((include && !include[i]) || countryIdx[i] < 0 || state.airport[i]) continue;
      weight.set(countryIdx[i], (weight.get(countryIdx[i]) || 0) + (data.kind[i] === 0 ? 1 : MIN_COUNTRY_WEIGHT));
    }
    return Array.from(weight).filter(([, w]) => w >= MIN_COUNTRY_WEIGHT).sort((a, b) => b[1] - a[1]).map(([k]) => COUNTRIES[k]);
  }

  const HOME_COUNTRY = 'PL';

  const DAY_MS = 86400000;
  const FLIGHT_MPS = 70; // ~250 km/h: faster than any car/train, so the fix was taken from a plane
  const MIN_STAY_MS = 3600000; // one day in a country counts if presence spans 1 h+ ...
  const STAY_WINDOW_DAYS = 7; // ... or the country shows up again within a week
  const MAX_GAP_FILL_DAYS = 5; // days without data between two days abroad still count as abroad
  const TELEPORT_MPS = 300; // ~1080 km/h, faster than any airliner
  const CLUSTER_M = 50000;

  const localDay = (t) => Math.floor((t - new Date(t).getTimezoneOffset() * 60000) / DAY_MS);

  // 1 = keep, 0 = noise: points taken in flight, and one-off country appearances
  // (flyovers, photos received from others, wrong timestamps).
  // 1 = point is inside an airport (airports.js). Airports still clear fog but never count as a
  // country or a day abroad, so layovers don't add trips.
  function airportMask(data) {
    const key = (cy, cx) => cy * 4000 + cx; // 0.1° buckets
    const grid = new Map();
    for (const a of AIRPORTS) {
      const k = key(Math.floor(a[0] * 10), Math.floor(a[1] * 10));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(a);
    }
    const out = new Uint8Array(data.lat.length);
    for (let i = 0; i < out.length; i++) {
      const lat = data.lat[i], lng = data.lng[i];
      const cy = Math.floor(lat * 10), cx = Math.floor(lng * 10);
      search: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const a of grid.get(key(cy + dy, cx + dx)) || []) {
            if (distanceM(lat, lng, a[0], a[1]) <= a[2] * 1000) { out[i] = 1; break search; }
          }
        }
      }
    }
    return out;
  }

  function credibility(data, countryIdx, airport) {
    const n = data.lat.length;
    const ok = new Uint8Array(n).fill(1);

    const speed = (a, b) => {
      const dt = (data.t[b] - data.t[a]) / 1000;
      return dt > 0 ? distanceM(data.lat[a], data.lng[a], data.lat[b], data.lng[b]) / dt : 0;
    };
    const dist = (a, b) => distanceM(data.lat[a], data.lng[a], data.lat[b], data.lng[b]);

    // All timed fixes from every source (manual places are trusted, skipped).
    let timed = [];
    for (let i = 0; i < n; i++) if (data.kind[i] !== 4 && Number.isFinite(data.t[i])) timed.push(i);
    timed.sort((a, b) => data.t[a] - data.t[b]);

    // In flight: arrived and left at plane speed (GPS fixes and window photos alike).
    for (let j = 1; j < timed.length - 1; j++) {
      if (speed(timed[j - 1], timed[j]) > FLIGHT_MPS && speed(timed[j], timed[j + 1]) > FLIGHT_MPS) ok[timed[j]] = 0;
    }
    timed = timed.filter((i) => ok[i]);

    // Teleports: a small burst of fixes far away, with the same place before and after,
    // reached or left faster than any plane (Wi-Fi geolocation glitches, e.g. a night "in
    // Manchester" while asleep in Poland). Fixes are grouped into 50 km clusters in time order;
    // only the smaller side counts as the glitch, so a real trip isn't dropped because of
    // bogus jumps back home.
    const clusters = [];
    for (let j = 0; j < timed.length; j++) {
      const c = clusters[clusters.length - 1];
      if (c && dist(timed[c[0]], timed[j]) <= CLUSTER_M) c[1] = j;
      else clusters.push([j, j]);
    }
    const size = (c) => clusters[c][1] - clusters[c][0] + 1;
    for (let c = 1; c < clusters.length - 1; c++) {
      const prev = timed[clusters[c - 1][1]], first = timed[clusters[c][0]];
      const last = timed[clusters[c][1]], next = timed[clusters[c + 1][0]];
      if (dist(prev, next) > CLUSTER_M) continue;
      if (size(c) >= Math.min(size(c - 1), size(c + 1))) continue;
      if (Math.max(speed(prev, first), speed(last, next)) <= TELEPORT_MPS) continue;
      for (let j = clusters[c][0]; j <= clusters[c][1]; j++) ok[timed[j]] = 0;
    }

    const groups = new Map(); // country*1e5 + day -> {min, max, idx}
    const days = new Map(); // country -> Set(day)
    for (let i = 0; i < n; i++) {
      const k = countryIdx[i], t = data.t[i];
      // Hand-added places are trusted as-is: never grouped, so never dropped.
      if (!ok[i] || airport[i] || data.kind[i] === 4 || k < 0 || !Number.isFinite(t)) continue;
      const day = localDay(t);
      const key = k * 1e5 + day;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { min: t, max: t, idx: [] }));
      g.min = Math.min(g.min, t);
      g.max = Math.max(g.max, t);
      g.idx.push(i);
      if (!days.has(k)) days.set(k, new Set());
      days.get(k).add(day);
    }
    for (const [key, g] of groups) {
      const k = Math.floor(key / 1e5), day = key % 1e5;
      if (g.max - g.min >= MIN_STAY_MS || COUNTRIES[k].c === HOME_COUNTRY) continue;
      let again = false;
      for (let d = 1; d <= STAY_WINDOW_DAYS && !again; d++) again = days.get(k).has(day - d) || days.get(k).has(day + d);
      if (!again) for (const i of g.idx) ok[i] = 0;
    }
    return ok;
  }

  // year -> days spent outside HOME_COUNTRY, with short data gaps inside a trip filled in
  function daysAbroadByYear() {
    const { data, countryIdx, credible } = state;
    const abroad = new Set(), home = new Set();
    for (let i = 0; i < countryIdx.length; i++) {
      const k = countryIdx[i], t = data.t[i];
      if (!credible[i] || state.airport[i] || k < 0 || !Number.isFinite(t)) continue;
      (COUNTRIES[k].c === HOME_COUNTRY ? home : abroad).add(localDay(t));
    }
    const sorted = Array.from(abroad).sort((a, b) => a - b);
    for (let j = 1; j < sorted.length; j++) {
      const a = sorted[j - 1], b = sorted[j];
      if (b - a - 1 > MAX_GAP_FILL_DAYS) continue;
      let wasHome = false;
      for (let d = a + 1; d < b && !wasHome; d++) wasHome = home.has(d);
      if (!wasHome) for (let d = a + 1; d < b; d++) abroad.add(d);
    }
    const years = new Map();
    for (const d of abroad) {
      const y = new Date(d * DAY_MS).getUTCFullYear();
      years.set(y, (years.get(y) || 0) + 1);
    }
    return years;
  }

  function renderAbroad() {
    const years = daysAbroadByYear();
    const max = Math.max(1, ...years.values());
    $('abroad').innerHTML = '';
    for (const y of state.allYears) {
      const n = years.get(y) || 0;
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = `<span>${y}</span><i style="width:${(n / max) * 100}%"></i><b>${n}</b>`;
      $('abroad').appendChild(row);
    }
  }

  const flag = (code) => (code ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '🏳️');

  const fmt = (n) => Math.round(n).toLocaleString();
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  function renderStats(s, countries) {
    $('stat-area').textContent = s.areaKm2 < 10 ? s.areaKm2.toFixed(1) : fmt(s.areaKm2);
    $('stat-places').textContent = fmt(s.places);
    $('stat-days').textContent = fmt(s.days);
    $('stat-points').textContent = fmt(s.points);
    $('stat-countries').textContent = countries.length;
    $('flags').innerHTML = '';
    for (const c of countries) {
      const span = document.createElement('span');
      span.textContent = flag(c.c);
      span.title = c.n;
      $('flags').appendChild(span);
    }
    $('range').textContent = s.first ? `${fmtDate(s.first)} – ${fmtDate(s.last)}` : 'No dates';
    $('files').innerHTML = '';
    for (const p of state.parts) {
      const li = document.createElement('li');
      li.textContent = `${p.name} · ${p.data.lat.length.toLocaleString()} pts `;
      const x = document.createElement('button');
      x.className = 'remove';
      x.textContent = '✕';
      x.title = `Remove ${p.name}`;
      x.onclick = () => { state.parts = state.parts.filter((q) => q !== p); rebuild(false); };
      li.appendChild(x);
      $('files').appendChild(li);
    }
  }

  function renderYears() {
    const box = $('years');
    box.innerHTML = '';
    const mk = (label, active, onClick) => {
      const b = document.createElement('button');
      b.className = 'chip' + (active ? ' active' : '');
      b.textContent = label;
      b.onclick = onClick;
      box.appendChild(b);
    };
    mk('All', state.years.size === 0, () => { state.years.clear(); renderYears(); applyFilter(); });
    for (const y of state.allYears) {
      mk(String(y), state.years.has(y), (ev) => {
        // Click = only this year, shift/cmd-click = add to selection.
        if (!(ev.shiftKey || ev.metaKey || ev.ctrlKey)) state.years.clear();
        if (state.years.has(y)) state.years.delete(y); else state.years.add(y);
        renderYears();
        applyFilter();
      });
    }
  }

  // ---------- persistence (IndexedDB, this browser only) ----------

  function db() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('fog-map', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function save() {
    try {
      const parts = state.parts.map(({ name, data: d }) => ({ name, lat: d.lat, lng: d.lng, t: d.t, kind: d.kind }));
      const tx = (await db()).transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ parts }, 'data');
    } catch (err) { console.warn('save failed', err); }
  }

  // Data saved before per-file storage was one merged blob. Point kind maps to the source
  // (GPS/visits/activities = Timeline, 3 = photos, 4 = manual), so split it back that way.
  function splitBySource(d) {
    const groups = [['Timeline (saved earlier)', [0, 1, 2]], ['Photos (saved earlier)', [3]], ['Manual places (saved earlier)', [4]]];
    const out = [];
    for (const [name, kinds] of groups) {
      const idx = [];
      for (let i = 0; i < d.kind.length; i++) if (kinds.includes(d.kind[i])) idx.push(i);
      if (!idx.length) continue;
      const pick = (arr, Type) => Type.from(idx, (i) => arr[i]);
      out.push({ name, data: { lat: pick(d.lat, Float64Array), lng: pick(d.lng, Float64Array), t: pick(d.t, Float64Array), kind: pick(d.kind, Uint8Array) } });
    }
    return out;
  }

  async function restore() {
    try {
      const store = (await db()).transaction('kv').objectStore('kv');
      const v = await new Promise((res, rej) => {
        const r = store.get('data');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (v && v.parts) {
        state.parts = v.parts.map(({ name, ...data }) => ({ name, data }));
      } else if (v && v.lat && v.lat.length) {
        state.parts = [{ name: 'earlier files (merged)', data: { lat: v.lat, lng: v.lng, t: v.t, kind: v.kind } }];
      }
      state.parts = state.parts.flatMap((p) => (p.name === 'earlier files (merged)' ? splitBySource(p.data) : [p]));
      if (state.parts.length) rebuild(true);
    } catch (err) { console.warn('restore failed', err); }
  }

  function clearAll() {
    state.parts = [];
    rebuild(false);
  }

  // ---------- wiring ----------

  $('pick').onclick = () => $('file').click();
  $('add').onclick = () => $('file').click();
  $('file').onchange = (e) => { readFiles(Array.from(e.target.files)); e.target.value = ''; };
  $('clear').onclick = clearAll;
  $('collapse').onclick = () => document.body.classList.toggle('collapsed');

  const radius = $('radius');
  const radiusVal = () => Math.round(25 * Math.pow(2, Number(radius.value) / 10)); // 25 m .. 3.2 km
  radius.oninput = () => {
    const m = radiusVal();
    $('radius-out').textContent = m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
    fog.setRadius(m);
  };
  $('opacity').oninput = (e) => {
    $('opacity-out').textContent = e.target.value + '%';
    fog.setOpacity(Number(e.target.value) / 100);
  };
  radius.oninput();

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    readFiles(await filesFromDrop(e.dataTransfer));
  });

  map.on('load', restore);
})();
