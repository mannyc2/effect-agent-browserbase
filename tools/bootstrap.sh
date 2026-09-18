#!/usr/bin/env bash
# Reproduce the real effect-agent build environment and land this package in it.
#
# Every input below comes from a canonical public source. Nothing here depends on
# a "prepared" dependency archive, a file upload, or a remote-desktop plugin.
#
#   ./tools/bootstrap.sh [WORKDIR]
#
# Default WORKDIR is ../effect-agent-work. The script refuses to clobber an
# existing worktree so a half-finished run is never silently overwritten.

set -euo pipefail

UPSTREAM_URL="https://github.com/danieljvdm/effect-agent"
UPSTREAM_REV="ea53ea6671a94eb44b8019e942cc2c9468786723"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="${1:-$(dirname "$REPO_ROOT")/effect-agent-work}"
CLONE="$WORKDIR/upstream.git"
TREE="$WORKDIR/tree"

say() { printf '\n==> %s\n' "$*"; }

say "Checking prerequisites"
for tool in git bun node python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
echo "git    $(git --version | awk '{print $3}')"
echo "bun    $(bun --version)          (upstream pins 1.4.2)"
echo "node   $(node -v)                (upstream engines: ^22.18.0 || >=24.11.0)"

if [ -e "$TREE" ]; then
  echo "refusing to overwrite existing worktree: $TREE" >&2
  echo "remove it or pass a different WORKDIR" >&2
  exit 1
fi
mkdir -p "$WORKDIR"

say "Verifying the preserved checkpoint before using it"
python3 "$REPO_ROOT/tools/verify-checkpoint.py" \
  "$REPO_ROOT/checkpoints/browserbase-continuation-04.zip"

say "Fetching pinned upstream $UPSTREAM_REV"
if [ -d "$CLONE" ]; then
  git -C "$CLONE" fetch --quiet origin
else
  GIT_LFS_SKIP_SMUDGE=1 git clone --quiet "$UPSTREAM_URL" "$CLONE"
fi
git -C "$CLONE" cat-file -e "$UPSTREAM_REV^{commit}" \
  || { echo "pinned revision $UPSTREAM_REV not found in $UPSTREAM_URL" >&2; exit 1; }
git -C "$CLONE" worktree add --detach "$TREE" "$UPSTREAM_REV" >/dev/null
echo "worktree at $TREE -> $(git -C "$TREE" rev-parse HEAD)"

say "Applying checkpoint 04 review.patch (once, to clean upstream)"
git -C "$TREE" apply "$REPO_ROOT/checkpoints/patches/review.patch"
echo "applied: 33 files under packages/platform-browserbase"

say "Confirming the applied tree matches this repo's source byte-for-byte"
if diff -r -x node_modules "$TREE/packages/platform-browserbase" \
           "$REPO_ROOT/packages/platform-browserbase" >/dev/null; then
  echo "identical — patched upstream == packages/platform-browserbase"
else
  echo "DIFFERENT — this repo's source has diverged from checkpoints/patches/review.patch." >&2
  echo "That is expected once implementation continues; sync the patch before relying on it." >&2
fi

# The pinned upstream catalog has no playwright-core entry, but the package
# manifest declares "playwright-core": "catalog:". Without this, a frozen install
# fails with: error: playwright-core@catalog: failed to resolve
# See docs/STATUS.md "Workspace integration" for the finding and the real fix.
say "Adding the missing playwright-core catalog entry (see docs/STATUS.md)"
python3 - "$TREE/package.json" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
manifest = json.loads(path.read_text())
if "playwright-core" in manifest.get("catalog", {}):
    print("catalog already pins playwright-core; leaving it alone")
else:
    manifest["catalog"]["playwright-core"] = "1.63.0"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print("catalog playwright-core = 1.63.0")
PY

say "Installing monorepo dependencies"
( cd "$TREE" && bun install )

say "Ready"
cat <<READY

Worktree:  $TREE
Upstream:  $UPSTREAM_REV
Package:   $TREE/packages/platform-browserbase

Repository commands go through Vite+ (never bun/npm run, never bare tsc):

  cd $TREE/packages/platform-browserbase
  ../../node_modules/.bin/vp check       # static checks
  ../../node_modules/.bin/vp test --run  # package tests
  ../../node_modules/.bin/vp run ready   # full repository gate

Independent boundary harness (no monorepo needed, real effect only):

  cd $REPO_ROOT && ./tools/run-boundary-suite.sh

READY
