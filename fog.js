// Fog-of-war rendering and exploration stats.
// prepare()/level()/stats() are pure (tested in Node); FogLayer needs a browser + MapLibre map.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_CIRCUMFERENCE_M = 40075016.686;
  const TILE_SIZE = 512; // MapLibre world size at zoom 0
  const MIN_LEVEL = 4;
  const MAX_LEVEL = 21; // ~19 m cells at the equator
  const MIN_RADIUS_PX = 2.5; // keep a single visit visible from world view
  const STATS_LEVEL = 19; // ~76 m cells at the equator, ~47 m in central Europe
  const PLACES_LEVEL = 18;

  function mercX(lng) {
    return (lng + 180) / 360;
  }

  function mercY(lat) {
    const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function latFromMercY(y) {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
  }

  // Projects the selected points/segments to Web Mercator [0..1] once.
  // include: Uint8Array mask over data points, or null for everything.
  function prepare(data, segPairs, include) {
    const n = data.lat.length;
    const x = [], y = [];
    for (let i = 0; i < n; i++) {
      if (include && !include[i]) continue;
      x.push(mercX(data.lng[i]));
      y.push(mercY(data.lat[i]));
    }
    const s = [];
    for (let k = 0; k < segPairs.length; k += 2) {
      const a = segPairs[k], b = segPairs[k + 1];
      if (include && !(include[a] && include[b])) continue;
      s.push(mercX(data.lng[a]), mercY(data.lat[a]), mercX(data.lng[b]), mercY(data.lat[b]));
    }
    return { x: Float64Array.from(x), y: Float64Array.from(y), seg: Float64Array.from(s), levels: new Map() };
  }

  // Points and segments snapped to a 2^k grid with duplicates removed. Cached per level,
  // so zoomed-out frames draw a few thousand marks instead of every GPS fix.
  function level(prep, k) {
    let lv = prep.levels.get(k);
    if (lv) return lv;
    const n = 2 ** k;
    const cell = (v) => Math.min(n - 1, Math.floor(v * n));

    const seen = new Set();
    const px = [], py = [];
    for (let i = 0; i < prep.x.length; i++) {
      const ix = cell(prep.x[i]), iy = cell(prep.y[i]);
      const key = ix * n + iy;
      if (seen.has(key)) continue;
      seen.add(key);
      px.push((ix + 0.5) / n, (iy + 0.5) / n);
    }

    const seenSeg = new Set();
    const ss = [];
    for (let i = 0; i < prep.seg.length; i += 4) {
      const ax = cell(prep.seg[i]), ay = cell(prep.seg[i + 1]);
      const bx = cell(prep.seg[i + 2]), by = cell(prep.seg[i + 3]);
      const a = ax * n + ay, b = bx * n + by;
      if (a === b) continue; // fits inside one cell, the points cover it
      const key = a < b ? a + ':' + b : b + ':' + a;
      if (seenSeg.has(key)) continue;
      seenSeg.add(key);
      ss.push((ax + 0.5) / n, (ay + 0.5) / n, (bx + 0.5) / n, (by + 0.5) / n);
    }

    lv = { pts: Float64Array.from(px), seg: Float64Array.from(ss) };
    prep.levels.set(k, lv);
    return lv;
  }

  // Summary numbers for the selected points.
  function stats(data, segPairs, include) {
    const KIND_VISIT = 1;
    const n = 2 ** STATS_LEVEL;
    const cells = new Set();
    const addCell = (x, y) => cells.add(Math.floor(x * n) * n + Math.floor(y * n));

    const places = new Set();
    const pn = 2 ** PLACES_LEVEL;
    const days = new Set();
    let points = 0, visits = 0, first = Infinity, last = -Infinity;

    for (let i = 0; i < data.lat.length; i++) {
      if (include && !include[i]) continue;
      points++;
      const x = mercX(data.lng[i]), y = mercY(data.lat[i]);
      addCell(x, y);
      if (data.kind[i] === KIND_VISIT) {
        visits++;
        places.add(Math.floor(x * pn) * pn + Math.floor(y * pn));
      }
      const t = data.t[i];
      if (Number.isFinite(t)) {
        if (t < first) first = t;
        if (t > last) last = t;
        const d = new Date(t);
        days.add(d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate());
      }
    }

    // Walk each segment in half-cell steps so routes count as explored ground.
    const step = 0.5 / n;
    for (let k = 0; k < segPairs.length; k += 2) {
      const a = segPairs[k], b = segPairs[k + 1];
      if (include && !(include[a] && include[b])) continue;
      const ax = mercX(data.lng[a]), ay = mercY(data.lat[a]);
      const bx = mercX(data.lng[b]), by = mercY(data.lat[b]);
      const steps = Math.min(5000, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let s = 1; s < steps; s++) addCell(ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps);
    }

    let areaM2 = 0;
    const side = EARTH_CIRCUMFERENCE_M / n;
    for (const key of cells) {
      const iy = key % n;
      const cos = Math.cos(latFromMercY((iy + 0.5) / n) * Math.PI / 180);
      areaM2 += (side * cos) ** 2;
    }

    return {
      points,
      visits,
      places: places.size,
      days: days.size,
      areaKm2: areaM2 / 1e6,
      first: Number.isFinite(first) ? first : null,
      last: Number.isFinite(last) ? last : null,
    };
  }

  class FogLayer {
    constructor(map) {
      this.map = map;
      this.prep = null;
      this.radiusM = 150;
      this.opacity = 0.88;
      this.color = [8, 11, 24];
      this.dirty = true;
      this.lastCamera = '';

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'fog-canvas';
      map.getContainer().appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.mask = document.createElement('canvas');
      this.maskCtx = this.mask.getContext('2d');

      this.resize();
      map.on('resize', () => this.resize());
      // 'render' fires on every map frame (pans, zoom animations), keeping fog in sync.
      map.on('render', () => this.draw());
    }

    setData(prep) {
      this.prep = prep;
      this.invalidate();
    }

    setRadius(m) {
      this.radiusM = m;
      this.invalidate();
    }

    setOpacity(o) {
      this.opacity = o;
      this.invalidate();
    }

    invalidate() {
      this.dirty = true;
      this.map.triggerRepaint();
    }

    resize() {
      const el = this.map.getContainer();
      this.w = el.clientWidth;
      this.h = el.clientHeight;
      this.dpr = window.devicePixelRatio || 1;
      for (const c of [this.canvas, this.mask]) {
        c.width = Math.round(this.w * this.dpr);
        c.height = Math.round(this.h * this.dpr);
      }
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      this.dirty = true;
    }

    draw() {
      const map = this.map;
      const zoom = map.getZoom();
      const center = map.getCenter();
      const camera = zoom + ',' + center.lng + ',' + center.lat + ',' + this.w + ',' + this.h;
      if (!this.dirty && camera === this.lastCamera) return;
      this.dirty = false;
      this.lastCamera = camera;

      const { w, h, dpr } = this;
      const ws = TILE_SIZE * 2 ** zoom;
      const ox = w / 2 - mercX(center.lng) * ws;
      const oy = h / 2 - mercY(center.lat) * ws;
      const metersPerPx = EARTH_CIRCUMFERENCE_M * Math.cos(center.lat * Math.PI / 180) / ws;
      const r = Math.max(MIN_RADIUS_PX, this.radiusM / metersPerPx);

      const m = this.maskCtx;
      m.setTransform(dpr, 0, 0, dpr, 0, 0);
      m.clearRect(0, 0, w, h);

      if (this.prep) {
        const cellPx = Math.max(1.5, r / 3);
        const k = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.ceil(Math.log2(ws / cellPx))));
        const lv = level(this.prep, k);

        m.fillStyle = '#000';
        m.beginPath();
        const pts = lv.pts;
        for (let i = 0; i < pts.length; i += 2) {
          const px = pts[i] * ws + ox;
          const py = pts[i + 1] * ws + oy;
          if (px < -r || py < -r || px > w + r || py > h + r) continue;
          m.moveTo(px + r, py);
          m.arc(px, py, r, 0, 2 * Math.PI);
        }
        m.fill();

        m.strokeStyle = '#000';
        m.lineWidth = 2 * r;
        m.lineCap = 'round';
        m.beginPath();
        const seg = lv.seg;
        for (let i = 0; i < seg.length; i += 4) {
          const ax = seg[i] * ws + ox, ay = seg[i + 1] * ws + oy;
          const bx = seg[i + 2] * ws + ox, by = seg[i + 3] * ws + oy;
          if (Math.max(ax, bx) < -r || Math.min(ax, bx) > w + r) continue;
          if (Math.max(ay, by) < -r || Math.min(ay, by) > h + r) continue;
          m.moveTo(ax, ay);
          m.lineTo(bx, by);
        }
        m.stroke();
      }

      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over';
      c.filter = 'none';
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      c.fillStyle = `rgba(${this.color.join(',')},${this.opacity})`;
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      // Cut the revealed areas out of the fog, blurred for soft edges.
      c.globalCompositeOperation = 'destination-out';
      const blur = Math.min(14, r * 0.35) * dpr;
      if (blur >= 0.5) c.filter = `blur(${blur.toFixed(1)}px)`;
      c.drawImage(this.mask, 0, 0);
      c.filter = 'none';
      c.globalCompositeOperation = 'source-over';
    }
  }

  return { prepare, level, stats, mercX, mercY, FogLayer };
});
