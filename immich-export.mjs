#!/usr/bin/env node
// Exports GPS position + capture time of every Immich asset to a JSON file the fog map can load.
//
//   IMMICH_URL=https://photos.example.com IMMICH_API_KEY=... node immich-export.mjs [out.json]
//
// API key: Immich web UI -> Account Settings -> API Keys (needs asset.read).
// Only reads from the server; output defaults to ./immich-photos.json.
import { writeFile } from 'node:fs/promises';

const PAGE_SIZE = 1000;

const baseUrl = (process.env.IMMICH_URL || '').replace(/\/+$/, '').replace(/\/api$/, '');
const apiKey = process.env.IMMICH_API_KEY;
const outPath = process.argv[2] || 'immich-photos.json';

if (!baseUrl || !apiKey) {
  console.error('Set IMMICH_URL and IMMICH_API_KEY, e.g.\n' +
    '  IMMICH_URL=https://photos.example.com IMMICH_API_KEY=xxxx node immich-export.mjs');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(baseUrl + '/api' + path, {
    method,
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function toPhoto(lat, lng, time, exif = {}) {
  lat = Number(lat);
  lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng, time: time || null, city: exif.city || null, country: exif.country || null };
}

// Full metadata search: exact capture times, paginated.
async function fromMetadataSearch() {
  const photos = [];
  let page = 1;
  let scanned = 0;
  while (page) {
    const res = await api('POST', '/search/metadata', { page, size: PAGE_SIZE, withExif: true });
    const items = res.assets?.items || [];
    for (const a of items) {
      const e = a.exifInfo || {};
      const p = toPhoto(e.latitude, e.longitude, e.dateTimeOriginal || a.fileCreatedAt, e);
      if (p) photos.push(p);
    }
    scanned += items.length;
    process.stderr.write(`\rscanned ${scanned} assets, ${photos.length} with GPS`);
    page = res.assets?.nextPage ? Number(res.assets.nextPage) : null;
  }
  process.stderr.write('\n');
  return photos;
}

// Fallback for older/newer servers without metadata search: one call, but no dates.
async function fromMapMarkers() {
  const markers = await api('GET', '/map/markers');
  return markers.map((m) => toPhoto(m.lat, m.lon, null, m)).filter(Boolean);
}

let photos;
try {
  photos = await fromMetadataSearch();
} catch (err) {
  if (err.status === 401 || err.status === 403) {
    console.error(`Immich rejected the API key: ${err.message}`);
    process.exit(1);
  }
  console.error(`Metadata search failed (${err.message}); falling back to map markers (no dates).`);
  photos = await fromMapMarkers();
}

await writeFile(outPath, JSON.stringify({ source: 'immich', exportedAt: new Date().toISOString(), photos }));
console.error(`Wrote ${photos.length} geotagged photos to ${outPath}`);
