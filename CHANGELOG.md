# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.6.1] - 2026-10-25

### Changed

- Day view: the route is smoothed so GPS jitter no longer zigzags, and stretches with no data in between
  (a phone that stopped reporting) show as a dashed line instead of nothing.

## [1.6.0] - 2026-10-25

### Added

- **📅 Day** view: pick a day from a calendar or step through days, see that day's route colored by time
  of day and where you stopped, then drag through the hours or press play to retrace it.

## [1.5.1] - 2026-10-25

### Added

- Lint and format checks with pre-commit (run through uv): Biome for JavaScript, JSON, CSS and HTML,
  actionlint, hadolint, shellcheck and file hygiene hooks. CI runs them before tests and the image build.

### Fixed

- The map no longer stutters while panning and zooming in browsers that draw the fog on the CPU
  (Firefox, Safari): the fog is now blurred at reduced resolution, about twice as fast per frame.
- Buttons outside forms declare `type="button"`; the OwnTracks setup control is a real button.
- The Docker health check no longer needs a shell.

## [1.5.0] - 2026-10-19

### Changed

- Faster page load: your files, places and Immich photos download in parallel without waiting for the
  base map, and the map is computed once instead of twice.
- Immich results are saved in `/data` and served instantly; when they're older than
  `IMMICH_REFRESH_HOURS` they refresh in the background. Restarts no longer mean a full sync on the
  next visit, and a page load never waits for one (except the very first, or **Sync now**).

## [1.4.2] - 2026-10-18

### Fixed

- Pin popup titles were light text on a white background; popups now use dark text.

## [1.4.1] - 2026-10-18

### Fixed

- After an update, iPhones kept running the old scripts with the new page (empty OwnTracks fields,
  no pin dates). Script and style URLs now carry a version, so every release loads fresh copies.

## [1.4.0] - 2026-10-18

### Added

- Tapping a pin shows when you were there: your trips to that place, newest first, following the year filter.

## [1.3.3] - 2026-10-18

### Fixed

- Northern Cyprus and Somaliland no longer count as separate countries (they showed a white flag);
  they count as Cyprus and Somalia. The Travelers' Century Club count still lists them separately.

## [1.3.2] - 2026-10-18

### Fixed

- The OwnTracks setup link turns on the app's Password switch; without it OwnTracks sends an empty
  password and every point is rejected with 401.

## [1.3.1] - 2026-10-18

### Fixed

- The OwnTracks setup button explains that OwnTracks needs **Allow external configuration** turned on
  first; without it the app says "URI or file configuration not allowed".

## [1.3.0] - 2026-10-18

### Added

- Settings → Phone (OwnTracks): shows the URL and user to enter, how many points arrived and when,
  and a "Set up OwnTracks on this phone" button that opens the app with everything but the password filled in.

## [1.2.0] - 2026-10-18

### Added

- OwnTracks support: the phone app posts your location to `/api/owntracks` and it lands in an
  "OwnTracks" source, so the map stays current without Timeline exports. `OWNTRACKS_AUTH` sets a
  separate login for that endpoint.

## [1.1.0] - 2026-10-18

### Added

- Uploaded files and places are stored on the server (`/data`), so every device shows the same map.
  Files are parsed in the browser and uploaded in a compact binary form.
- Places editor: add, edit and delete trips by hand, with offline search over 76,000 towns (every
  capital included, accent-insensitive) or picking the spot on the map.
- Dropping `manual-places.json` imports its places into the list.
- Data saved in a browser by earlier versions moves to the server automatically on first visit.

### Changed

- Bundled town list now includes all capitals and regional seats regardless of size.

## [1.0.1] - 2026-10-17

### Fixed

- Bind-mounted data directories created root-owned by Docker are now made writable on start, so saving settings works without a manual `chown`. The server itself still runs unprivileged.
- The web app manifest is requested with credentials, so it loads behind forward-auth proxies (tinyauth, Authelia, Authentik).

## [1.0.0] - 2026-10-17

First public release.

### Added

- Fog-of-war map revealed by GPS tracks, visits and photos, with adjustable radius and density.
- Pin view: a red push-pin on every visited city (100k+ people) and every place with a real stop.
- Immich integration configured in the page (URL + API key stored server-side), cached and refreshable.
- Google Timeline import: Android and iPhone on-device exports, legacy Takeout `Records.json` and Semantic Location History.
- Manual places with date ranges.
- Counters: countries, cities, Travelers' Century Club territories, days abroad per year (home country detected automatically).
- Year filter, per-file management, browser-side storage of dropped files.
- Noise cleanup: in-flight points, geolocation teleports, one-off countries, airport layovers.
- Docker image for linux/amd64 and linux/arm64 with health check, optional basic auth and SBOM/provenance attestations.

[1.6.1]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.6.1
[1.6.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.6.0
[1.5.1]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.5.1
[1.5.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.5.0
[1.4.2]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.4.2
[1.4.1]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.4.1
[1.4.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.4.0
[1.3.3]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.3.3
[1.3.2]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.3.2
[1.3.1]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.3.1
[1.3.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.3.0
[1.2.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.2.0
[1.1.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.1.0
[1.0.1]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.0.1
[1.0.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.0.0
