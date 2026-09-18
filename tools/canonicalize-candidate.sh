#!/usr/bin/env bash
# Temporary PR #3 canonicalizer. It never reconstructs source or rewrites
# checkpoints: it formats/lints the current candidate in the exact pinned
# upstream workspace, then copies back only the owned package/integration delta.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${RUNNER_TEMP:?}/browserbase-canonicalize"
TREE="$WORK/tree"

bash "$ROOT/tools/bootstrap.sh" "$WORK"

cd "$TREE"
./node_modules/.bin/vp check --fix

python3 - "$ROOT" "$TREE" <<'PY'
from pathlib import Path
import shutil, sys
root, tree = map(Path, sys.argv[1:])
src = tree / "packages/platform-browserbase"
dst = root / "packages/platform-browserbase"
shutil.rmtree(dst)
shutil.copytree(src, dst, ignore=shutil.ignore_patterns("node_modules", "dist", "downloads"))
PY

git -C "$TREE" diff --binary -- \
  .changeset/browserbase-interactive.md \
  .changeset/config.json \
  package.json \
  docs/guide/browser.md \
  bun.lock > "$ROOT/upstream.patch"

cd "$ROOT"
git diff --exit-code -- checkpoints >/dev/null
git status --short
