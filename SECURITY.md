# Security policy

Fog Map handles sensitive data: where you've been and an API key for your photo library.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private
[security advisory form](https://github.com/MateuszKukiela/fog-map/security/advisories/new) instead.
You'll get a reply within a week. Fixes are released as a new image tag and noted in the changelog.

## Supported versions

Only the latest release receives fixes.

## Deployment checklist

- Set `BASIC_AUTH` or put the app behind your own authentication if anyone else can reach it.
- Serve it over HTTPS (terminate TLS at your reverse proxy).
- Give the Immich API key read access only.
- Keep the `/data` volume private: it contains the API key.
