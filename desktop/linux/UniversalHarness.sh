#!/usr/bin/env bash
# Universal Harness — Linux desktop launcher (v1.0.0).
# Double-clickable (or ./UniversalHarness.sh): starts the node server from this
# USB/Desktop folder and prints the LAN address + pairing info.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
[ -f "$ROOT/bin/uh.mjs" ] || ROOT="$HERE"
[ -d "$ROOT/UniversalHarness" ] && ROOT="$ROOT/UniversalHarness"
export UH_ROOT="$ROOT"

# Bundled node first, system node as fallback.
NODE_EXE="$(find "$ROOT/runtime/node/linux-x64" -name node -type f 2>/dev/null | head -n1 || true)"
if [ -z "${NODE_EXE:-}" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_EXE=node
  else
    echo "[Universal Harness] No bundled Node runtime and no system node."
    echo 'Run "./bin/UniversalHarness.sh setup" first (or bin/uh.mjs setup with a system node).'
    read -r -p "Press Enter to close…" _
    exit 1
  fi
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
echo
echo "============ Universal Harness v1.0.0 ============"
echo "Root:     $ROOT"
echo "LAN:      https://${LAN_IP:-<lan-ip>}:7437"
echo "Pairing:  in a second terminal run  \"$ROOT/bin/UniversalHarness.sh\" pair --endpoint https://${LAN_IP:-<lan-ip>}:7437"
echo "=================================================="
echo

exec "$NODE_EXE" "$ROOT/bin/uh.mjs" serve --listen tls://0.0.0.0:7437
