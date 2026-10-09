#!/usr/bin/env bash
# Builds the website and publishes it on the web server (default: ssh host vargar_nas),
# into /var/www/html/pgkiln.vargar.eu, with the Caddy site in deploy/pgkiln.caddy.
#   website/scripts/deploy.sh [ssh-host]
set -euo pipefail
host="${1:-vargar_nas}"
site="$(cd "$(dirname "$0")/.." && pwd)"
ssh=(ssh -o BatchMode=yes -o ClearAllForwardings=yes "$host")

cd "$site"
npm run build
rsync -az --delete -e "ssh -o BatchMode=yes -o ClearAllForwardings=yes" .vitepress/dist/ "$host:pgkiln-site/"
scp -q -o BatchMode=yes -o ClearAllForwardings=yes deploy/pgkiln.caddy "$host:pgkiln-site.caddy"
"${ssh[@]}" bash -s <<'REMOTE'
set -euo pipefail
sudo mkdir -p /var/www/html/pgkiln.vargar.eu
sudo rsync -a --delete ~/pgkiln-site/ /var/www/html/pgkiln.vargar.eu/
sudo chown -R caddy:caddy /var/www/html/pgkiln.vargar.eu
if ! sudo cmp -s ~/pgkiln-site.caddy /etc/caddy/sites/pgkiln.caddy; then
  sudo install -m 644 -o root -g root ~/pgkiln-site.caddy /etc/caddy/sites/pgkiln.caddy
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  sudo systemctl reload caddy
  echo "Caddy reloaded with sites/pgkiln.caddy"
fi
echo "Published to /var/www/html/pgkiln.vargar.eu"
REMOTE
