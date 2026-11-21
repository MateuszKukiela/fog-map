# syntax=docker/dockerfile:1
FROM node:26-alpine

# Alpine drops old package versions from its index, so a pinned version would break future builds.
# hadolint ignore=DL3018
RUN apk add --no-cache su-exec
WORKDIR /app
# Only the app itself. Personal exports and saved settings are excluded by .dockerignore.
COPY index.html app.js parser.js fog.js day.js countries.js airports.js tcc.js cities.js towns.js \
     icon.svg manifest.webmanifest immich.mjs library.mjs server.mjs ./
COPY vendor/maplibre-gl/ ./vendor/maplibre-gl/
COPY docker-entrypoint.sh /usr/local/bin/

RUN mkdir /data && chown node:node /data
# No USER here: the entrypoint fixes /data ownership as root, then runs the server as `node`.

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/healthz"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
