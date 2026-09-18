#!/usr/bin/env bash
# Fixed unpaid verification program. Each command owns its log and exit record;
# expected check failures do not prevent independent boundaries from executing.
set -euo pipefail
OUT="${RUNNER_TEMP:?}/browserbase-results"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$OUT"
git -C "$SOURCE_ROOT" rev-parse HEAD > "$OUT/source-sha.txt"
printf 'Node %s\nBun %s\n' "$(node --version)" "$(bun --version)" > "$OUT/runtimes.txt"
FAILED=0
LAST_CODE=0
run() {
  local name="$1" code=0
  shift
  { printf 'cwd=%q\n' "$PWD"; printf '%q ' "$@"; printf '\n'; } > "$OUT/$name.command"
  printf '\n== %s ==\n' "$name"
  if "$@" > "$OUT/$name.log" 2>&1; then code=0; else code=$?; fi
  LAST_CODE="$code"
  printf '%s %s\n' "$name" "$code" | tee -a "$OUT/statuses.txt"
  tail -70 "$OUT/$name.log"
  if [ "$code" != 0 ]; then FAILED=1; fi
  return 0
}
cd "$SOURCE_ROOT"
run bootstrap timeout 600s bash tools/bootstrap.sh "$RUNNER_TEMP/browserbase-work"
TREE="$RUNNER_TEMP/browserbase-work/tree"
if [ "$LAST_CODE" = 0 ]; then
  cd "$TREE"
  cp bun.lock "$OUT/bun.lock"
  run typecheck timeout 180s ./node_modules/.bin/vp run -F @effect-agent/platform-browserbase check
  run install-browser timeout 300s ./node_modules/.bin/vp run -F @effect-agent/platform-browserbase install:test-browser
  cd packages/platform-browserbase
  run unit timeout 180s ../../node_modules/.bin/vp test --run --maxWorkers=1
  run native timeout 240s ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  run build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE"
  run exports timeout 180s ./node_modules/.bin/vp run check:exports
  run purity timeout 180s ./node_modules/.bin/vp run verify:package-purity
  git add -N packages/platform-browserbase .changeset
  git diff --binary > "$OUT/review.patch"
  tar -czf "$OUT/package-source.tar.gz" --exclude=node_modules --exclude=dist --exclude=downloads packages/platform-browserbase
fi
cd "$SOURCE_ROOT"
git archive --format=tar.gz HEAD > "$OUT/candidate.tar.gz"
cat "$OUT/statuses.txt" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit "$FAILED"
