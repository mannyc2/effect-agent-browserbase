#!/usr/bin/env bash
# Install the committed candidate into a fresh directory. Only tracked files at HEAD enter it, so
# ignored downloads, credentials and build products from a working copy cannot, and both
# installs are frozen to bun.lock with lifecycle scripts disabled.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TREE="${1:?pass a new workspace directory}"
for tool in git bun node tar; do command -v "$tool" >/dev/null; done
test "$(node --version)" = "v$(cat "$ROOT/.node-version")"
test "$(bun --version)" = 1.4.2
# A fresh destination prevents stale build products or silently reused installs.
test ! -e "$TREE" || { echo "Refusing existing workspace: $TREE" >&2; exit 1; }
mkdir -p "$TREE"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$TREE"
# Its own repository root, so tools that honour .gitignore stop here rather than applying a
# parent checkout's rules; a workspace under this repository's ignored .work/ lints nothing
# otherwise.
git -C "$TREE" init -q
cd "$TREE"
bun install --frozen-lockfile --ignore-scripts
./node_modules/.bin/vp run patch:tsgo
printf '\nInstalled %s in %s\n' "$(git -C "$ROOT" rev-parse HEAD)" "$TREE"
