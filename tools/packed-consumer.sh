#!/usr/bin/env bash
# Five clean consumers use the three exact candidate tarballs, never source aliases.
set -euo pipefail
TREE="${1:?effect-agent worktree required}"
OUT="${2:?output directory required}"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test "$(node --version)" = "v$(cat "$SOURCE_ROOT/.node-version")"
test "$(bun --version)" = 1.4.2
node "$SOURCE_ROOT/tools/packed-consumers.mjs" "$TREE" "$OUT" "$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
