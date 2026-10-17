# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

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

[1.0.1]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.0.1
[1.0.0]: https://github.com/MateuszKukiela/fog-map/releases/tag/v1.0.0
