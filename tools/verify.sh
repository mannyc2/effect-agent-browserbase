#!/usr/bin/env bash
# Fast local gate for a working tree. Fails on the first problem and prints it.
#
# This is not acceptance. run-acceptance.sh is the fixed evidence program: it
# records every stage's exit code whether or not earlier stages failed, packs a
# checksummed bundle, and is what CI and the release workflow consume. Use this
# while iterating; use that before claiming a candidate passed.
#
# Reuses an existing .work/upstream workspace so repeated runs are cheap.
# Pass --fresh to rebuild it from clean pinned upstream.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/.work/upstream"
TREE="$WORK/tree"
PACKAGE=packages/platform-browserbase

if [ "${1:-}" = --fresh ]; then rm -rf "$WORK"; fi

# The pinned runtimes are a hard prerequisite of bootstrap.sh and of the
# workspace itself. Materialize them rather than failing with a version mismatch
# the caller then has to go and read another script to understand.
if ! { test "$(node --version 2>/dev/null)" = "v$(cat "$ROOT/.node-version")" &&
  test "$(bun --version 2>/dev/null)" = "$(cat "$ROOT/.bun-version")"; }; then
  printf 'Installing the pinned toolchain.\n' >&2
  eval "$(bash "$ROOT/tools/pinned-toolchain.sh")"
fi

step() {
  printf '\n\033[1m== %s ==\033[0m\n' "$1"
  shift
  "$@"
}

if [ ! -d "$TREE" ]; then
  step bootstrap bash "$ROOT/tools/bootstrap.sh" "$WORK"
else
  # Only tracked package files are copied in, exactly as bootstrap.sh does, so a
  # stale workspace never silently tests an older tree.
  printf '\n\033[1m== sync (reusing %s) ==\033[0m\n' "$TREE"
  git -C "$ROOT" ls-files -z -- "$PACKAGE" | while IFS= read -r -d '' name; do
    mkdir -p "$TREE/$(dirname "$name")"
    cp "$ROOT/$name" "$TREE/$name"
  done
fi

cd "$TREE"
if ! node -e 'process.exit(require("node:fs").existsSync(require(process.argv[1]).chromium.executablePath()) ? 0 : 1)' \
  "$TREE/$PACKAGE/node_modules/playwright-core" 2>/dev/null; then
  # Fetches the browser only, skipping the system-dependency step, so this needs
  # no root. A host missing the shared libraries Chromium wants will fail at
  # launch with a clear loader error rather than silently here.
  step install-browser node "$TREE/node_modules/.bun/playwright-core@1.63.0/node_modules/playwright-core/cli.js" install chromium
fi
command -v ffmpeg > /dev/null && command -v ffprobe > /dev/null ||
  printf 'ffmpeg/ffprobe not on PATH: the caller-encoded video tests will fail.\n' >&2

step format ./node_modules/.bin/vp fmt
# Lint is separate from formatting and from typecheck, and it is the one that
# keeps costing a CI round trip: vp fmt does not insert the blank lines
# padding-line-between-statements requires, and tsc never sees the rule. ~15s.
step lint ./node_modules/.bin/vp check
step typecheck ./node_modules/.bin/vp run -F @effect-agent/platform-browserbase check
cd "$TREE/$PACKAGE"
step unit ../../node_modules/.bin/vp test --run --maxWorkers=1
step native env BROWSERBASE_VIDEO_EVIDENCE_DIR="$WORK/video" ../../node_modules/.bin/vp test --config vite.native.config.ts --run
step build ../../node_modules/.bin/vp pack

# vp fmt rewrites files in the workspace copy, not in the repository. Carry any
# change back so a formatting-only CI failure cannot survive a local pass.
changed=0
while IFS= read -r -d '' name; do
  if ! diff -q "$ROOT/$name" "$TREE/$name" > /dev/null 2>&1; then
    cp "$TREE/$name" "$ROOT/$name"
    printf 'formatted: %s\n' "$name"
    changed=1
  fi
done < <(git -C "$ROOT" ls-files -z -- "$PACKAGE")

printf '\n\033[1mLocal gate passed.\033[0m'
if [ "$changed" = 1 ]; then printf ' Formatting was applied above; review and stage it.'; fi
printf '\nNot covered here: boundary suite, packed consumer, full upstream ready, release dry runs.\n'
