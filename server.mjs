#!/usr/bin/env node
// Self-hosted fog map: serves the page and pulls photo locations from Immich server-side,
// so the API key never reaches the browser and there's no CORS to configure.
//
//   IMMICH_URL=https://photos.example.com IMMICH_API_KEY=... node server.mjs
//
// Env:
//   IMMICH_URL, IMMICH_API_KEY   Optional starting values. Normally set in the page (⚙ Settings);
//                                what's saved there (DATA_DIR/settings.json) wins.
//   DATA_DIR=./data              Where settings are stored (mount a volume here in Docker).
//   BASIC_AUTH=user:password     Optional login. Set it if the page is reachable by anyone but you:
//                                /api/immich returns where all your photos were taken.
//   IMMICH_REFRESH_HOURS=6       How long Immich results are cached in memory.
//   PORT=8080
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { fetchImmichPhotos, checkImmich, normalizeUrl } from './immich.mjs';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { IMMICH_URL, IMMICH_API_KEY, BASIC_AUTH } = process.env;
const REFRESH_MS = (Number(process.env.IMMICH_REFRESH_HOURS) || 6) * 3600 * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

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

const publicSettings = () => ({ immich: { url: immich?.url || '', hasKey: !!immich, source: immich?.source || null } });

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// POST {url, apiKey?, test?}: check the connection, and save it unless test.
async function updateImmich(req) {
  const input = await readJson(req);
  const url = String(input.url ?? ''), apiKey = String(input.apiKey ?? ''), test = input.test === true;
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
  '/index.html': 'index.html',
  ...Object.fromEntries(
    ['app.js', 'parser.js', 'fog.js', 'countries.js', 'airports.js', 'tcc.js', 'cities.js', 'towns.js'].map((f) => ['/' + f, f]),
  ),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const expectedAuth = BASIC_AUTH ? Buffer.from('Basic ' + Buffer.from(BASIC_AUTH).toString('base64')) : null;
function authorized(req) {
  if (!expectedAuth) return true;
  const got = Buffer.from(req.headers.authorization || '');
  return got.length === expectedAuth.length && timingSafeEqual(got, expectedAuth);
}

let cache = null; // { at, body }
let inflight = null;
let generation = 0; // bumped on every settings change so a slow old fetch can't overwrite new data

function resetImmich() {
  generation++;
  cache = null;
  inflight = null;
}

function immichJson(force) {
  if (cache && !force && Date.now() - cache.at < REFRESH_MS) return Promise.resolve(cache.body);
  if (!inflight) {
    const started = Date.now();
    const gen = generation;
    inflight = fetchImmichPhotos({ url: immich.url, apiKey: immich.apiKey })
      .then((data) => {
        const body = JSON.stringify(data);
        if (gen === generation) cache = { at: Date.now(), body };
        console.log(`Immich: ${data.photos.length} geotagged photos in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return body;
      })
      .finally(() => { if (gen === generation) inflight = null; });
  }
  return inflight;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="fog-map"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');

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
      return send(res, err.status || 500, 'application/json', JSON.stringify({ error: err.status ? err.message : 'Could not save settings' }));
    }
    return send(res, 405, 'application/json', '{"error":"Method not allowed"}');
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
    send(res, 200, TYPES[path.extname(file)], await readFile(path.join(ROOT, file)));
  } catch (err) {
    send(res, 500, 'text/plain', 'Server error');
  }
});

await loadSettings();
server.listen(PORT, () => {
  console.log(`fog-map on :${PORT}` + (immich ? `, Immich at ${immich.url}` : ', Immich not configured') + (expectedAuth ? ', login required' : ''));
  if (!expectedAuth) console.warn('No BASIC_AUTH set: anyone who can reach this port can see your photo locations and change settings.');
  if (immich) immichJson(false).catch(() => {}); // warm the cache
});
