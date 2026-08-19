#!/usr/bin/env bash
# Deploy to https://water.huseyincapan.dev. Run from anywhere in the repo.
#
#   cp deploy/deploy.env.example deploy/deploy.env   # once, fill in for your box
#   ./scripts/deploy.sh
#
# Nothing about the target box lives in this repo. The host layout and the
# containers already running on it go in deploy/deploy.env (gitignored), and the
# address and login go in ~/.ssh/config, so the alias names the machine rather
# than this project:
#
#   Host hetzner
#       HostName <server ip>
#       User <user>
#
# Environment wins over the file, so a one-off target is just
# WATER_SERVER=user@host ./scripts/deploy.sh.
#
# Ships COMMITTED state (git archive HEAD), so commit first -- the check below
# refuses a dirty tree rather than shipping something you can't get back to.
# The wasm and the bundle are built in the image, not here, so a deploy does not
# depend on what happens to be installed on this laptop.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# shellcheck disable=SC1091
[ -f deploy/deploy.env ] && . ./deploy/deploy.env

SERVER=${WATER_SERVER:-hetzner}
URL=https://water.huseyincapan.dev

# No defaults for these on purpose: a real path, container or network name would
# describe the box, which is the thing this repo deliberately does not carry.
for v in APP_DIR SITES_DIR CADDY_CONTAINER WEB_NETWORK; do
  if [ -z "${!v:-}" ]; then
    echo "$v is not set. Copy deploy/deploy.env.example to deploy/deploy.env" >&2
    echo "and fill it in for your box." >&2
    exit 1
  fi
done

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$SERVER" true 2>/dev/null; then
  echo "cannot ssh to '$SERVER'. Add a matching block to ~/.ssh/config" >&2
  echo "(see the header of this script), or set WATER_SERVER=user@host." >&2
  exit 1
fi

if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "refusing to deploy: uncommitted changes (this ships HEAD, not your working tree)" >&2
  git status --short >&2
  exit 1
fi

echo "==> shipping $(git rev-parse --short HEAD) to $SERVER:$APP_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive HEAD | tar x -C "$tmp"
# compose reads .env from the app dir; written here because --delete would
# otherwise remove a copy left over from a previous deploy.
printf 'WEB_NETWORK=%s\n' "$WEB_NETWORK" > "$tmp/.env"
rsync -az --delete "$tmp"/ "$SERVER:$APP_DIR/"

# Routing lives in this repo but outside the app dir, so the shared Caddy sees
# it. Reload is a no-op unless water.caddy actually changed.
ssh "$SERVER" "mkdir -p $SITES_DIR"
rsync -az "$tmp"/deploy/water.caddy "$SERVER:$SITES_DIR/"
ssh "$SERVER" "docker exec $CADDY_CONTAINER caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true"

echo "==> rebuilding"
ssh "$SERVER" "cd $APP_DIR && docker compose up -d --build"

echo "==> smoke test"
for path in / /how /bootstrap.js /tiles.mjs; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --retry 5 --retry-delay 2 --retry-all-errors "$URL$path")
  [ "$code" = 200 ] || { echo "FAIL $path -> $code" >&2; exit 1; }
  echo "  $path $code"
done

# The failure this catches is a static host handing back the wasm as
# application/octet-stream, which the page reports as a blank map rather than an
# error. The chunk name is content-hashed, so ask the container rather than
# guessing it.
wasm=$(ssh "$SERVER" "docker exec water-app sh -c 'ls /srv | grep module.wasm'" | tr -d '\r')
[ -n "$wasm" ] || { echo "FAIL: no .module.wasm in the image" >&2; exit 1; }
ctype=$(curl -sS -o /dev/null -w '%{content_type}' "$URL/$wasm")
case "$ctype" in
  application/wasm*) echo "  /$wasm $ctype" ;;
  *) echo "FAIL /$wasm served as '$ctype', expected application/wasm" >&2; exit 1 ;;
esac

echo "==> live: $URL"
