#!/usr/bin/env bash
# One-time install on the printer (run as the Klipper user, e.g. pi, from a
# clone of this repo at ~/klipper-toolchanger-ui). Idempotent.
#
#  - links the Klipper helper module into klippy/extras
#  - links toolchanger-safety.cfg into the toolchanger config folder
#  - adds the [include] after the toolchanger include in printer.cfg
#  - serves the web app at /toolchanger/ through Mainsail's nginx site
#  - adds a "Tool Changer" link to Mainsail's sidebar (.theme/navi.json)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
KLIPPER=${KLIPPER:-$HOME/klipper}
CONFIG=${CONFIG:-$HOME/printer_data/config}
NGINX_SITE=${NGINX_SITE:-/etc/nginx/sites-available/mainsail}

ln -sfn "$REPO/klipper/extras/toolchanger_ui.py" "$KLIPPER/klippy/extras/toolchanger_ui.py"
grep -qx 'klippy/extras/toolchanger_ui.py' "$KLIPPER/.git/info/exclude" || echo 'klippy/extras/toolchanger_ui.py' >> "$KLIPPER/.git/info/exclude"

mkdir -p "$CONFIG/toolchanger"
ln -sfn "$REPO/klipper/toolchanger-safety.cfg" "$CONFIG/toolchanger/toolchanger-safety.cfg"
if ! grep -q 'toolchanger/toolchanger-safety.cfg' "$CONFIG/printer.cfg"; then
  cp "$CONFIG/printer.cfg" "$CONFIG/printer.cfg.before-toolchanger-ui"
  sed -i 's#^\[include toolchanger/readonly-configs/toolchanger-include.cfg\]#&\n[include toolchanger/toolchanger-safety.cfg]  \# klipper-toolchanger-ui: safe failures + test mode#' "$CONFIG/printer.cfg"
fi

mkdir -p "$CONFIG/.theme"
[[ -f "$CONFIG/.theme/navi.json" ]] || cp "$REPO/deploy/navi.json" "$CONFIG/.theme/navi.json"

chmod -R o+rX "$REPO"
sudo install -m 644 "$REPO/deploy/nginx-toolchanger-ui.conf" /etc/nginx/snippets/toolchanger-ui.conf
if ! sudo grep -q toolchanger-ui.conf "$NGINX_SITE"; then
  sudo cp "$NGINX_SITE" "$NGINX_SITE.before-toolchanger-ui"
  sudo sed -i '0,/^    location \/websocket {/s##    include snippets/toolchanger-ui.conf;\n\n    location /websocket {#' "$NGINX_SITE"
fi
sudo nginx -t && sudo systemctl reload nginx

echo "Installed. Restart Klipper (sudo systemctl restart klipper) while the printer is idle."
