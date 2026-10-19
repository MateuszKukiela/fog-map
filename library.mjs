// Server-side storage in DATA_DIR for uploaded location sources and hand-added places,
// so every device sees the same map.
//
//   sources.json            index: [{ id, name, points, updatedAt }]
//   sources/<id>.bin.gz     point blob (gzipped, served as-is to browsers that accept gzip)
//   places.json             { places: [{ name, lat, lng, date, to? }] }
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzip, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

// Point blob, the format the browser uploads and downloads (little-endian):
//   u32 n | f64 lat × n | f64 lng × n | f64 time ms × n (NaN = unknown) | u8 kind × n
export const MAX_POINTS = 20_000_000;
export const maxBlobBytes = (n) => 4 + n * 25;
const MAX_PLACES = 5000;
const MAX_STAY_DAYS = 3660;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns an error message for a malformed blob, or null when it's valid.
export function validatePoints(buf) {
  if (buf.length < 4) return 'The upload is empty.';
  const n = buf.readUInt32LE(0);
  if (n === 0) return 'The file has no location points.';
  if (n > MAX_POINTS) return `Too many points (max ${MAX_POINTS.toLocaleString('en')}).`;
  if (buf.length !== maxBlobBytes(n)) return 'The upload is malformed.';
  const f = new Float64Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + 4 + n * 24));
  for (let i = 0; i < n; i++) {
    const lat = f[i], lng = f[n + i], t = f[2 * n + i];
    if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) return 'The upload has invalid coordinates.';
    if (!Number.isNaN(t) && !Number.isFinite(t)) return 'The upload has invalid timestamps.';
  }
  for (let i = 4 + n * 24; i < buf.length; i++) if (buf[i] > 4) return 'The upload has invalid point types.';
  return null;
}

function validDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

// Returns [places, null] normalized, or [null, error message].
export function validatePlaces(input) {
  if (!Array.isArray(input)) return [null, 'Expected a list of places.'];
  if (input.length > MAX_PLACES) return [null, `Too many places (max ${MAX_PLACES}).`];
  const out = [];
  for (const [i, p] of input.entries()) {
    const where = `Place ${i + 1}`;
    if (!p || typeof p !== 'object') return [null, `${where} is not valid.`];
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name || name.length > 200) return [null, `${where} needs a name (up to 200 characters).`];
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) return [null, `${name}: the location is not valid.`];
    if (!validDate(p.date)) return [null, `${name}: the date must look like 2015-07-20.`];
    const place = { name, lat, lng, date: p.date };
    if (p.to != null && p.to !== '' && p.to !== p.date) {
      if (!validDate(p.to)) return [null, `${name}: the end date must look like 2015-07-20.`];
      const days = (Date.parse(p.to) - Date.parse(p.date)) / 86400000;
      if (days < 0) return [null, `${name}: the end date is before the start date.`];
      if (days > MAX_STAY_DAYS) return [null, `${name}: a stay can be at most ${MAX_STAY_DAYS} days.`];
      place.to = p.to;
    }
    out.push(place);
  }
  return [out, null];
}

async function writeAtomic(file, data) {
  await writeFile(file + '.tmp', data, { mode: 0o600 });
  await rename(file + '.tmp', file);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export class Library {
  constructor(dir) {
    this.dir = dir;
    this.sourcesDir = path.join(dir, 'sources');
    this.indexFile = path.join(dir, 'sources.json');
    this.placesFile = path.join(dir, 'places.json');
    this.sources = [];
    this.places = [];
  }

  async load() {
    this.sources = await readJsonFile(this.indexFile, []);
    this.places = (await readJsonFile(this.placesFile, { places: [] })).places;
  }

  blobPath(id) {
    return path.join(this.sourcesDir, id + '.bin.gz');
  }

  get(id) {
    return this.sources.find((s) => s.id === id);
  }

  // Same name replaces the earlier upload (a newer export of the same file).
  async put(name, blob) {
    const entry = {
      id: this.sources.find((s) => s.name === name)?.id || randomUUID(),
      name,
      points: blob.readUInt32LE(0),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.sourcesDir, { recursive: true });
    await writeAtomic(this.blobPath(entry.id), await gzipAsync(blob));
    this.sources = [...this.sources.filter((s) => s.id !== entry.id), entry];
    await writeAtomic(this.indexFile, JSON.stringify(this.sources, null, 2));
    return entry;
  }

  // Adds [lat, lng, timeMs] path points to the source `name`, creating it if needed.
  // Calls are queued so concurrent appends can't drop each other's points.
  // shortcut: rewrites the whole blob each time; fine at phone ping rates, batch writes if a source nears millions of points.
  append(name, pts) {
    const run = async () => {
      const old = this.sources.find((s) => s.name === name);
      const prev = old ? gunzipSync(await readFile(this.blobPath(old.id))) : Buffer.alloc(4);
      const m = prev.readUInt32LE(0), n = m + pts.length;
      if (n > MAX_POINTS) throw Object.assign(new Error(`Too many points (max ${MAX_POINTS.toLocaleString('en')}).`), { status: 413 });
      const buf = Buffer.alloc(maxBlobBytes(n));
      buf.writeUInt32LE(n, 0);
      for (let col = 0; col < 3; col++) {
        prev.copy(buf, 4 + col * n * 8, 4 + col * m * 8, 4 + (col + 1) * m * 8);
        for (const [i, p] of pts.entries()) buf.writeDoubleLE(p[col], 4 + (col * n + m + i) * 8);
      }
      prev.copy(buf, 4 + n * 24, 4 + m * 24); // kinds; new points stay 0 = path
      return this.put(name, buf);
    };
    this.queue = (this.queue || Promise.resolve()).catch(() => {}).then(run);
    return this.queue;
  }

  async remove(id) {
    this.sources = this.sources.filter((s) => s.id !== id);
    await writeAtomic(this.indexFile, JSON.stringify(this.sources, null, 2));
    await rm(this.blobPath(id), { force: true });
  }

  async setPlaces(places) {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(this.placesFile, JSON.stringify({ places }, null, 2));
    this.places = places;
  }
}
