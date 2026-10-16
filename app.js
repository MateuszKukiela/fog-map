(function () {
  'use strict';
  const { parse, merge, buildSegments } = window.FogParser;
  const { prepare, stats, FogLayer } = window.Fog;

  const $ = (id) => document.getElementById(id);
  const state = { data: null, segments: null, files: [], years: new Set() };

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
    const parts = [];
    const names = [];
    for (const f of files) {
      if (!/\.json$/i.test(f.name)) continue;
      setStatus(`Reading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
      await new Promise(requestAnimationFrame);
      try {
        const d = parse(JSON.parse(await f.text()));
        if (d.lat.length) {
          parts.push(d);
          names.push(`${f.name} · ${d.lat.length.toLocaleString()} pts`);
        }
      } catch (err) {
        console.warn(f.name, err);
      }
    }
    if (!parts.length) {
      setStatus('No location points found. Expected Timeline.json, location-history.json, Records.json or immich-photos.json.', true);
      return;
    }
    if (state.data) parts.unshift(state.data);
    state.files.push(...names);
    setData(parts.length === 1 ? parts[0] : merge(parts), true);
    save();
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
    let include = null;
    if (years.size) {
      include = new Uint8Array(data.lat.length);
      for (let i = 0; i < include.length; i++) {
        const t = data.t[i];
        include[i] = Number.isFinite(t) && years.has(new Date(t).getFullYear()) ? 1 : 0;
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
      if ((include && !include[i]) || countryIdx[i] < 0) continue;
      weight.set(countryIdx[i], (weight.get(countryIdx[i]) || 0) + (data.kind[i] === 0 ? 1 : MIN_COUNTRY_WEIGHT));
    }
    return Array.from(weight).filter(([, w]) => w >= MIN_COUNTRY_WEIGHT).sort((a, b) => b[1] - a[1]).map(([k]) => COUNTRIES[k]);
  }

  const HOME_COUNTRY = 'PL';

  // year -> number of days with real presence (same weighting as countries) outside HOME_COUNTRY
  function daysAbroadByYear() {
    const { data, countryIdx } = state;
    const weight = new Map();
    for (let i = 0; i < countryIdx.length; i++) {
      const k = countryIdx[i], t = data.t[i];
      if (k < 0 || !Number.isFinite(t) || COUNTRIES[k].c === HOME_COUNTRY) continue;
      const d = new Date(t);
      const key = d.getFullYear() * 1000 + d.getMonth() * 32 + d.getDate();
      weight.set(key, (weight.get(key) || 0) + (data.kind[i] === 0 ? 1 : MIN_COUNTRY_WEIGHT));
    }
    const years = new Map();
    for (const [key, w] of weight) {
      if (w < MIN_COUNTRY_WEIGHT) continue;
      const y = Math.floor(key / 1000);
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
    for (const name of state.files) {
      const li = document.createElement('li');
      li.textContent = name;
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
      const d = state.data;
      const tx = (await db()).transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ lat: d.lat, lng: d.lng, t: d.t, kind: d.kind, files: state.files }, 'data');
    } catch (err) { console.warn('save failed', err); }
  }

  async function restore() {
    try {
      const store = (await db()).transaction('kv').objectStore('kv');
      const v = await new Promise((res, rej) => {
        const r = store.get('data');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (v && v.lat && v.lat.length) {
        state.files = v.files || [];
        setData({ lat: v.lat, lng: v.lng, t: v.t, kind: v.kind }, true);
      }
    } catch (err) { console.warn('restore failed', err); }
  }

  async function clearAll() {
    try { (await db()).transaction('kv', 'readwrite').objectStore('kv').delete('data'); } catch (err) { /* ignore */ }
    state.data = null;
    state.files = [];
    fog.setData(null);
    document.body.classList.remove('has-data');
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
