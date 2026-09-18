#!/usr/bin/env bash
# Restore exact upstream once, then synchronize the current package and the
# reviewable workspace integration patch. Historical checkpoints are immutable.
set -euo pipefail
REV=ea53ea6671a94eb44b8019e942cc2c9468786723
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$(dirname "$ROOT")/effect-agent-work}"
TREE="$WORK/tree"
for tool in git bun node python3; do command -v "$tool" >/dev/null; done
test "$(bun --version)" = 1.4.2
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(!((a===22&&b>=18)||(a===24&&b>=11)||a>24))process.exit(1)'
test ! -e "$TREE" || { echo "Refusing existing worktree: $TREE" >&2; exit 1; }
python3 "$ROOT/tools/verify-checkpoint.py" "$ROOT/checkpoints/browserbase-continuation-04.zip"
mkdir -p "$WORK"
GIT_LFS_SKIP_SMUDGE=1 git clone --quiet https://github.com/danieljvdm/effect-agent.git "$WORK/upstream.git"
git -C "$WORK/upstream.git" worktree add --detach "$TREE" "$REV"
test "$(git -C "$TREE" rev-parse HEAD)" = "$REV"
git -C "$TREE" apply --check "$ROOT/checkpoints/patches/review.patch"
git -C "$TREE" apply "$ROOT/checkpoints/patches/review.patch"
# This is a synchronization of subsequent edits, not a second application of
# the historical patch. Only the package owned by this repository is replaced.
python3 - "$ROOT" "$TREE" <<'PY'
from pathlib import Path
import shutil,sys
root,tree=map(Path,sys.argv[1:])
target=tree/'packages/platform-browserbase'
shutil.rmtree(target)
shutil.copytree(root/'packages/platform-browserbase',target,
    ignore=shutil.ignore_patterns('node_modules','dist','downloads'))
PY
if [ -f "$ROOT/upstream.patch" ]; then
  git -C "$TREE" apply --check "$ROOT/upstream.patch"
  git -C "$TREE" apply "$ROOT/upstream.patch"
fi
cd "$TREE"
# Bootstrapping the vp binary mirrors upstream CI's script-suppressed Bun
# install. Once present, all repository commands use the Vite+ command surface.
bun install --ignore-scripts
./node_modules/.bin/vp install --frozen-lockfile --ignore-scripts
./node_modules/.bin/vp run patch:tsgo
printf '\nRestored upstream %s with current source in %s\n' "$REV" "$TREE"
