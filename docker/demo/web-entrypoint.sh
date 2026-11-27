#!/bin/sh
# Normalize the proxy origin before the nginx entrypoint renders the config
# template. The shared JS contract in scripts/lib/demo-config.mjs accepts a
# trailing slash on DEMO_ROOM_URL; nginx's `proxy_pass http://host:port/;`
# would otherwise rewrite `/ws` to `/`, so trim trailing slashes here.
set -eu

room_url="${DEMO_ROOM_URL:-http://room:8787}"
while [ "${room_url%/}" != "$room_url" ]; do
  room_url="${room_url%/}"
done

if [ -z "$room_url" ]; then
  echo "DEMO_ROOM_URL must be a non-empty room service origin" >&2
  exit 1
fi

export DEMO_ROOM_URL="$room_url"
exec /docker-entrypoint.sh "$@"
