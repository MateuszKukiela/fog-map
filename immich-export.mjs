#!/usr/bin/env node
// Exports GPS position + capture time of every Immich asset to a JSON file the fog map can load.
// (Not needed when self-hosting with server.mjs, which pulls from Immich directly.)
//
//   IMMICH_URL=https://photos.example.com IMMICH_API_KEY=... node immich-export.mjs [out.json]
//
// API key: Immich web UI -> Account Settings -> API Keys (needs asset.read).
// Only reads from the server; output defaults to ./immich-photos.json.
import { writeFile } from 'node:fs/promises';
import { fetchImmichPhotos } from './immich.mjs';

const url = process.env.IMMICH_URL;
const apiKey = process.env.IMMICH_API_KEY;
const outPath = process.argv[2] || 'immich-photos.json';

if (!url || !apiKey) {
  console.error(
    'Set IMMICH_URL and IMMICH_API_KEY, e.g.\n' + '  IMMICH_URL=https://photos.example.com IMMICH_API_KEY=xxxx node immich-export.mjs',
  );
  process.exit(1);
}

try {
  const data = await fetchImmichPhotos({
    url,
    apiKey,
    onProgress: (scanned, found) => process.stderr.write(`\rscanned ${scanned} assets, ${found} with GPS`),
  });
  process.stderr.write('\n');
  await writeFile(outPath, JSON.stringify(data));
  console.error(`Wrote ${data.photos.length} geotagged photos to ${outPath}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
