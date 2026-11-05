#!/usr/bin/env bash
# One-time install on the printer (run as the user Klipper runs as, e.g. pi,
# from a clone of this repo, usually ~/ToolConfig). Idempotent; run it again
# to fix an install made with an older version.
#
#  - links the Klipper helper module into klippy/extras
#  - links toolchanger-safety.cfg into the toolchanger config folder
#  - adds the [include] after the toolchanger include in printer.cfg
#    (klipper-toolchanger-easy; with viesturz/klipper-toolchanger it prints
#    where to add it)
#  - serves the web app at /toolconfig/ through Mainsail's nginx site
#  - adds a "ToolConfig" link to Mainsail's sidebar (.theme/navi.json)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
KLIPPER=${KLIPPER:-$HOME/klipper}
CONFIG=${CONFIG:-$HOME/printer_data/config}
NGINX_SITE=${NGINX_SITE:-/etc/nginx/sites-available/mainsail}

ln -sfn "$REPO/klipper/extras/toolchanger_ui.py" "$KLIPPER/klippy/extras/toolchanger_ui.py"
grep -qx 'klippy/extras/toolchanger_ui.py' "$KLIPPER/.git/info/exclude" || echo 'klippy/extras/toolchanger_ui.py' >> "$KLIPPER/.git/info/exclude"

mkdir -p "$CONFIG/toolchanger"
ln -sfn "$REPO/klipper/toolchanger-safety.cfg" "$CONFIG/toolchanger/toolchanger-safety.cfg"
INCLUDE_NOTE=""
if ! grep -q 'toolchanger/toolchanger-safety.cfg' "$CONFIG/printer.cfg"; then
  if grep -q '^\[include toolchanger/readonly-configs/toolchanger-include.cfg\]' "$CONFIG/printer.cfg"; then
    # klipper-toolchanger-easy: right after its include
    cp "$CONFIG/printer.cfg" "$CONFIG/printer.cfg.before-toolconfig"
    sed -i 's#^\[include toolchanger/readonly-configs/toolchanger-include.cfg\]#&\n[include toolchanger/toolchanger-safety.cfg]  \# ToolConfig: safe failures + test mode#' "$CONFIG/printer.cfg"
  else
    # viesturz/klipper-toolchanger: layouts vary too much to place it safely
    INCLUDE_NOTE="Add  [include toolchanger/toolchanger-safety.cfg]  to printer.cfg AFTER your toolchanger and tool includes (it overrides some of their settings)."
  fi
fi

mkdir -p "$CONFIG/.theme"
[[ -f "$CONFIG/.theme/navi.json" ]] || cp "$REPO/deploy/navi.json" "$CONFIG/.theme/navi.json"

chmod -R o+rX "$REPO"
# The snippet names the folder nginx serves the page from: this clone,
# wherever it is (any user, any home)
sed "s#@REPO@#$REPO#g" "$REPO/deploy/nginx-toolconfig.conf" | sudo tee /etc/nginx/snippets/toolconfig.conf >/dev/null
sudo chmod 644 /etc/nginx/snippets/toolconfig.conf
# Installs from before the rename (klipper-toolchanger-ui) include the old snippet
if sudo grep -q 'snippets/toolchanger-ui.conf' "$NGINX_SITE"; then
  sudo sed -i 's#snippets/toolchanger-ui.conf#snippets/toolconfig.conf#' "$NGINX_SITE"
  sudo rm -f /etc/nginx/snippets/toolchanger-ui.conf
fi
if ! sudo grep -q toolconfig.conf "$NGINX_SITE"; then
  sudo cp "$NGINX_SITE" "$NGINX_SITE.before-toolconfig"
  sudo sed -i '0,/^    location \/websocket {/s##    include snippets/toolconfig.conf;\n\n    location /websocket {#' "$NGINX_SITE"
fi
sudo nginx -t && sudo systemctl reload nginx

# nginx runs as its own user and must be able to read the page. A home
# folder closed to other users (chmod 700/750) gives a 404 at /toolconfig/.
NGINX_USER=$(ps -o user= -C nginx 2>/dev/null | grep -v root | head -n1)
NGINX_USER=${NGINX_USER:-www-data}
if ! sudo -u "$NGINX_USER" test -r "$REPO/web/dist/index.html"; then
  echo "WARNING: nginx ($NGINX_USER) can't read $REPO/web/dist, so /toolconfig/ will show 404."
  echo "  Let it through the folders above the clone, e.g.:  chmod o+x $(dirname "$REPO")"
fi

[[ -z "$INCLUDE_NOTE" ]] || echo "$INCLUDE_NOTE"
echo "Installed. Restart Klipper (sudo systemctl restart klipper) while the printer is idle."
