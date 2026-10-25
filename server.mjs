#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
// Self-hosted fog map: serves the page and pulls photo locations from Immich server-side,
// so the API key never reaches the browser and there's no CORS to configure.
//
//   IMMICH_URL=https://photos.example.com IMMICH_API_KEY=... node server.mjs
//
// Env:
//   IMMICH_URL, IMMICH_API_KEY   Optional starting values. Normally set in the page (⚙ Settings);
//                                what's saved there (DATA_DIR/settings.json) wins.
//   DATA_DIR=./data              Settings, uploaded location data and places (mount a volume here).
//   BASIC_AUTH=user:password     Optional login. Set it if the page is reachable by anyone but you:
//                                /api/immich returns where all your photos were taken.
//   OWNTRACKS_AUTH=user:password Optional separate login for /api/owntracks only (the phone app), so the
//                                endpoint can skip a forward-auth proxy. Without it, BASIC_AUTH applies.
//   IMMICH_REFRESH_HOURS=6       After this long, Immich results are refreshed in the background
//                                (the saved copy is served meanwhile, so pages never wait for a sync).
//   PORT=8080
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { checkImmich, fetchImmichPhotos, normalizeUrl } from './immich.mjs';
import { Library, MAX_POINTS, maxBlobBytes, validatePlaces, validatePoints } from './library.mjs';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { IMMICH_URL, IMMICH_API_KEY, BASIC_AUTH, OWNTRACKS_AUTH } = process.env;
const REFRESH_MS = (Number(process.env.IMMICH_REFRESH_HOURS) || 6) * 3600 * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const IMMICH_CACHE_FILE = path.join(DATA_DIR, 'immich-cache.json');

// Current Immich connection. The key never leaves this process except toward Immich itself.
let immich = IMMICH_URL && IMMICH_API_KEY ? { url: normalizeUrl(IMMICH_URL), apiKey: IMMICH_API_KEY, source: 'env' } : null;

async function loadSettings() {
  try {
    const saved = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    // `immich: null` means disconnected on purpose, so env values don't come back after a restart.
    if ('immich' in saved) immich = saved.immich ? { ...saved.immich, source: 'ui' } : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read settings:', err.message);
  }
}

