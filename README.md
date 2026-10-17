# Fog Map

Everywhere you've been, from Google Timeline exports, Immich photos and hand-added places.
Fog-of-war and push-pin views, countries, Century Club territories, cities and days abroad.

## Self-host (Docker)

1. In Immich: Account Settings → API Keys → create a key (asset read is enough).
2. Put it in `.env` next to `docker-compose.yml`:
   ```
   IMMICH_API_KEY=your-key
   ```
3. Set `IMMICH_URL` in `docker-compose.yml`, then:
   ```
   docker compose up -d --build
   ```
4. Open http://localhost:8080. Photos load from Immich automatically (cached 6 h).
   Drop `Timeline.json` and `manual-places.json` on the page; they're kept in that browser.

**Set `BASIC_AUTH: user:password` if anyone else can reach the page** — it shows where every photo was taken.
The API key stays on the server and is never sent to the browser.

## Without a server

Open `index.html` directly and drop export files on it. For Immich photos, run
`IMMICH_URL=… IMMICH_API_KEY=… node immich-export.mjs` and drop `immich-photos.json`.

## Data sources

Natural Earth (borders), OurAirports, GeoNames (cities, CC BY 4.0), Travelers' Century Club territory list,
OpenFreeMap / OpenStreetMap (map tiles).
