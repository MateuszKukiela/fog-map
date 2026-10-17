#!/usr/bin/env node
// Self-hosted fog map: serves the page and pulls photo locations from Immich server-side,
// so the API key never reaches the browser and there's no CORS to configure.
//
//   IMMICH_URL=https://photos.example.com IMMICH_API_KEY=... node server.mjs
//
// Env:
//   IMMICH_URL, IMMICH_API_KEY   Immich server + API key (asset.read). Optional: without them the
//                                page works as before with dropped files only.
//   BASIC_AUTH=user:password     Optional login. Set it if the page is reachable by anyone but you:
//                                /api/immich returns where all your photos were taken.
//   IMMICH_REFRESH_HOURS=6       How long Immich results are cached in memory.
//   PORT=8080
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { fetchImmichPhotos } from './immich.mjs';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { IMMICH_URL, IMMICH_API_KEY, BASIC_AUTH } = process.env;
const REFRESH_MS = (Number(process.env.IMMICH_REFRESH_HOURS) || 6) * 3600 * 1000;

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
function immichJson(force) {
  if (cache && !force && Date.now() - cache.at < REFRESH_MS) return Promise.resolve(cache.body);
  if (!inflight) {
    const started = Date.now();
    inflight = fetchImmichPhotos({ url: IMMICH_URL, apiKey: IMMICH_API_KEY })
      .then((data) => {
        cache = { at: Date.now(), body: JSON.stringify(data) };
        console.log(`Immich: ${data.photos.length} geotagged photos in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return cache.body;
      })
      .finally(() => { inflight = null; });
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

  if (url.pathname === '/api/immich') {
    if (!IMMICH_URL || !IMMICH_API_KEY) return send(res, 404, 'application/json', '{"error":"Immich not configured"}');
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

server.listen(PORT, () => {
  console.log(`fog-map on :${PORT}` + (IMMICH_URL ? `, Immich at ${IMMICH_URL}` : ', Immich not configured') + (expectedAuth ? ', login required' : ''));
  if (IMMICH_URL && IMMICH_API_KEY) immichJson(false).catch(() => {}); // warm the cache
});