async function saveSettings() {
  await mkdir(DATA_DIR, { recursive: true });
  const data = { immich: immich && { url: immich.url, apiKey: immich.apiKey } };
  await writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const OWNTRACKS_SOURCE = 'OwnTracks';
const publicSettings = () => {
  const src = library.sources.find((s) => s.name === OWNTRACKS_SOURCE);
  return {
    immich: { url: immich?.url || '', hasKey: !!immich, source: immich?.source || null },
    owntracks: {
      enabled: !!(expectedOwnTracks || expectedAuth),
      user: (OWNTRACKS_AUTH || BASIC_AUTH || '').split(':')[0],
      points: src?.points || 0,
      lastAt: src?.updatedAt || null,
    },
  };
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'The upload is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 10000) {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

// Writes need a content type that a plain HTML form on another site can't send (CSRF).
function requireType(req, type) {
  if (!(req.headers['content-type'] || '').startsWith(type)) throw httpError(415, `Expected ${type}`);
}

const library = new Library(DATA_DIR);
const sendJson = (res, status, body) => send(res, status, 'application/json', JSON.stringify(body));

// /api/sources[/<id>] and /api/places. Returns false when the path isn't one of them.
async function handleLibrary(req, res, pathname) {
  if (pathname === '/api/sources') {
    if (req.method === 'GET') return sendJson(res, 200, { sources: library.sources });
    if (req.method === 'POST') {
      requireType(req, 'application/octet-stream');
      let name = '';
      try {
        name = decodeURIComponent(req.headers['x-source-name'] || '').trim();
      } catch {}
      if (!name || name.length > 200) throw httpError(400, 'The file needs a name (up to 200 characters).');
      const blob = await readBody(req, maxBlobBytes(MAX_POINTS));
      const invalid = validatePoints(blob);
      if (invalid) throw httpError(400, invalid);
      return sendJson(res, 201, { source: await library.put(name, blob), sources: library.sources });
    }
    throw httpError(405, 'Method not allowed');
  }

  const m = /^\/api\/sources\/([0-9a-f-]{36})$/.exec(pathname);
  if (m) {
    const source = library.get(m[1]);
    if (!source) throw httpError(404, 'No such file.');
    if (req.method === 'GET') {
      const etag = `"${source.updatedAt}"`;
      const headers = { ...SECURITY_HEADERS, etag, 'cache-control': 'no-cache', 'content-type': 'application/octet-stream' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      const gz = await readFile(library.blobPath(source.id));
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
        return res.end(gz);
      }
      res.writeHead(200, { ...headers, vary: 'accept-encoding' });
      return res.end(gunzipSync(gz));
    }
    if (req.method === 'DELETE') {
      await library.remove(source.id);
      return sendJson(res, 200, { sources: library.sources });
    }
    throw httpError(405, 'Method not allowed');
  }

  if (pathname === '/api/places') {
    if (req.method === 'GET') return sendJson(res, 200, { places: library.places });
    if (req.method === 'PUT') {
      requireType(req, 'application/json');
      const [places, error] = validatePlaces((await readJson(req, 2_000_000)).places);
      if (error) throw httpError(400, error);
      await library.setPlaces(places);
      return sendJson(res, 200, { places });
    }
    throw httpError(405, 'Method not allowed');
  }
  return false;
}

// POST {url, apiKey?, test?}: check the connection, and save it unless test.
async function updateImmich(req) {
  const input = await readJson(req);
  const url = String(input.url ?? ''),
    apiKey = String(input.apiKey ?? ''),
    test = input.test === true;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    parsed = null;
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    return [400, { error: 'Enter the full Immich address, starting with https:// or http://' }];
  }
  const target = normalizeUrl(url);
  // The saved key is only reused for the same server, so changing the URL can't send it elsewhere.
  const key = apiKey.trim() || (immich && immich.url === target ? immich.apiKey : '');
  if (!key) return [400, { error: immich ? 'Enter the API key again for a different server.' : 'Enter your API key.' }];
  try {
    const { user } = await checkImmich({ url: target, apiKey: key });
    if (test) return [200, { ok: true, user }];
    immich = { url: target, apiKey: key, source: 'ui' };
    await saveSettings();
    resetImmich();
    return [200, { ok: true, user, ...publicSettings() }];
  } catch (err) {
    return [422, { error: err.message }];
  }
}

// Only these files are served; personal exports lying next to them never are.
const STATIC = {
  '/': 'index.html',
  ...Object.fromEntries(
    [
      'index.html',
      'app.js',
      'parser.js',
      'fog.js',
      'day.js',
      'countries.js',
      'airports.js',
      'tcc.js',
      'cities.js',
      'towns.js',
      'icon.svg',
      'manifest.webmanifest',
      'vendor/maplibre-gl/maplibre-gl.js',
      'vendor/maplibre-gl/maplibre-gl.css',
    ].map((f) => ['/' + f, f]),
  ),
};
// iOS Safari kept running old scripts after an update even with no-cache, so index.html points at
// versioned URLs (a hash of the app files) and every release loads fresh ones.
const assetHash = createHash('sha256');
for (const f of new Set(Object.values(STATIC))) assetHash.update(await readFile(path.join(ROOT, f)));
const ASSET_VERSION = assetHash.digest('hex').slice(0, 10);
const versionAssets = (html) => html.toString().replace(/((?:src|href)=")([\w./-]+\.(?:js|css))"/g, `$1$2?v=${ASSET_VERSION}"`);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const basic = (cred) => (cred ? Buffer.from('Basic ' + Buffer.from(cred).toString('base64')) : null);
const expectedAuth = basic(BASIC_AUTH);
const expectedOwnTracks = basic(OWNTRACKS_AUTH);
function authorized(req, expected) {
  if (!expected) return true;
  const got = Buffer.from(req.headers.authorization || '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// OwnTracks HTTP mode: one JSON message per POST; location messages become path points
// in the OwnTracks source. The app expects a JSON array back.
async function ownTracks(req) {
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
  // A forward-auth proxy usually lets this path through, so never take points without a password.
  if (!expectedOwnTracks && !expectedAuth) throw httpError(403, 'Set OWNTRACKS_AUTH or BASIC_AUTH to accept phone locations.');
  requireType(req, 'application/json');
  const msg = await readJson(req, 100_000);
  if (msg._type !== 'location') return;
  const lat = Number(msg.lat),
    lng = Number(msg.lon),
    t = Number(msg.tst) * 1000;
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180) || !Number.isFinite(t)) throw httpError(400, 'Invalid location.');
  await library.append(OWNTRACKS_SOURCE, [[lat, lng, t]]);
}

let cache = null; // { at, url, body }, also saved to IMMICH_CACHE_FILE so a restart doesn't mean a 15 s sync
let inflight = null;
let generation = 0; // bumped on every settings change so a slow old fetch can't overwrite new data

async function loadImmichCache() {
  try {
    const saved = JSON.parse(await readFile(IMMICH_CACHE_FILE, 'utf8'));
    if (immich && saved.url === immich.url) cache = saved;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read the Immich cache:', err.message);
  }
}

function resetImmich() {
  generation++;
  cache = null;
  inflight = null;
  rm(IMMICH_CACHE_FILE, { force: true }).catch(() => {});
}

function syncImmich() {
  if (!inflight) {
    const started = Date.now();
    const gen = generation;
    inflight = fetchImmichPhotos({ url: immich.url, apiKey: immich.apiKey })
      .then(async (data) => {
        const body = JSON.stringify(data);
        if (gen === generation) {
          cache = { at: Date.now(), url: immich.url, body };
          await mkdir(DATA_DIR, { recursive: true })
            .then(() => writeFile(IMMICH_CACHE_FILE, JSON.stringify(cache), { mode: 0o600 }))
            .catch((err) => console.error('Could not save the Immich cache:', err.message));
        }
        console.log(`Immich: ${data.photos.length} geotagged photos in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return body;
      })
      .finally(() => {
        if (gen === generation) inflight = null;
      });
  }
  return inflight;
}

// Serves the saved result right away and refreshes it in the background once it's stale;
// only the very first sync (or Sync now) makes the page wait.
function immichJson(force) {
  if (!cache || force) return syncImmich();
  if (Date.now() - cache.at >= REFRESH_MS) syncImmich().catch((err) => console.error('Immich:', err.message));
  return Promise.resolve(cache.body);
}

function send(res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-cache' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // Health check for Docker/orchestrators: no login, no data.
  if (req.url === '/healthz') return send(res, 200, 'text/plain', 'ok');
  const isOwnTracks = req.url.split('?')[0] === '/api/owntracks';
  if (!authorized(req, isOwnTracks && expectedOwnTracks ? expectedOwnTracks : expectedAuth)) {
    res.writeHead(401, { ...SECURITY_HEADERS, 'www-authenticate': 'Basic realm="fog-map"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');

  if (isOwnTracks) {
    try {
      await ownTracks(req);
      return sendJson(res, 200, []);
    } catch (err) {
      if (!err.status) console.error('OwnTracks:', err);
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Could not save.' });
    }
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return send(res, 200, 'application/json', JSON.stringify(publicSettings()));
  }

  if (url.pathname === '/api/settings/immich') {
    // JSON-only: a plain HTML form on another site can't send this content type (CSRF).
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, 'application/json', '{"error":"Expected application/json"}');
    }
    try {
      if (req.method === 'POST') {
        const [status, body] = await updateImmich(req);
        return send(res, status, 'application/json', JSON.stringify(body));
      }
      if (req.method === 'DELETE') {
        immich = null;
        await saveSettings();
        resetImmich();
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, ...publicSettings() }));
      }
    } catch (err) {
      console.error('Settings:', err.message);
      return send(
        res,
        err.status || 500,
        'application/json',
        JSON.stringify({ error: err.status ? err.message : 'Could not save settings' }),
      );
    }
    return send(res, 405, 'application/json', '{"error":"Method not allowed"}');
  }

  if (url.pathname === '/api/sources' || url.pathname.startsWith('/api/sources/') || url.pathname === '/api/places') {
    try {
      await handleLibrary(req, res, url.pathname);
    } catch (err) {
      if (!err.status) console.error('Library:', err);
      sendJson(res, err.status || 500, { error: err.status ? err.message : 'Could not save. Check the server log.' });
    }
    return;
  }

  if (url.pathname === '/api/immich') {
    if (!immich) return send(res, 404, 'application/json', '{"error":"Immich not configured"}');
    try {
      return send(res, 200, 'application/json', await immichJson(url.searchParams.has('refresh')));
    } catch (err) {
      console.error('Immich:', err.message);
      return send(res, 502, 'application/json', JSON.stringify({ error: err.message }));
    }
  }

  const file = STATIC[url.pathname];
  if (!file || req.method !== 'GET') return send(res, 404, 'text/plain', 'Not found');
  try {
    const body = await readFile(path.join(ROOT, file));
    send(res, 200, TYPES[path.extname(file)], file === 'index.html' ? versionAssets(body) : body);
  } catch {
    send(res, 500, 'text/plain', 'Server error');
  }
});

await loadSettings();
await loadImmichCache();
await library.load();
server.listen(PORT, () => {
  console.log(
    `fog-map on :${server.address().port}` +
      (immich ? `, Immich at ${immich.url}` : ', Immich not configured') +
      (expectedAuth ? ', login required' : ''),
  );
  if (!expectedAuth) console.warn('No BASIC_AUTH set: anyone who can reach this port can see your photo locations and change settings.');
  if (immich) immichJson(false).catch((err) => console.error('Immich:', err.message)); // warm the cache
});

// Stop cleanly on `docker stop` / Ctrl-C instead of waiting to be killed.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
    server.closeIdleConnections?.();
  });
}
