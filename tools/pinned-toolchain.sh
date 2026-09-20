#!/usr/bin/env bash
# Materialize the pinned Node and Bun on a host that ships different versions.
# bootstrap.sh and run-acceptance.sh both assert these exact versions before doing
# anything, so a session without them cannot bootstrap, format or run acceptance.
# Print a PATH prefix on stdout; everything else goes to stderr so callers can use
# eval "$(bash tools/pinned-toolchain.sh)".
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/.work/toolchain}"
NODE_VERSION="$(cat "$ROOT/.node-version")"
BUN_VERSION=1.4.2
# Digests of the published release assets, verified against the publishers' own
# manifests. A pin change needs a fresh digest from the publisher, never a
# relaxed or skipped check.
NODE_SHA256=84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be
BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913

# Only the acceptance platform is pinned by digest here. Other platforms must
# install the same versions themselves rather than take an unverified download.
test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64 || {
  echo "Pinned digests cover linux-x64 only; install Node $NODE_VERSION and Bun $BUN_VERSION manually." >&2
  exit 1
}
for tool in curl tar unzip sha256sum; do command -v "$tool" >/dev/null; done

NODE_DIR="$DEST/node-v$NODE_VERSION-linux-x64"
BUN_DIR="$DEST/bun-$BUN_VERSION-linux-x64"

verify() { # path expected-digest
  local actual
  actual="$(sha256sum "$1" | cut -d' ' -f1)"
  test "$actual" = "$2" || { echo "Digest mismatch for $1: $actual" >&2; exit 1; }
}

# Reuse an existing install only when it reports the pinned version itself.
if ! { test -x "$NODE_DIR/bin/node" && test "$("$NODE_DIR/bin/node" --version)" = "v$NODE_VERSION"; }; then
  echo "Fetching Node $NODE_VERSION" >&2
  rm -rf "$NODE_DIR"
  mkdir -p "$DEST"
  curl -fsSL -o "$DEST/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  verify "$DEST/node.tar.xz" "$NODE_SHA256"
  tar -xf "$DEST/node.tar.xz" -C "$DEST"
  rm -f "$DEST/node.tar.xz"
  test "$("$NODE_DIR/bin/node" --version)" = "v$NODE_VERSION"
fi

if ! { test -x "$BUN_DIR/bun" && test "$("$BUN_DIR/bun" --version)" = "$BUN_VERSION"; }; then
  echo "Fetching Bun $BUN_VERSION" >&2
  rm -rf "$BUN_DIR" "$DEST/bun-linux-x64"
  mkdir -p "$DEST"
  curl -fsSL -o "$DEST/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip"
  verify "$DEST/bun.zip" "$BUN_SHA256"
  unzip -oq "$DEST/bun.zip" -d "$DEST"
  mv "$DEST/bun-linux-x64" "$BUN_DIR"
  rm -f "$DEST/bun.zip"
  test "$("$BUN_DIR/bun" --version)" = "$BUN_VERSION"
fi

echo "Pinned Node $NODE_VERSION and Bun $BUN_VERSION ready in $DEST" >&2
printf 'export PATH=%q:%q:"$PATH"\n' "$NODE_DIR/bin" "$BUN_DIR"
