#!/bin/sh
# Starts as root only to make the data directory writable (bind mounts are often created
# root-owned by Docker), then drops to the unprivileged `node` user for the server itself.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  [ "$(stat -c %u "$DATA_DIR")" = "$(id -u node)" ] || chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
