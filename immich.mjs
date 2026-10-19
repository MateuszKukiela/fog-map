// Fetches GPS position + capture time of every Immich asset.
// Shared by server.mjs (self-hosted) and immich-export.mjs (one-off file export).
const PAGE_SIZE = 1000;

function toPhoto(lat, lng, time, exif = {}) {
  lat = Number(lat);
  lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng, time: time || null, city: exif.city || null, country: exif.country || null };
}

export const normalizeUrl = (url) =>
  url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');

// Checks URL + key with a cheap call. Resolves to { user }, rejects with a message fit for the UI.
export async function checkImmich({ url, apiKey }) {
  const base = normalizeUrl(url);
  const get = (path) =>
    fetch(base + path, {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  let res;
  try {
    res = await get('/api/users/me');
    if (res.status === 404) res = await get('/api/user/me'); // older Immich
  } catch (err) {
    throw new Error(`Can't reach ${base} (${err.cause?.code || err.name}). Check the URL and that this server can access it.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('Immich rejected the API key.');
  if (!res.ok) throw new Error(`${base} answered HTTP ${res.status}. Is this your Immich address?`);
  const me = await res.json().catch(() => null);
  if (!me || typeof me !== 'object') throw new Error(`${base} doesn't look like an Immich server.`);
  return { user: me.name || me.email || 'unknown user' };
}

// Returns { source: 'immich', exportedAt, photos } (the format parser.js reads).
export async function fetchImmichPhotos({ url, apiKey, onProgress = () => {} }) {
  const baseUrl = normalizeUrl(url);

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
      onProgress(scanned, photos.length);
      page = res.assets?.nextPage ? Number(res.assets.nextPage) : null;
    }
    return photos;
  }

  // Fallback for servers without metadata search: one call, but no dates.
  async function fromMapMarkers() {
    const markers = await api('GET', '/map/markers');
    return markers.map((m) => toPhoto(m.lat, m.lon, null, m)).filter(Boolean);
  }

  let photos;
  try {
    photos = await fromMetadataSearch();
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new Error(`Immich rejected the API key: ${err.message}`);
    console.error(`Metadata search failed (${err.message}); falling back to map markers (no dates).`);
    photos = await fromMapMarkers();
  }
  return { source: 'immich', exportedAt: new Date().toISOString(), photos };
}
