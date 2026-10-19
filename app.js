(function () {
  'use strict';
  const { parse, merge, buildSegments, distanceM } = window.FogParser;
  const { prepare, stats, FogLayer } = window.Fog;

  const $ = (id) => document.getElementById(id);
  // parts: one per source, { name, kind: 'file' | 'immich' | 'places', data, id? (server file id) }.
  // server: true when served by server.mjs; then files and places live on the server, not in this browser.
  const state = { data: null, segments: null, parts: [], places: [], years: new Set(), server: false };

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
    const errors = [];
    for (const f of files) {
      if (!/\.json$/i.test(f.name)) continue;
      setStatus(`Reading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
      await new Promise(requestAnimationFrame);
      try {
        const json = JSON.parse(await f.text());
        const d = parse(json);
        if (!d.lat.length) continue;
        if (state.server && d.format === 'manual') {
          added += await importPlaces(json.places);
          continue;
        }
        let id;
        if (state.server) {
          setStatus(`Uploading ${f.name}…`);
          id = (await uploadSource(f.name, d)).id;
        }
        // Same file name again = newer version of that file, replace it.
        state.parts = state.parts.filter((p) => p.name !== f.name);
        state.parts.push({ name: f.name, kind: 'file', id, data: d });
        added++;
      } catch (err) {
        console.warn(f.name, err);
        errors.push(`${f.name}: ${err.message}`);
      }
    }
    if (!added) {
      setStatus(
        errors.join(' ') ||
          'No location points found. Expected Timeline.json, location-history.json, Records.json, immich-photos.json or manual-places.json.',
        true,
      );
      return;
    }
    setStatus(errors.join(' '), errors.length > 0);
    rebuild(true);
  }

  function rebuild(fit) {
    if (!state.server) save();
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
    const entries = Array.from(dt.items || [])
      .map((i) => i.webkitGetAsEntry?.())
      .filter(Boolean);
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
    state.home = detectHome(data, state.countryIdx, state.airport);
    state.credible = credibility(data, state.countryIdx, state.airport);
    state.territory = classifyTerritories(data, state.countryIdx);
    state.city = classifyCities(data);
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
    let s = 90,
      n = -90,
      w = 180,
      e = -180;
    for (let i = 0; i < lat.length; i++) {
      if (lat[i] < s) s = lat[i];
      if (lat[i] > n) n = lat[i];
      if (lng[i] < w) w = lng[i];
      if (lng[i] > e) e = lng[i];
    }
    // Keep the data clear of the panel on wide screens.
    const panel = document.querySelector('.panel').getBoundingClientRect();
    const left = window.innerWidth > 700 && !document.body.classList.contains('collapsed') ? panel.right + 40 : 40;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: { top: 60, bottom: 60, right: 60, left }, maxZoom: 12, duration: 0 },
    );
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
    state.include = include;
    const cities = countCities(include);
    renderStats(stats(data, segments, include), countCountries(include), countTerritories(include), cities);
    setPins(cities, placePins(include));
  }

  // ---------- countries (Natural Earth borders, countries.js) ----------

  const COUNTRY_CELL_DEG = 0.01; // ~1 km lookup cache
  const COAST_TOLERANCE_DEG = 0.05; // ~5 km: airports on reclaimed land, beaches, ferries
  const MIN_COUNTRY_WEIGHT = 3; // 3 GPS points, or any visit/photo, so border noise doesn't add countries

  function inPolygon(rings, x, y) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i],
          yi = r[i + 1],
          xj = r[j],
          yj = r[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
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
    const sx = Math.cos((lat * Math.PI) / 180);
    let best = -1,
      bestD = tol * tol;
    for (let k = 0; k < COUNTRIES.length; k++) {
      const b = COUNTRIES[k].b;
      if (lng < b[0] - tol || lng > b[2] + tol || lat < b[1] - tol || lat > b[3] + tol) continue;
      for (const poly of COUNTRIES[k].p) {
        for (const r of poly) {
          for (let i = 2; i < r.length; i += 2) {
            const ax = (r[i - 2] - lng) * sx,
              ay = r[i - 1] - lat;
            const bx = (r[i] - lng) * sx,
              by = r[i + 1] - lat;
            const dx = bx - ax,
              dy = by - ay;
            const len = dx * dx + dy * dy;
            const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
            const d = (ax + t * dx) ** 2 + (ay + t * dy) ** 2;
            if (d < bestD) {
              bestD = d;
              best = k;
            }
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

  // Unrecognized states count as the country they're internationally part of (TCC still lists them separately).
  const PART_OF = { 'Turkish Republic of Northern Cyprus': 'CY', Somaliland: 'SO' };
  const countryOf = COUNTRIES.map((c, k) => (PART_OF[c.n] ? COUNTRIES.findIndex((x) => x.c === PART_OF[c.n]) : k));

  function countCountries(include) {
    const { data, countryIdx } = state;
    const weight = new Map();
    for (let i = 0; i < countryIdx.length; i++) {
      if ((include && !include[i]) || countryIdx[i] < 0 || state.airport[i]) continue;
      const k = countryOf[countryIdx[i]];
      weight.set(k, (weight.get(k) || 0) + (data.kind[i] === 0 ? 1 : MIN_COUNTRY_WEIGHT));
    }
    return Array.from(weight)
      .filter(([, w]) => w >= MIN_COUNTRY_WEIGHT)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => COUNTRIES[k]);
  }

  // Home = the country index with the most distinct days in the data (airports ignored).
  function detectHome(data, countryIdx, airport) {
    const days = new Map();
    for (let i = 0; i < countryIdx.length; i++) {
      const k = countryIdx[i],
        t = data.t[i];
      if (k < 0 || airport[i] || !Number.isFinite(t)) continue;
      if (!days.has(k)) days.set(k, new Set());
      days.get(k).add(localDay(t));
    }
    let home = -1,
      best = 0;
    for (const [k, set] of days)
      if (set.size > best) {
        best = set.size;
        home = k;
      }
    return home;
  }

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
      const lat = data.lat[i],
        lng = data.lng[i];
      const cy = Math.floor(lat * 10),
        cx = Math.floor(lng * 10);
      search: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const a of grid.get(key(cy + dy, cx + dx)) || []) {
            if (distanceM(lat, lng, a[0], a[1]) <= a[2] * 1000) {
              out[i] = 1;
              break search;
            }
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
      const prev = timed[clusters[c - 1][1]],
        first = timed[clusters[c][0]];
      const last = timed[clusters[c][1]],
        next = timed[clusters[c + 1][0]];
      if (dist(prev, next) > CLUSTER_M) continue;
      if (size(c) >= Math.min(size(c - 1), size(c + 1))) continue;
      if (Math.max(speed(prev, first), speed(last, next)) <= TELEPORT_MPS) continue;
      for (let j = clusters[c][0]; j <= clusters[c][1]; j++) ok[timed[j]] = 0;
    }

    const groups = new Map(); // country*1e5 + day -> {min, max, idx}
    const days = new Map(); // country -> Set(day)
    for (let i = 0; i < n; i++) {
      const k = countryIdx[i],
        t = data.t[i];
      // Hand-added places are trusted as-is: never grouped, so never dropped.
      if (!ok[i] || airport[i] || data.kind[i] === 4 || k < 0 || !Number.isFinite(t)) continue;
      const day = localDay(t);
      const key = k * 1e5 + day;
      let g = groups.get(key);
      if (!g) {
        g = { min: t, max: t, idx: [] };
        groups.set(key, g);
      }
      g.min = Math.min(g.min, t);
      g.max = Math.max(g.max, t);
      g.idx.push(i);
      if (!days.has(k)) days.set(k, new Set());
      days.get(k).add(day);
    }
    for (const [key, g] of groups) {
      const k = Math.floor(key / 1e5),
        day = key % 1e5;
      if (g.max - g.min >= MIN_STAY_MS || k === state.home) continue;
      let again = false;
      for (let d = 1; d <= STAY_WINDOW_DAYS && !again; d++) again = days.get(k).has(day - d) || days.get(k).has(day + d);
      if (!again) for (const i of g.idx) ok[i] = 0;
    }
    return ok;
  }

  // year -> days spent outside the home country, with short data gaps inside a trip filled in
  function daysAbroadByYear() {
    const { data, countryIdx, credible } = state;
    const abroad = new Set(),
      home = new Set();
    for (let i = 0; i < countryIdx.length; i++) {
      const k = countryIdx[i],
        t = data.t[i];
      if (!credible[i] || state.airport[i] || k < 0 || !Number.isFinite(t)) continue;
      (k === state.home ? home : abroad).add(localDay(t));
    }
    const sorted = Array.from(abroad).sort((a, b) => a - b);
    for (let j = 1; j < sorted.length; j++) {
      const a = sorted[j - 1],
        b = sorted[j];
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
    const home = COUNTRIES[state.home];
    $('abroad-title').textContent = home ? `days outside ${home.n} ${flag(home.c)}` : 'days abroad';
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

  // ---------- Travelers' Century Club territories (tcc.js) ----------

  function territoryAt(lng, lat, k) {
    const key = k < 0 ? null : COUNTRIES[k].c || COUNTRIES[k].n;
    for (const [name, iso, b] of TCC_RULES) {
      if (iso !== null && iso !== key) continue;
      if (lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]) return name;
    }
    return (key && TCC_DEFAULT[key]) || null;
  }

  // Per point: index into state.territoryNames, -1 for none. Cached per ~1 km cell like countries.
  function classifyTerritories(data, countryIdx) {
    const names = [],
      index = new Map(),
      cache = new Map();
    const out = new Int16Array(data.lat.length);
    for (let i = 0; i < out.length; i++) {
      const ix = Math.floor(data.lng[i] / COUNTRY_CELL_DEG),
        iy = Math.floor(data.lat[i] / COUNTRY_CELL_DEG);
      const key = (ix * 100000 + iy) * 300 + countryIdx[i] + 1;
      let t = cache.get(key);
      if (t === undefined) {
        const name = territoryAt(data.lng[i], data.lat[i], countryIdx[i]);
        if (name && !index.has(name)) {
          index.set(name, names.length);
          names.push(name);
        }
        t = name ? index.get(name) : -1;
        cache.set(key, t);
      }
      out[i] = t;
    }
    state.territoryNames = names;
    return out;
  }

  // Same noise rules as countries, but airport layovers count: the club counts transit stops.
  function countTerritories(include) {
    const { data, territory } = state;
    const weight = new Map();
    for (let i = 0; i < territory.length; i++) {
      if ((include && !include[i]) || territory[i] < 0) continue;
      weight.set(territory[i], (weight.get(territory[i]) || 0) + (data.kind[i] === 0 ? 1 : MIN_COUNTRY_WEIGHT));
    }
    return Array.from(weight)
      .filter(([, w]) => w >= MIN_COUNTRY_WEIGHT)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => state.territoryNames[t]);
  }

  // ---------- cities (cities.js, 100k+ people) ----------

  const CITY_BUCKET_DEG = 0.5;
  // Visit radius grows with size: 3 km for 100k, ~9.5 km for 1M, capped at 20 km.
  const cityRadiusM = (pop) => Math.min(20000, 3000 * Math.sqrt(pop / 1e5));

  // Per point: index into CITIES of the largest city whose radius covers it, -1 for none.
  function classifyCities(data) {
    const bucket = (lat, lng) => Math.floor(lat / CITY_BUCKET_DEG) * 1000 + Math.floor(lng / CITY_BUCKET_DEG);
    const grid = new Map();
    CITIES.forEach((c, idx) => {
      const k = bucket(c[2], c[3]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(idx);
    });
    const cache = new Map();
    const out = new Int16Array(data.lat.length);
    for (let i = 0; i < out.length; i++) {
      const lat = data.lat[i],
        lng = data.lng[i];
      const cell = Math.floor(lng / COUNTRY_CELL_DEG) * 100000 + Math.floor(lat / COUNTRY_CELL_DEG);
      let best = cache.get(cell);
      if (best === undefined) {
        best = -1;
        const by = Math.floor(lat / CITY_BUCKET_DEG),
          bx = Math.floor(lng / CITY_BUCKET_DEG);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const idx of grid.get((by + dy) * 1000 + bx + dx) || []) {
              if (best >= 0 && idx > best) continue; // CITIES is largest-first
              const c = CITIES[idx];
              if (distanceM(lat, lng, c[2], c[3]) <= cityRadiusM(c[4])) best = idx;
            }
          }
        }
        cache.set(cell, best);
      }
      out[i] = best;
    }
    return out;
  }

  // Same noise rules as countries; airports don't count as visiting the city.
  function countCities(include) {
    const { data, city } = state;
    const weight = new Map();
    for (let i = 0; i < city.length; i++) {
      if ((include && !include[i]) || city[i] < 0 || state.airport[i]) continue;
      weight.set(city[i], (weight.get(city[i]) || 0) + (data.kind[i] === 0 ? 1 : MIN_COUNTRY_WEIGHT));
    }
    return Array.from(weight)
      .filter(([, w]) => w >= MIN_COUNTRY_WEIGHT)
      .map(([c]) => c)
      .sort((a, b) => a - b)
      .map((c) => CITIES[c]);
  }

  const flag = (code) => (code ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '🏳️');

  const fmt = (n) => Math.round(n).toLocaleString();
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  function renderStats(s, countries, territories, cities) {
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
    $('stat-cities').textContent = cities.length;
    $('city-list').textContent = cities.map((c) => `${flag(c[1])} ${c[0]}`).join(' · ');
    $('stat-tcc').textContent = `${territories.length} / ${TCC_TOTAL}`;
    $('tcc-bar').style.width = Math.min(100, territories.length) + '%';
    $('tcc-list').textContent = territories.join(' · ');
    $('range').textContent = s.first ? `${fmtDate(s.first)} – ${fmtDate(s.last)}` : 'No dates';
    $('files').innerHTML = '';
    for (const p of state.parts) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent =
        p.kind === 'places'
          ? `Places · ${state.places.length.toLocaleString()} added by hand`
          : `${p.name} · ${p.data.lat.length.toLocaleString()} pts`;
      const x = document.createElement('button');
      x.className = 'remove';
      if (p.kind === 'immich') {
        x.textContent = 'Settings';
        x.title = 'Immich is managed in Settings';
        x.onclick = () => $('open-settings').click();
      } else if (p.kind === 'places') {
        x.textContent = 'Edit';
        x.title = 'Edit your places';
        x.onclick = openPlaces;
      } else {
        x.textContent = '✕';
        x.title = `Remove ${p.name}` + (state.server ? ' from the server' : '');
        x.setAttribute('aria-label', x.title);
        x.onclick = () => removePart(p);
      }
      li.append(label, x);
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
    mk('All', state.years.size === 0, () => {
      state.years.clear();
      renderYears();
      applyFilter();
    });
    for (const y of state.allYears) {
      mk(String(y), state.years.has(y), (ev) => {
        // Click = only this year, shift/cmd-click = add to selection.
        if (!(ev.shiftKey || ev.metaKey || ev.ctrlKey)) state.years.clear();
        if (state.years.has(y)) state.years.delete(y);
        else state.years.add(y);
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
    } catch (err) {
      console.warn('save failed', err);
    }
  }

  // Data saved before per-file storage was one merged blob. Point kind maps to the source
  // (GPS/visits/activities = Timeline, 3 = photos, 4 = manual), so split it back that way.
  function splitBySource(d) {
    const groups = [
      ['Timeline (saved earlier)', [0, 1, 2]],
      ['Photos (saved earlier)', [3]],
      ['Manual places (saved earlier)', [4]],
    ];
    const out = [];
    for (const [name, kinds] of groups) {
      const idx = [];
      for (let i = 0; i < d.kind.length; i++) if (kinds.includes(d.kind[i])) idx.push(i);
      if (!idx.length) continue;
      const pick = (arr, Type) => Type.from(idx, (i) => arr[i]);
      out.push({
        name,
        data: {
          lat: pick(d.lat, Float64Array),
          lng: pick(d.lng, Float64Array),
          t: pick(d.t, Float64Array),
          kind: pick(d.kind, Uint8Array),
        },
      });
    }
    return out;
  }

  // Parts saved in this browser's IndexedDB (file mode, or before data moved to the server).
  async function readLocal() {
    try {
      const store = (await db()).transaction('kv').objectStore('kv');
      const v = await new Promise((res, rej) => {
        const r = store.get('data');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      let parts = [];
      if (v?.parts) {
        parts = v.parts.map(({ name, ...data }) => ({ name, kind: name === IMMICH_PART ? 'immich' : 'file', data }));
      } else if (v?.lat?.length) {
        parts = [{ name: 'earlier files (merged)', data: { lat: v.lat, lng: v.lng, t: v.t, kind: v.kind } }];
      }
      return parts.flatMap((p) => (p.name === 'earlier files (merged)' ? splitBySource(p.data).map((q) => ({ ...q, kind: 'file' })) : [p]));
    } catch (err) {
      console.warn('restore failed', err);
      return [];
    }
  }

  async function forgetLocal() {
    try {
      (await db()).transaction('kv', 'readwrite').objectStore('kv').delete('data');
    } catch (err) {
      console.warn(err);
    }
  }

  async function restore() {
    state.parts = await readLocal();
    if (state.parts.length) rebuild(true);
  }

  async function removePart(p) {
    if (state.server && p.id) {
      try {
        await api('DELETE', 'api/sources/' + p.id);
      } catch (err) {
        return setStatus(`Could not remove ${p.name}: ${err.message}`, true);
      }
    }
    state.parts = state.parts.filter((q) => q !== p);
    rebuild(false);
  }

  async function clearAll() {
    const files = state.parts.filter((p) => p.kind === 'file');
    if (state.server) {
      if (!files.length) return;
      if (
        !confirm(
          `Delete ${files.length === 1 ? files[0].name : `all ${files.length} uploaded files`} from the server?\nImmich photos and your places stay.`,
        )
      )
        return;
      for (const p of files) await removePart(p);
      return;
    }
    state.parts = state.parts.filter((p) => p.kind !== 'file');
    rebuild(false);
  }

  // ---------- server library (server.mjs): uploaded files and places stored in DATA_DIR ----------

  async function api(method, path, body) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // Wire format shared with library.mjs (little-endian): u32 n | f64 lat×n | f64 lng×n | f64 t×n | u8 kind×n
  function encodePoints(d) {
    const n = d.lat.length;
    const out = new Uint8Array(4 + n * 25);
    new DataView(out.buffer).setUint32(0, n, true);
    const bytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    out.set(bytes(Float64Array.from(d.lat)), 4);
    out.set(bytes(Float64Array.from(d.lng)), 4 + n * 8);
    out.set(bytes(Float64Array.from(d.t)), 4 + n * 16);
    out.set(d.kind, 4 + n * 24);
    return out;
  }

  function decodePoints(buf) {
    const u8 = new Uint8Array(buf);
    const n = new DataView(buf).getUint32(0, true);
    const f64 = (i) => new Float64Array(u8.slice(4 + i * n * 8, 4 + (i + 1) * n * 8).buffer);
    return { lat: f64(0), lng: f64(1), t: f64(2), kind: u8.slice(4 + n * 24) };
  }

  async function uploadSource(name, d) {
    const res = await fetch('api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-source-name': encodeURIComponent(name) },
      body: encodePoints(d),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.source;
  }

  const placesPart = () =>
    state.places.length ? [{ name: 'Places', kind: 'places', data: parse({ source: 'manual', places: state.places }) }] : [];

  // Files, places and Immich photos download in parallel, without waiting for the base map,
  // and the map is computed once when everything is in.
  async function loadLibrary() {
    setStatus('Loading your data…');
    let photosError = null;
    const photos = fetchImmich().catch((err) => {
      photosError = err;
    });
    try {
      const [{ sources }, { places }] = await Promise.all([api('GET', 'api/sources'), api('GET', 'api/places')]);
      const files = await Promise.all(
        sources.map(async (s) => {
          const res = await fetch('api/sources/' + s.id);
          if (!res.ok) throw new Error(`could not load ${s.name}`);
          return { name: s.name, kind: 'file', id: s.id, data: decodePoints(await res.arrayBuffer()) };
        }),
      );
      const immich = await photos;
      await mapReady;
      state.places = places;
      state.parts = [...files, ...placesPart(), ...(immich ? [immich] : [])];
      if (!sources.length && !places.length) await moveLocalToServer();
      setStatus(photosError ? `Immich: ${photosError.message}` : '', !!photosError);
      if (state.parts.length) rebuild(true);
    } catch (err) {
      setStatus(`Could not load your data from the server: ${err.message}`, true);
    }
  }

  // First visit after an upgrade: data dropped in this browser earlier moves to the server.
  async function moveLocalToServer() {
    const local = (await readLocal()).filter((p) => p.kind === 'file');
    if (!local.length) return;
    let moved = 0;
    for (const p of local) {
      setStatus(`Moving ${p.name} from this browser to the server…`);
      if (p.data.kind.every((k) => k === 4)) {
        await savePlaces([...state.places, ...placesFromPoints(p.data)]);
      } else {
        const id = (await uploadSource(p.name, p.data)).id;
        state.parts.push({ ...p, id });
      }
      moved++;
    }
    await forgetLocal();
    console.info(`Moved ${moved} saved file(s) from this browser to the server.`);
  }

  // Hand-added places saved earlier only as points (one per day): rebuild them as stays.
  function placesFromPoints(d) {
    const idx = Array.from(d.lat.keys()).sort((a, b) => d.t[a] - d.t[b]);
    const day = (t) => new Date(t).toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    const out = [];
    for (const i of idx) {
      const last = out[out.length - 1];
      if (last && last.lat === d.lat[i] && last.lng === d.lng[i] && d.t[i] - last.end <= 86400000 * 1.5) {
        last.to = day(d.t[i]);
        last.end = d.t[i];
        continue;
      }
      const town = nearestTown(d.lat[i], d.lng[i], 30000);
      out.push({ name: town ? town[0] : 'Place', lat: d.lat[i], lng: d.lng[i], date: day(d.t[i]), end: d.t[i] });
    }
    return out.map(({ end, ...p }) => p);
  }

  async function savePlaces(places) {
    state.places = (await api('PUT', 'api/places', { places })).places;
    state.parts = [...state.parts.filter((p) => p.kind !== 'places'), ...placesPart()];
  }

  // A dropped manual-places.json adds its places to the list (exact duplicates are skipped).
  async function importPlaces(places) {
    const key = (p) => [p.name, p.lat, p.lng, p.date, p.to || ''].join('|');
    const have = new Set(state.places.map(key));
    const fresh = (places || []).filter((p) => !have.has(key(p)));
    if (fresh.length) await savePlaces([...state.places, ...fresh]);
    return fresh.length;
  }

  // ---------- wiring ----------

  $('pick').onclick = () => $('file').click();
  $('add').onclick = () => $('file').click();
  $('file').onchange = (e) => {
    readFiles(Array.from(e.target.files));
    e.target.value = '';
  };
  $('clear').onclick = () => clearAll();
  $('open-places').onclick = openPlaces;
  $('open-places-empty').onclick = openPlaces;
  $('collapse').onclick = () => document.body.classList.toggle('collapsed');

  const radius = $('radius');
  const radiusVal = () => Math.round(25 * 2 ** (Number(radius.value) / 10)); // 25 m .. 3.2 km
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
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    readFiles(await filesFromDrop(e.dataTransfer));
  });

  // ---------- pins view: red push-pins on visited cities, like a paper map on the wall ----------

  // ---------- yellow pins: places you've really been that aren't a 100k+ city ----------

  const PLACE_CELL_DEG = 0.05; // ~5 km
  const PLACE_MERGE_M = 15000; // one pin per ~15 km area
  const STOP_MS = 45 * 60000; // a yellow pin needs a real stop, not a drive-through ...
  const PHOTO_STOP_MS = 15 * 60000; // ... or a shorter stop with a few photos (a viewpoint)
  const STOP_GAP_MS = 2 * 3600000; // fixes further apart than this are separate passes

  // Longest stay in a cell: a run of time-sorted fixes with small gaps. Two visit fixes in a row
  // (start/end of one Timeline visit) always continue the run, so a night in a hotel counts.
  function isStop(fixes) {
    if (fixes.manual) return true;
    fixes.sort((a, b) => a[0] - b[0]);
    let start = 0,
      photos = 0;
    for (let j = 0; j < fixes.length; j++) {
      if (j > 0 && fixes[j][0] - fixes[j - 1][0] > STOP_GAP_MS && !(fixes[j][1] === 1 && fixes[j - 1][1] === 1)) {
        start = j;
        photos = 0;
      }
      if (fixes[j][1] === 3) photos++;
      const span = fixes[j][0] - fixes[start][0];
      if (span >= STOP_MS || (span >= PHOTO_STOP_MS && photos >= 3)) return true;
    }
    return false;
  }

  let townGrid = null;
  function nearestTown(lat, lng, maxM) {
    if (!townGrid) {
      townGrid = new Map();
      for (const t of TOWNS) {
        const k = Math.floor(t[2] / CITY_BUCKET_DEG) * 1000 + Math.floor(t[3] / CITY_BUCKET_DEG);
        if (!townGrid.has(k)) townGrid.set(k, []);
        townGrid.get(k).push(t);
      }
    }
    let best = null,
      bestD = maxM;
    const by = Math.floor(lat / CITY_BUCKET_DEG),
      bx = Math.floor(lng / CITY_BUCKET_DEG);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const t of townGrid.get((by + dy) * 1000 + bx + dx) || []) {
          const d = distanceM(lat, lng, t[2], t[3]);
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
      }
    }
    return best;
  }

  // Heaviest ~5 km cells first; each becomes a pin unless a city pin or another place pin is within 15 km.
  function placePins(include) {
    const { data, city, airport } = state;
    const cells = new Map();
    for (let i = 0; i < data.lat.length; i++) {
      if ((include && !include[i]) || airport[i] || city[i] >= 0) continue;
      const key = Math.floor(data.lat[i] / PLACE_CELL_DEG) * 100000 + Math.floor(data.lng[i] / PLACE_CELL_DEG);
      const w = data.kind[i] === 0 ? 1 : MIN_COUNTRY_WEIGHT;
      const c = cells.get(key) || { w: 0, lat: 0, lng: 0, fixes: [] };
      c.w += w;
      c.lat += data.lat[i] * w;
      c.lng += data.lng[i] * w;
      if (data.kind[i] === 4) c.fixes.manual = true;
      else if (Number.isFinite(data.t[i])) c.fixes.push([data.t[i], data.kind[i]]);
      cells.set(key, c);
    }
    const taken = countCities(include).map((c) => [c[2], c[3]]);
    const places = [];
    for (const c of [...cells.values()].sort((a, b) => b.w - a.w)) {
      if (c.w < MIN_COUNTRY_WEIGHT) break;
      if (!isStop(c.fixes)) continue;
      const lat = c.lat / c.w,
        lng = c.lng / c.w;
      if (taken.some(([a, b]) => distanceM(lat, lng, a, b) < PLACE_MERGE_M)) continue;
      taken.push([lat, lng]);
      const near = nearestTown(lat, lng, PLACE_MERGE_M);
      const far = near || nearestTown(lat, lng, 60000);
      places.push([near ? near[0] : far ? `near ${far[0]}` : 'Visited place', far ? far[1] : '', lat, lng]);
    }
    return places;
  }

  function pinImage(light, mid, dark) {
    const s = 2,
      w = 28,
      h = 40; // drawn at 2x for sharp pins on retina screens
    const c = document.createElement('canvas');
    c.width = w * s;
    c.height = h * s;
    const g = c.getContext('2d');
    g.scale(s, s);
    // soft shadow cast on the wall, to the lower right of the head
    g.filter = 'blur(2px)';
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.beginPath();
    g.ellipse(17, 16, 7, 5, 0, 0, 2 * Math.PI);
    g.fill();
    g.filter = 'none';
    // needle, tip at the bottom center = the city
    g.strokeStyle = '#9a9a9a';
    g.lineWidth = 1.6;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(13, 14);
    g.lineTo(14, h - 1);
    g.stroke();
    // glossy red head
    const grad = g.createRadialGradient(10, 8, 1, 13, 11, 9);
    grad.addColorStop(0, light);
    grad.addColorStop(0.35, mid);
    grad.addColorStop(1, dark);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(13, 11, 8, 0, 2 * Math.PI);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.beginPath();
    g.arc(10, 8, 2.2, 0, 2 * Math.PI);
    g.fill();
    return g.getImageData(0, 0, c.width, c.height);
  }

  function addPinsLayer() {
    map.addImage('pin', pinImage('#ff9e94', '#e3201b', '#6e0000'), { pixelRatio: 2 });
    map.addSource('pins', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'pins',
      type: 'symbol',
      source: 'pins',
      layout: {
        visibility: 'none',
        'icon-image': 'pin',
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.55, 8, 1],
        'symbol-sort-key': ['-', 0, ['get', 'lat']], // southern pins in front, like on a wall
      },
    });
    map.on('click', 'pins', (e) => {
      const p = e.features[0].properties;
      const [lng, lat] = e.features[0].geometry.coordinates;
      const box = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${flag(p.cc)} ${p.name}`;
      box.appendChild(title);
      for (const line of tripLines(
        p.kind === 'city'
          ? (i) => state.city[i] === p.ci
          : (i) => state.city[i] < 0 && distanceM(lat, lng, state.data.lat[i], state.data.lng[i]) < PLACE_MERGE_M,
      )) {
        const div = document.createElement('div');
        div.className = 'pin-date';
        div.textContent = line;
        box.appendChild(div);
      }
      new maplibregl.Popup({ offset: [0, -30] }).setLngLat([lng, lat]).setDOMContent(box).addTo(map);
    });
    map.on('mouseenter', 'pins', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'pins', () => {
      map.getCanvas().style.cursor = '';
    });
  }

  const TRIP_GAP_DAYS = 2; // days this far apart are one trip
  const MAX_TRIPS = 6;

  // When you were at a pin: days with points that pass `at(i)`, grouped into trips, newest first.
  function tripLines(at) {
    const { data, include, airport } = state;
    const days = new Set();
    for (let i = 0; i < data.lat.length; i++) {
      if (!include[i] || airport[i] || !Number.isFinite(data.t[i]) || !at(i)) continue;
      const d = new Date(data.t[i]);
      days.add(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    }
    const trips = [];
    for (const day of [...days].sort((a, b) => a - b)) {
      const last = trips[trips.length - 1];
      if (last && day - last[1] <= TRIP_GAP_DAYS) last[1] = day;
      else trips.push([day, day]);
    }
    const fmtDay = (day) =>
      new Date(day * 86400000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const lines = trips
      .reverse()
      .slice(0, MAX_TRIPS)
      .map(([a, b]) => (a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`));
    if (trips.length > MAX_TRIPS) lines.push(`+ ${trips.length - MAX_TRIPS} earlier trips`);
    return lines;
  }

  function setPins(cities, places) {
    const src = map.getSource('pins');
    if (!src) return;
    const feature = (kind) => (c) => {
      const [name, cc, lat, lng] = c;
      return {
        type: 'Feature',
        properties: { kind, name, cc, lat, ci: kind === 'city' ? CITIES.indexOf(c) : -1 },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      };
    };
    src.setData({ type: 'FeatureCollection', features: [...cities.map(feature('city')), ...places.map(feature('place'))] });
  }

  function setView(view) {
    fog.canvas.style.display = view === 'pins' ? 'none' : '';
    map.setLayoutProperty('pins', 'visibility', view === 'pins' ? 'visible' : 'none');
    for (const b of document.querySelectorAll('#view button')) b.classList.toggle('active', b.dataset.view === view);
  }
  for (const b of document.querySelectorAll('#view button')) b.onclick = () => setView(b.dataset.view);

  // Self-hosted (server.mjs): photo locations straight from Immich on every visit.
  // Opened as a local file or on a plain static host, the endpoint isn't there and this does nothing.
  const IMMICH_PART = 'Immich (live)';
  // The Immich part, or null when Immich isn't connected; throws when it fails.
  async function fetchImmich(refresh) {
    if (location.protocol === 'file:') return null;
    const res = await fetch(refresh ? 'api/immich?refresh=1' : 'api/immich');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    return { name: IMMICH_PART, kind: 'immich', data: parse(await res.json()) };
  }

  // Settings dialog: (re)load photos on their own after saving or Sync now.
  async function loadImmich(refresh) {
    try {
      setStatus('Loading photos from Immich…');
      const part = await fetchImmich(refresh);
      setStatus('');
      if (!part) return;
      const first = !state.parts.length;
      state.parts = state.parts.filter((p) => p.name !== IMMICH_PART);
      state.parts.push(part);
      rebuild(first);
      return part.data.lat.length;
    } catch (err) {
      setStatus(`Immich: ${err.message}`, true);
    }
  }

  // ---------- settings dialog (only when served by server.mjs) ----------

  const dialog = $('settings');
  let immichCfg = null;
  let ownTracksCfg = null;

  async function initSettings() {
    if (location.protocol === 'file:') return;
    try {
      const res = await fetch('api/settings');
      if (!res.ok) return;
      ({ immich: immichCfg, owntracks: ownTracksCfg } = await res.json());
    } catch {
      return;
    }
    state.server = true;
    document.body.classList.add('server');
    $('open-settings').hidden = false;
    renderImmich();
    if (location.hash === '#settings') $('open-settings').click(); // direct link to settings
  }

  function renderImmich() {
    const c = immichCfg;
    const el = $('immich-state');
    el.textContent = c.hasKey ? `Connected · ${new URL(c.url).host}` + (c.source === 'env' ? ' (from environment)' : '') : 'Not connected';
    el.classList.toggle('on', c.hasKey);
    $('immich-url').value = c.url;
    $('immich-key').value = '';
    $('immich-key').placeholder = c.hasKey ? 'Saved · leave empty to keep it' : 'Paste your API key';
    $('immich-disconnect').hidden = !c.hasKey;
    $('immich-sync').hidden = !c.hasKey;
  }

  function renderOwnTracks() {
    const c = ownTracksCfg;
    const el = $('ot-state');
    el.textContent = !c.enabled
      ? 'Off'
      : c.points
        ? `${c.points.toLocaleString()} points · last ${new Date(c.lastAt).toLocaleString()}`
        : 'Waiting for the first point';
    el.classList.toggle('on', c.points > 0);
    $('ot-off').hidden = c.enabled;
    $('ot-on').hidden = !c.enabled;
    const url = new URL('api/owntracks', location.href).href;
    $('ot-url').value = url;
    $('ot-user').value = c.user;
    // OwnTracks imports this config when the link is opened on the phone (mode 3 = HTTP); the password is typed in the app.
    const cfg = { _type: 'configuration', mode: 3, url, auth: true, usePassword: true, username: c.user };
    $('ot-setup').onclick = () => {
      location.href = 'owntracks:///config?inline=' + encodeURIComponent(btoa(JSON.stringify(cfg)));
    };
  }

  function immichMsg(text, kind) {
    const el = $('immich-msg');
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  async function immichBusy(label, fn) {
    const buttons = dialog.querySelectorAll('.dlg-actions button');
    for (const b of buttons) b.disabled = true;
    immichMsg(label);
    try {
      await fn();
    } catch {
      immichMsg('Could not reach the fog map server.', 'err');
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }

  async function settingsCall(method, body) {
    const res = await fetch('api/settings/immich', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return [res.ok, await res.json().catch(() => ({}))];
  }

  function submitImmich(test) {
    const urlInput = $('immich-url');
    const url = urlInput.value.trim();
    urlInput.setAttribute('aria-invalid', String(!url));
    if (!url) return immichMsg('Enter your Immich server URL.', 'err');
    return immichBusy(test ? 'Testing connection…' : 'Checking and saving…', async () => {
      const [ok, body] = await settingsCall('POST', { url, apiKey: $('immich-key').value, test });
      if (!ok) return immichMsg(body.error || 'Something went wrong.', 'err');
      if (test) return immichMsg(`Connection works. Signed in as ${body.user}.`, 'ok');
      immichCfg = body.immich;
      renderImmich();
      immichMsg(`Saved. Signed in as ${body.user}. Loading photos, the first sync can take a minute…`, 'ok');
      const n = await loadImmich();
      immichMsg(
        n != null
          ? `Saved. ${n.toLocaleString()} geotagged photos loaded.`
          : 'Saved, but loading photos failed. See the message in the panel.',
        n != null ? 'ok' : 'err',
      );
    });
  }

  $('open-settings').onclick = () => {
    immichMsg('');
    renderImmich();
    renderOwnTracks();
    dialog.showModal();
    // Refresh the phone status, it changes as points arrive.
    fetch('api/settings')
      .then((r) => r.json())
      .then((s) => {
        ownTracksCfg = s.owntracks;
        renderOwnTracks();
      })
      .catch(() => {});
  };
  $('settings-close').onclick = () => dialog.close();
  $('immich-form').onsubmit = (e) => {
    e.preventDefault();
    submitImmich(false);
  };
  $('immich-test').onclick = () => submitImmich(true);
  $('immich-sync').onclick = () =>
    immichBusy('Syncing photos from Immich…', async () => {
      const n = await loadImmich(true);
      immichMsg(
        n != null ? `Synced. ${n.toLocaleString()} geotagged photos.` : 'Sync failed. See the message in the panel.',
        n != null ? 'ok' : 'err',
      );
    });
  $('immich-disconnect').onclick = () =>
    immichBusy('Disconnecting…', async () => {
      const [ok, body] = await settingsCall('DELETE');
      if (!ok) return immichMsg(body.error || 'Something went wrong.', 'err');
      immichCfg = body.immich;
      renderImmich();
      state.parts = state.parts.filter((p) => p.name !== IMMICH_PART);
      rebuild(false);
      immichMsg('Disconnected. The saved API key was deleted from the server.', 'ok');
    });

  // ---------- places dialog: trips that aren't in any export, stored on the server ----------

  const placesDlg = $('places-dlg');
  const form = { index: -1, name: '', lat: null, lng: null }; // index >= 0 while editing

  const fmtDay = (d) =>
    new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  const fmtStay = (p) => (p.to ? `${fmtDay(p.date)} – ${fmtDay(p.to)}` : fmtDay(p.date));

  function openPlaces() {
    resetPlaceForm();
    renderPlaces();
    placesDlg.showModal();
  }

  function placeMsg(text, kind) {
    $('place-msg').textContent = text;
    $('place-msg').className = 'msg' + (kind ? ' ' + kind : '');
  }

  function renderPlaces() {
    const list = $('places-list');
    list.innerHTML = '';
    $('places-empty').hidden = state.places.length > 0;
    const order = state.places.map((_, i) => i).sort((a, b) => state.places[b].date.localeCompare(state.places[a].date));
    for (const i of order) {
      const p = state.places[i];
      const li = document.createElement('li');
      const text = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = p.name;
      const when = document.createElement('span');
      when.textContent = fmtStay(p);
      text.append(name, when);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'link';
      edit.textContent = 'Edit';
      edit.onclick = () => editPlace(i);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'link-danger';
      del.textContent = 'Delete';
      del.onclick = () => deletePlace(i);
      li.append(text, edit, del);
      list.appendChild(li);
    }
  }

  function renderPlaceForm() {
    $('place-form-title').textContent = form.index >= 0 ? 'Edit place' : 'Add a place';
    $('place-save').textContent = form.index >= 0 ? 'Save changes' : 'Add place';
    $('place-cancel').hidden = form.index < 0;
    $('place-coords').textContent =
      form.lat == null ? 'No location yet: search above or pick it on the map.' : `📍 ${form.lat.toFixed(4)}, ${form.lng.toFixed(4)}`;
  }

  function resetPlaceForm() {
    Object.assign(form, { index: -1, name: '', lat: null, lng: null });
    $('place-search').value = '';
    $('place-from').value = '';
    $('place-to').value = '';
    hideSuggestions();
    placeMsg('');
    renderPlaceForm();
  }

  function editPlace(i) {
    const p = state.places[i];
    Object.assign(form, { index: i, name: p.name, lat: p.lat, lng: p.lng });
    $('place-search').value = p.name;
    $('place-from').value = p.date;
    $('place-to').value = p.to || '';
    placeMsg('');
    renderPlaceForm();
    $('place-search').focus();
  }

  async function deletePlace(i) {
    if (!confirm(`Delete ${state.places[i].name} (${fmtStay(state.places[i])})?`)) return;
    try {
      await savePlaces(state.places.filter((_, j) => j !== i));
      if (form.index === i) resetPlaceForm();
      else if (form.index > i) form.index--;
      renderPlaces();
      rebuild(false);
    } catch (err) {
      placeMsg(err.message, 'err');
    }
  }

  // Offline search over the bundled towns: exact name first, then capitals, then bigger places.
  const FOLD = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' }; // letters NFD can't split
  const norm = (s) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[øæœßłđðþı]/g, (c) => FOLD[c]);
  let searchIndex = null;
  function searchPlaces(q) {
    if (!searchIndex) searchIndex = TOWNS.map(([name, cc, lat, lng, pop, capital]) => [norm(name), name, cc, lat, lng, pop, capital]);
    const nq = norm(q.trim());
    if (nq.length < 2) return [];
    const hits = [];
    for (const e of searchIndex) {
      const at = e[0].indexOf(nq);
      if (at === 0 || (at > 0 && e[0][at - 1] === ' ')) hits.push([e, (e[0] === nq ? 4 : 0) + (at === 0 ? 2 : 0) + e[6], e[5]]);
    }
    hits.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
    return hits.slice(0, 8).map((h) => h[0]);
  }

  let suggestions = [];
  let active = -1;
  function hideSuggestions() {
    $('place-suggest').hidden = true;
    $('place-search').setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function showSuggestions() {
    const box = $('place-suggest');
    box.innerHTML = '';
    suggestions.forEach(([, name, cc, lat, lng], i) => {
      const li = document.createElement('li');
      li.role = 'option';
      li.id = 'place-opt-' + i;
      li.className = i === active ? 'active' : '';
      li.textContent = `${flag(cc)} ${name}`;
      const small = document.createElement('small');
      small.textContent = `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
      li.appendChild(small);
      li.onmousedown = (e) => {
        e.preventDefault();
        choose(i);
      };
      box.appendChild(li);
    });
    box.hidden = suggestions.length === 0;
    $('place-search').setAttribute('aria-expanded', String(!box.hidden));
    $('place-search').setAttribute('aria-activedescendant', active >= 0 ? 'place-opt-' + active : '');
  }

  function choose(i) {
    const [, name, , lat, lng] = suggestions[i];
    Object.assign(form, { name, lat, lng });
    $('place-search').value = name;
    hideSuggestions();
    renderPlaceForm();
    $('place-from').focus();
  }

  $('place-search').oninput = (e) => {
    form.name = e.target.value;
    suggestions = searchPlaces(e.target.value);
    active = -1;
    showSuggestions();
  };
  $('place-search').onkeydown = (e) => {
    if ($('place-suggest').hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      showSuggestions();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // close the list, not the dialog
      hideSuggestions();
    }
  };
  $('place-search').onblur = () => setTimeout(hideSuggestions, 100);

  // Pick on map: hide the dialog, take one click on the map, come back.
  $('place-pick').onclick = () => {
    placesDlg.close();
    document.body.classList.add('picking');
    const banner = $('pick-banner');
    banner.hidden = false;
    const finish = (lngLat) => {
      map.off('click', onClick);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('picking');
      banner.hidden = true;
      if (lngLat) {
        form.lat = lngLat.lat;
        form.lng = lngLat.lng;
        if (!$('place-search').value.trim()) {
          const town = nearestTown(form.lat, form.lng, 30000);
          if (town) $('place-search').value = form.name = town[0];
        }
      }
      placesDlg.showModal();
      renderPlaceForm();
    };
    const onClick = (e) => finish(e.lngLat);
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
    };
    map.on('click', onClick);
    window.addEventListener('keydown', onKey);
  };

  $('place-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('place-search').value.trim();
    const date = $('place-from').value,
      to = $('place-to').value;
    if (!name) return placeMsg('Give the place a name.', 'err');
    if (form.lat == null) return placeMsg('Choose a location: search for a town or pick it on the map.', 'err');
    if (!date) return placeMsg('Enter the date you were there (or the first day).', 'err');
    if (to && to < date) return placeMsg('The end date is before the start date.', 'err');
    const place = { name, lat: +form.lat.toFixed(5), lng: +form.lng.toFixed(5), date, ...(to && to !== date ? { to } : {}) };
    const next = form.index >= 0 ? state.places.map((p, i) => (i === form.index ? place : p)) : [...state.places, place];
    $('place-save').disabled = true;
    try {
      await savePlaces(next);
      const verb = form.index >= 0 ? 'Saved' : 'Added';
      resetPlaceForm();
      placeMsg(`${verb} ${name}.`, 'ok');
      renderPlaces();
      rebuild(false);
    } catch (err) {
      placeMsg(err.message, 'err');
    } finally {
      $('place-save').disabled = false;
    }
  };
  $('place-cancel').onclick = resetPlaceForm;
  $('places-close').onclick = () => placesDlg.close();

  const mapReady = new Promise((resolve) =>
    map.on('load', () => {
      addPinsLayer();
      if (location.hash === '#pins') setView('pins'); // direct link to the pins view
      resolve();
    }),
  );
  initSettings().then(async () => {
    if (state.server) return loadLibrary();
    await mapReady;
    restore();
  });
})();
