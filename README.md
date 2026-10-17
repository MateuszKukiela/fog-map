# Fog Map

Everywhere you've been, from Google Timeline exports, Immich photos and hand-added places.
Fog-of-war and push-pin views, countries, Century Club territories, cities and days abroad.

## Self-host (Docker)

```
docker compose up -d --build
```

Open http://localhost:8080, click ⚙ and enter your Immich URL and API key
(Immich → Account Settings → API Keys → New API Key; read access to assets is enough).
**Test connection** checks it, **Save** stores it and photos load automatically (cached 6 h, **Sync now** refreshes).

- The key is saved in `./data/settings.json` (mode 600) on the server and never sent back to the browser.
  Changing the server URL requires entering the key again, so it can't be redirected elsewhere.
- Drop `Timeline.json` and `manual-places.json` on the page; they're kept in that browser.
- `IMMICH_URL` / `IMMICH_API_KEY` env vars still work as starting values; settings saved in the page win.

**Set `BASIC_AUTH: user:password` if anyone else can reach the page.** Without it, anyone who can open it
sees where every photo was taken and can change the Immich connection.

## Without a server

Open `index.html` directly and drop export files on it. For Immich photos, run
`IMMICH_URL=… IMMICH_API_KEY=… node immich-export.mjs` and drop `immich-photos.json`.

## Data sources

Natural Earth (borders), OurAirports, GeoNames (cities, CC BY 4.0), Travelers' Century Club territory list,
OpenFreeMap / OpenStreetMap (map tiles).
