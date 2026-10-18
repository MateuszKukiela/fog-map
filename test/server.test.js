// End-to-end tests for server.mjs against a fake Immich server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const KEY = 'good-key';
const AUTH = 'Basic ' + Buffer.from('me:pw').toString('base64');

// Fake Immich: /api/users/me plus two pages of /api/search/metadata; rejects other keys.
function startImmich() {
  const server = http.createServer((req, res) => {
    if (req.headers['x-api-key'] !== KEY) {
      res.writeHead(401);
      return res.end('{"message":"Invalid API key"}');
    }
    if (req.url === '/api/users/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"name":"Test User"}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const item = (lat, lng, t) => ({ fileCreatedAt: t, exifInfo: { latitude: lat, longitude: lng, dateTimeOriginal: t } });
      const page = JSON.parse(body || '{}').page;
      const out = page === 1
        ? { assets: { items: [item(52.23, 21.01, '2024-01-01T10:00:00Z'), item(null, null, '2024-01-02T10:00:00Z')], nextPage: '2' } }
        : { assets: { items: [item(35.34, 33.32, '2024-05-01T10:00:00Z')], nextPage: null } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startApp(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.mjs')], {
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      const m = /fog-map on :(\d+)/.exec(String(d));
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    });
    child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
}

test('server', async (t) => {
  const immich = await startImmich();
  const immichUrl = `http://127.0.0.1:${immich.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fog-map-'));
  const { child, base } = await startApp({ DATA_DIR: dataDir, BASIC_AUTH: 'me:pw' });
  t.after(() => {
    child.kill();
    immich.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const req = (p, opts = {}) => fetch(base + p, { ...opts, headers: { authorization: AUTH, ...opts.headers } });
  const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settings = async (body, method) => {
    const res = await req('/api/settings/immich', method ? { ...json(body), method } : json(body));
    return [res.status, await res.json()];
  };

  await t.test('health check needs no login', async () => {
    const res = await fetch(base + '/healthz');
    assert.equal(res.status, 200);
  });

  await t.test('everything else needs the login', async () => {
    assert.equal((await fetch(base + '/')).status, 401);
    assert.equal((await fetch(base + '/', { headers: { authorization: 'Basic ' + Buffer.from('me:nope').toString('base64') } })).status, 401);
    const res = await req('/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('serves only the app files', async () => {
    for (const p of ['/index.html', '/app.js', '/icon.svg', '/manifest.webmanifest', '/vendor/maplibre-gl/maplibre-gl.js', '/vendor/maplibre-gl/maplibre-gl.css']) {
      assert.equal((await req(p)).status, 200, p);
    }
    for (const p of ['/Timeline.json', '/server.mjs', '/package.json', '/../server.mjs', '/data/settings.json']) {
      assert.equal((await req(p)).status, 404, p);
    }
  });

  await t.test('starts unconfigured', async () => {
    assert.deepEqual(await (await req('/api/settings')).json(), { immich: { url: '', hasKey: false, source: null } });
    assert.equal((await req('/api/immich')).status, 404);
  });

  await t.test('rejects bad input with readable errors', async () => {
    assert.deepEqual(await settings({ url: immichUrl }), [400, { error: 'Enter your API key.' }]);
    assert.equal((await settings({ url: 'ftp://x', apiKey: KEY }))[0], 400);
    assert.deepEqual(await settings({ url: immichUrl, apiKey: 'wrong' }), [422, { error: 'Immich rejected the API key.' }]);
    const [status, body] = await settings({ url: 'http://127.0.0.1:1', apiKey: KEY });
    assert.equal(status, 422);
    assert.match(body.error, /Can't reach/);
  });

  await t.test('refuses non-JSON requests (cross-site form posts)', async () => {
    const res = await req('/api/settings/immich', { method: 'POST', body: 'url=http://evil', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 415);
  });

  await t.test('test connection does not save', async () => {
    assert.deepEqual(await settings({ url: immichUrl, apiKey: KEY, test: true }), [200, { ok: true, user: 'Test User' }]);
    assert.equal((await (await req('/api/settings')).json()).immich.hasKey, false);
  });

  await t.test('save stores the key server-side only', async () => {
    const [status, body] = await settings({ url: immichUrl + '/', apiKey: KEY });
    assert.equal(status, 200);
    assert.deepEqual(body.immich, { url: immichUrl, hasKey: true, source: 'ui' });
    assert.ok(!JSON.stringify(await (await req('/api/settings')).json()).includes(KEY));
    const file = path.join(dataDir, 'settings.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).immich.apiKey, KEY);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  await t.test('serves photo locations from Immich', async () => {
    const body = await (await req('/api/immich')).json();
    assert.equal(body.source, 'immich');
    assert.deepEqual(body.photos.map((p) => [p.lat, p.lng]), [[52.23, 21.01], [35.34, 33.32]]);
  });

  await t.test('saved key is reused only for the same server', async () => {
    assert.equal((await settings({ url: immichUrl }))[0], 200);
    assert.deepEqual(await settings({ url: 'http://evil.example' }), [400, { error: 'Enter the API key again for a different server.' }]);
  });

  // u32 n | f64 lat × n | f64 lng × n | f64 t × n | u8 kind × n
  const blob = (pts) => {
    const n = pts.length;
    const buf = Buffer.alloc(4 + n * 25);
    buf.writeUInt32LE(n, 0);
    pts.forEach(([lat, lng, t, kind], i) => {
      buf.writeDoubleLE(lat, 4 + i * 8);
      buf.writeDoubleLE(lng, 4 + (n + i) * 8);
      buf.writeDoubleLE(t, 4 + (2 * n + i) * 8);
      buf[4 + n * 24 + i] = kind;
    });
    return buf;
  };
  const upload = (name, body, type = 'application/octet-stream') =>
    req('/api/sources', { method: 'POST', body, headers: { 'content-type': type, 'x-source-name': encodeURIComponent(name) } });

  await t.test('stores uploaded location files', async () => {
    assert.deepEqual(await (await req('/api/sources')).json(), { sources: [] });
    const res = await upload('Timeline.json', blob([[52.2, 21.0, 1e12, 0], [52.3, 21.1, NaN, 1]]));
    assert.equal(res.status, 201);
    const { source } = await res.json();
    assert.equal(source.name, 'Timeline.json');
    assert.equal(source.points, 2);

    const got = await req('/api/sources/' + source.id);
    assert.equal(got.status, 200);
    const back = Buffer.from(await got.arrayBuffer());
    assert.deepEqual(back, blob([[52.2, 21.0, 1e12, 0], [52.3, 21.1, NaN, 1]]));

    const again = await req('/api/sources/' + source.id, { headers: { 'if-none-match': got.headers.get('etag') } });
    assert.equal(again.status, 304);
  });

  await t.test('same file name replaces the earlier upload', async () => {
    await upload('Timeline.json', blob([[1, 2, 3, 0]]));
    const { sources } = await (await req('/api/sources')).json();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].points, 1);
  });

  await t.test('rejects malformed uploads and cross-site posts', async () => {
    assert.equal((await upload('x.json', Buffer.from('not points'))).status, 400);
    assert.equal((await upload('x.json', blob([[95, 0, 0, 0]]))).status, 400);
    assert.equal((await upload('x.json', blob([[0, 0, 0, 9]]))).status, 400);
    assert.equal((await upload('', blob([[1, 2, 3, 0]]))).status, 400);
    assert.equal((await upload('x.json', blob([[1, 2, 3, 0]]), 'text/plain')).status, 415);
    assert.equal((await req('/api/sources/00000000-0000-0000-0000-000000000000')).status, 404);
  });

  await t.test('deletes a file', async () => {
    const { sources } = await (await req('/api/sources')).json();
    const res = await req('/api/sources/' + sources[0].id, { method: 'DELETE' });
    assert.deepEqual(await res.json(), { sources: [] });
    assert.equal(fs.readdirSync(path.join(dataDir, 'sources')).length, 0);
  });

  await t.test('stores and validates places', async () => {
    const put = (places) => req('/api/places', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ places }) });
    const good = [{ name: ' San Marino ', lat: 43.9, lng: 12.4, date: '2015-07-20' }, { name: 'London', lat: 51.5, lng: -0.1, date: '2010-11-08', to: '2010-11-21' }];
    assert.equal((await put(good)).status, 200);
    assert.deepEqual((await (await req('/api/places')).json()).places[0], { name: 'San Marino', lat: 43.9, lng: 12.4, date: '2015-07-20' });
    for (const bad of [[{ name: '', lat: 1, lng: 1, date: '2015-01-01' }], [{ name: 'X', lat: 99, lng: 1, date: '2015-01-01' }],
      [{ name: 'X', lat: 1, lng: 1, date: '20.07.2015' }], [{ name: 'X', lat: 1, lng: 1, date: '2015-02-01', to: '2015-01-01' }]]) {
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await (await req('/api/places')).json()).places.length, 2);
  });

  await t.test('disconnect deletes the key', async () => {
    const res = await req('/api/settings/immich', { method: 'DELETE', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).immich, null);
    assert.equal((await req('/api/immich')).status, 404);
  });
});
