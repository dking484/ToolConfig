#!/usr/bin/env bash
# Build and push ToolConfig to the printer from a dev machine.
#
#   PRINTER=user@printer-host PRINTER_PASS=... deploy/deploy.sh [web|klipper|all]
#
# Uses PuTTY (plink/pscp) because the printer accepts password auth only.
# Files land in /home/pi/ToolConfig (owned by pi, via sudo).
# "klipper" restarts the Klipper service, so only run it while the printer is idle.
set -euo pipefail

cd "$(dirname "$0")/.."
PRINTER=${PRINTER:?set PRINTER=user@host}
PASS=${PRINTER_PASS:?set PRINTER_PASS}
WHAT=${1:-all}
REMOTE=/home/pi/ToolConfig
TMP=$(mktemp -d)

ssh_run() { plink -ssh -batch -pw "$PASS" "$PRINTER" "echo '$PASS' | sudo -S -p '' bash -c \"$1\""; }

if [[ $WHAT == web || $WHAT == all ]]; then
  (cd web && npm run build)
  tar -C web -czf "$TMP/dist.tgz" dist
  pscp -batch -q -pw "$PASS" "$TMP/dist.tgz" deploy/nginx-toolconfig.conf "$PRINTER:/tmp/"
  ssh_run "set -e
    install -d -o pi -g pi $REMOTE/web
    rm -rf $REMOTE/web/dist
    sudo -u pi tar -C $REMOTE/web -xzf /tmp/dist.tgz
    chmod -R o+rX $REMOTE
    install -m 644 /tmp/nginx-toolconfig.conf /etc/nginx/snippets/toolconfig.conf
    nginx -t && systemctl reload nginx"
  echo "web deployed"
fi

if [[ $WHAT == klipper || $WHAT == all ]]; then
  pscp -batch -q -pw "$PASS" klipper/toolchanger-safety.cfg klipper/extras/toolchanger_ui.py "$PRINTER:/tmp/"
  ssh_run "set -e
    install -d -o pi -g pi $REMOTE/klipper/extras
    install -o pi -g pi -m 644 /tmp/toolchanger-safety.cfg $REMOTE/klipper/
    install -o pi -g pi -m 644 /tmp/toolchanger_ui.py $REMOTE/klipper/extras/
    systemctl restart klipper"
  echo "klipper files deployed, Klipper restarted"
fi
rm -rf "$TMP"
