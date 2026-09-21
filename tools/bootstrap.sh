#!/usr/bin/env bash
# Reproduce the pinned integration workspace from current source, not a checkpoint.
set -euo pipefail
REV=ea53ea6671a94eb44b8019e942cc2c9468786723
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$ROOT/.work/upstream}"
TREE="$WORK/tree"
for tool in git bun node python3; do command -v "$tool" >/dev/null; done
test "$(node --version)" = "v$(cat "$ROOT/.node-version")"
test "$(bun --version)" = 1.4.2
# A fresh destination prevents stale build products or silently reused lockfiles.
test ! -e "$WORK" || { echo "Refusing existing workspace: $WORK" >&2; exit 1; }
mkdir -p "$WORK"
GIT_LFS_SKIP_SMUDGE=1 git clone --quiet https://github.com/danieljvdm/effect-agent.git "$WORK/upstream.git"
git -C "$WORK/upstream.git" worktree add --detach "$TREE" "$REV"
test "$(git -C "$TREE" rev-parse HEAD)" = "$REV"
git -C "$TREE" apply --check "$ROOT/upstream.patch"
git -C "$TREE" apply "$ROOT/upstream.patch"
# Copy tracked source only: ignored downloads, credentials and build products
# from a developer's working copy cannot enter the canonical integration workspace.
python3 - "$ROOT" "$TREE" <<'PY'
from pathlib import Path
import shutil, subprocess, sys
root, tree = map(Path, sys.argv[1:])
for name in subprocess.check_output([
    'git', '-C', str(root), 'ls-files', '-z', '--', 'packages/browserbase', 'packages/platform-browserbase'
]).decode().split('\0'):
    if not name:
        continue
    source = root / name
    if source.is_symlink() or not source.is_file():
        raise SystemExit(f'Refusing missing or non-regular source: {name}')
    target = tree / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
PY
cd "$TREE"
# Bootstrapping vp follows upstream CI, with scripts disabled and a frozen lock
# on BOTH installs. Do not silently re-resolve the accepted dependency graph.
bun install --frozen-lockfile --ignore-scripts
./node_modules/.bin/vp install --frozen-lockfile --ignore-scripts
./node_modules/.bin/vp run patch:tsgo
printf '\nRestored upstream %s with current source in %s\n' "$REV" "$TREE"
