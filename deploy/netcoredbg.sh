#!/usr/bin/env bash
# This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle (GNU GPL v3 or later).
#
# Download netcoredbg (Samsung, MIT licence), the .NET debugger with gdb's machine interface, into netcoredbg/ of the
# runner, for Step of C# programs. A fixed version, checked by its SHA-256; nothing happens when it is there already.
# No root needed: the sandbox mounts the folder read-only. Run by the deploy after npm ci, and by the CI.
#   bash deploy/netcoredbg.sh
set -euo pipefail
VERSION=3.2.0-1092
case "$(uname -m)" in
    x86_64) ARCH=amd64; SHA=080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa ;;
    aarch64) ARCH=arm64; SHA=065ff49badec8a695dbea2de6ab6a330c774a191e426a217ab8cc05250627ccb ;;
    *) echo "netcoredbg: no build for $(uname -m)"; exit 0 ;;
esac
cd "$(dirname "$0")/.."
if [ -x netcoredbg/netcoredbg ] && [ "$(cat netcoredbg/.version 2>/dev/null)" = "$VERSION" ]; then
    exit 0
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/Samsung/netcoredbg/releases/download/${VERSION}/netcoredbg-linux-${ARCH}.tar.gz" -o "$TMP/n.tgz"
echo "$SHA  $TMP/n.tgz" | sha256sum -c --quiet
tar -xzf "$TMP/n.tgz" -C "$TMP"
rm -rf netcoredbg
mv "$TMP/netcoredbg" netcoredbg
echo "$VERSION" > netcoredbg/.version
echo "netcoredbg $VERSION installed"
