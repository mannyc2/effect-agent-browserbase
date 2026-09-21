#!/usr/bin/env bash
# Explicit unpaid profiles. Full remains the default and the release prerequisite.
# Library runs every owned native test against the real tarballs, not three times.
set -euo pipefail
PROFILE="${1:-full}"
case "$PROFILE" in full|library|docs) ;; *) echo "Unknown acceptance profile: $PROFILE" >&2; exit 2 ;; esac
test "$#" -le 1 || { echo 'Usage: tools/run-acceptance.sh [full|library|docs]' >&2; exit 2; }
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_ROOT="${BROWSERBASE_WORK_ROOT:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/browserbase-acceptance.XXXXXX")}"
OUT="$WORK_ROOT/results"
test ! -e "$OUT" || { echo "Refusing existing results: $OUT" >&2; exit 1; }
mkdir -p "$OUT"
# Never label a dirty working copy with a clean commit's identity.
test -z "$(git -C "$SOURCE_ROOT" status --porcelain)" || { echo 'Commit all candidate source before acceptance.' >&2; exit 1; }
test "$(node --version)" = "v$(cat "$SOURCE_ROOT/.node-version")"
test "$(bun --version)" = 1.4.2
git -C "$SOURCE_ROOT" rev-parse HEAD > "$OUT/source-sha.txt"
printf 'Node %s\nBun %s\n' "$(node --version)" "$(bun --version)" > "$OUT/runtimes.txt"
printf '%s\n' "$PROFILE" > "$OUT/acceptance-profile.txt"
if [ -f "$WORK_ROOT/ci-plan.json" ]; then cp "$WORK_ROOT/ci-plan.json" "$OUT/ci-plan.json"; fi
printf 'stage\texit_code\tduration_ms\n' > "$OUT/timings.tsv"
FAILED=0
LAST_CODE=0
run() {
  local name="$1" code=0 started finished
  shift
  { printf 'cwd=%q\n' "$PWD"; printf '%q ' "$@"; printf '\n'; } > "$OUT/$name.command"
  printf '\n== %s ==\n' "$name"
  started="$(node -p 'process.hrtime.bigint().toString()')"
  if "$@" > "$OUT/$name.log" 2>&1; then code=0; else code=$?; fi
  finished="$(node -p 'process.hrtime.bigint().toString()')"
  printf '%s\t%s\t%s\n' "$name" "$code" "$(( (finished - started) / 1000000 ))" >> "$OUT/timings.tsv"
  LAST_CODE="$code"
  printf '%s %s\n' "$name" "$code" | tee -a "$OUT/statuses.txt"
  tail -70 "$OUT/$name.log"
  if [ "$code" != 0 ]; then FAILED=1; fi
  return 0
}
# EXIT also retains partial records on a setup error, a fast rejection or interruption.
finish() {
  local incoming="$?"
  trap - EXIT
  set +e
  if [ "$incoming" != 0 ]; then FAILED=1; fi
  cd "$SOURCE_ROOT" || exit 1
  run source-cleanliness bash -c 'test -z "$(git status --porcelain)"'
  git archive --format=tar.gz HEAD > "$OUT/candidate.tar.gz" || FAILED=1
  if [ "$FAILED" = 0 ]; then
    node tools/ci-evidence.mjs verify "$OUT" "$PROFILE" > "$OUT/evidence-check.log" 2>&1 || FAILED=1
  fi
  if [ "$FAILED" = 0 ]; then
    node tools/ci-evidence.mjs compact "$OUT" > "$OUT/evidence-compaction.log" 2>&1 || FAILED=1
  fi
  printf '%s\n' "$FAILED" > "$OUT/acceptance-exit.txt"
  {
    printf '\n## %s acceptance\n\n' "$PROFILE"
    printf 'This profile is explicit; omitted full-integration stages are not claimed as passes.\n\n'
    printf '| Stage | Exit | Seconds |\n| --- | ---: | ---: |\n'
    awk -F '\t' 'NR > 1 { printf "| %s | %s | %.3f |\n", $1, $2, $3 / 1000 }' "$OUT/timings.tsv"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  if ! ( cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS ); then
    FAILED=1
    printf '1\n' > "$OUT/acceptance-exit.txt"
    rm -f "$OUT/SHA256SUMS"
    printf 'Checksum inventory failed; partial evidence is not accepted.\n' >&2
  fi
  printf '\nAcceptance evidence: %s (%s, exit %s)\n' "$OUT" "$PROFILE" "$FAILED"
  exit "$FAILED"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fast_reject() { if [ "$PROFILE" != full ] && [ "$FAILED" != 0 ]; then exit 1; fi; }
install_native() {
  cd "$TREE"
  # This external installation always executes, never replays a task-cache success.
  run install-browser timeout 300s ./node_modules/.bin/vp run --no-cache -F @effect-agent/browserbase install:test-browser
  run install-media-tools timeout 300s bash -lc 'if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then sudo apt-get update >/dev/null && sudo apt-get install -y ffmpeg; fi; ffmpeg -version && ffprobe -version'
}
cd "$SOURCE_ROOT"
run tooling timeout 120s env npm_config_offline=true node --test tools/test/*.test.mjs
run checkpoint python3 tools/verify-checkpoint.py checkpoints/browserbase-continuation-04.zip
fast_reject
if [ "$PROFILE" = docs ]; then
  run docs-plan node tools/ci-plan.mjs assert-docs "$WORK_ROOT/ci-plan.json"
  fast_reject
  BASE="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).baseSha)' "$WORK_ROOT/ci-plan.json")"
  run diff-check git diff --check "$BASE" HEAD --
  exit "$FAILED"
fi
run boundary timeout 300s bash tools/run-boundary-suite.sh "$OUT/boundary"
run bootstrap timeout 600s bash tools/bootstrap.sh "$WORK_ROOT/upstream"
TREE="$WORK_ROOT/upstream/tree"
if [ "$LAST_CODE" = 0 ]; then
  cd "$TREE"
  cp bun.lock "$OUT/bun.lock"
  # Fail a spacing/type regression before downloading Chromium or starting a browser.
  run format timeout 120s ./node_modules/.bin/vp fmt --check packages/browserbase packages/platform-browserbase
  run lint timeout 180s ./node_modules/.bin/vp lint --type-aware packages/browserbase packages/platform-browserbase
  fast_reject
  run generic-typecheck timeout 180s ./node_modules/.bin/vp run -F @effect-agent/browserbase check
  run typecheck timeout 180s ./node_modules/.bin/vp run -F @effect-agent/platform-browserbase check
  fast_reject
  if [ "$PROFILE" = full ]; then install_native; fi
  cd "$TREE/packages/browserbase"
  run generic-unit timeout 180s ../../node_modules/.bin/vp test --run --maxWorkers=1
  if [ "$PROFILE" = full ]; then
    run generic-native timeout 600s env BROWSERBASE_VIDEO_EVIDENCE_DIR="$OUT/video-generic" ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  fi
  run generic-build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE/packages/platform-browserbase"
  run unit timeout 180s ../../node_modules/.bin/vp test --run --maxWorkers=1
  if [ "$PROFILE" = full ]; then
    run native timeout 300s ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  fi
  run build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE"
  run exports timeout 180s ./node_modules/.bin/vp run check:exports
  run purity timeout 180s ./node_modules/.bin/vp run verify:package-purity
  fast_reject
  if [ "$PROFILE" = library ]; then install_native; fast_reject; fi
  cd "$SOURCE_ROOT"
  # All three clean consumers, raw-zero declarations, Node/Bun workflows, and the
  # complete generic + Agent native suites. No test filtering or cached results.
  run packed-consumer timeout 900s bash tools/packed-consumer.sh "$TREE" "$OUT"
  if [ "$LAST_CODE" = 0 ]; then
    VERSION="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$OUT/release-set.json")"
    DIGEST="$(node --input-type=module -e 'import { releaseSetDigest } from "./tools/package-release.mjs"; console.log(releaseSetDigest(process.argv[1]));' "$OUT")"
    run release-identity node tools/verify-release.mjs "$OUT" "$(cat "$OUT/source-sha.txt")" "v$VERSION" "$DIGEST"
    run package-dry-run timeout 300s node tools/publish-release.mjs "$OUT" "$(cat "$OUT/source-sha.txt")" "v$VERSION" "$DIGEST" --dry-run
  fi
  cd "$TREE"
  if [ "$PROFILE" = full ]; then
    # Run the entire upstream gate, without filtering suites or changing assertions.
    # Upstream docs/TOOLCHAIN.md and CI isolate heavy suites because concurrent
    # worker pools can starve ownership-lease renewals. Bound this single runner's
    # task graph too; retain verbose task/cache decisions for the acceptance record.
    run ready timeout 1800s ./node_modules/.bin/vp run -v --concurrency-limit 1 ready
    # Upstream's own release adapter builds and inspects npm-ready manifests without publishing.
    run release-dry-run timeout 900s ./node_modules/.bin/vp run release:publish --dry-run
  fi
  # Only candidate source files belong in the review patch. Native CDP can leave
  # generated downloads below the package; a directory-wide add would include them.
  git -C "$SOURCE_ROOT" ls-files -z -- packages/browserbase packages/platform-browserbase | \
    git --literal-pathspecs add -N --pathspec-from-file=- --pathspec-file-nul
  git add -N .changeset/browserbase-interactive.md .changeset/config.json docs/guide/browser.md package.json
  run review-check git diff --check

  git diff --binary > "$OUT/review.patch"
  tar -czf "$OUT/package-source.tar.gz" --exclude=node_modules --exclude=dist --exclude=downloads packages/browserbase packages/platform-browserbase
fi
exit "$FAILED"
