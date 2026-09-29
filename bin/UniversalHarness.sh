#!/bin/sh
# UniversalHarness — POSIX launcher shim (no global Node required).
#
# Locates the bundled Node runtime pinned in manifests/runtime.manifest.json
# and executes bin/uh.mjs with it. Works for Linux x64 and macOS arm64.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${UH_ROOT:-}" ]; then
  ROOT="$UH_ROOT"
else
  ROOT="$SCRIPT_DIR"
fi

UNAME_S=$(uname -s 2>/dev/null || echo unknown)
UNAME_M=$(uname -m 2>/dev/null || echo unknown)
case "$UNAME_S" in
  Linux*)  DISTRO="linux" ;;
  Darwin*) DISTRO="darwin" ;;
  *)       DISTRO="linux" ;;
esac
ARCH_DIR=$([ "$UNAME_M" = "aarch64" ] || [ "$UNAME_M" = "arm64" ] && echo "arm64" || echo "x64")

NODE_EXE="$ROOT/runtime/node/$DISTRO-$ARCH_DIR/node-v24.21.0-$DISTRO-$ARCH_DIR/bin/node"

if [ ! -x "$NODE_EXE" ]; then
  echo "RUNTIME_MISSING: bundled Node runtime not found at $NODE_EXE" >&2
  echo "Action: run setup on a machine with network access (UniversalHarness setup)," >&2
  echo "or copy the runtime/ directory from a prepared installation." >&2
  exit 11
fi

exec "$NODE_EXE" "$ROOT/bin/uh.mjs" "$@"
