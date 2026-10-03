#!/usr/bin/env bash
# Explicit unpaid profiles. Full remains the default and the release prerequisite: it adds the
# in-source native suites to library, which runs every owned native test against the real tarballs.
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
  # This external installation always executes; --no-cache stops Vite Task replaying a success.
  run install-browser timeout 300s ./node_modules/.bin/vp run --no-cache -F effect-browser install:test-browser
  # Cold runners need the encoder, not apt's recommended display/audio packages. Bound
  # stalled fetches separately from the whole install, and retain the complete apt log.
  run install-media-tools timeout 600s bash -lc '
    set -e
    if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
      apt_options=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
      sudo env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" update
      sudo env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install -y --no-install-recommends ffmpeg
    fi
    ffmpeg -version && ffprobe -version
  '
}
cd "$SOURCE_ROOT"
run tooling timeout 120s env npm_config_offline=true node --test tools/test/*.test.mjs
fast_reject
if [ "$PROFILE" = docs ]; then
  run docs-plan node tools/ci-plan.mjs assert-docs "$WORK_ROOT/ci-plan.json"
  fast_reject
  BASE="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).baseSha)' "$WORK_ROOT/ci-plan.json")"
  run diff-check git diff --check "$BASE" HEAD --
  exit "$FAILED"
fi
run workspace timeout 600s bash tools/workspace.sh "$WORK_ROOT/workspace"
TREE="$WORK_ROOT/workspace"
if [ "$LAST_CODE" = 0 ]; then
  cd "$TREE"
  cp bun.lock "$OUT/bun.lock"
  # Fail a spacing/type regression before downloading Chromium or starting a browser.
  run format timeout 120s ./node_modules/.bin/vp fmt --check packages/browser packages/browserbase packages/agent-browser lint scripts vite.config.ts
  # Every warning blocks, and a disable directive that suppresses nothing fails, so every
  # exception stays necessary.
  run lint timeout 180s ./node_modules/.bin/oxlint -c lint/.oxlintrc.json --deny-warnings --report-unused-disable-directives-severity=error packages/browser packages/browserbase packages/agent-browser
  fast_reject
  run browser-typecheck timeout 180s ./node_modules/.bin/vp run -F effect-browser check
  run generic-typecheck timeout 180s ./node_modules/.bin/vp run -F effect-browserbase check
  run typecheck timeout 180s ./node_modules/.bin/vp run -F effect-agent-browser check
  fast_reject
  if [ "$PROFILE" = full ]; then install_native; fi
  cd "$TREE/packages/browser"
  run browser-unit timeout 180s ../../node_modules/.bin/vp test --run --maxWorkers=1
  if [ "$PROFILE" = full ]; then
    run browser-native timeout 600s env BROWSERBASE_VIDEO_EVIDENCE_DIR="$OUT/video-browser" ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  fi
  run browser-build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE/packages/browserbase"
  run generic-unit timeout 180s ../../node_modules/.bin/vp test --run --maxWorkers=1
  if [ "$PROFILE" = full ]; then
    run generic-native timeout 600s env BROWSERBASE_VIDEO_EVIDENCE_DIR="$OUT/video-generic" ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  fi
  run generic-build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE/packages/agent-browser"
  run unit timeout 180s ../../node_modules/.bin/vp test --run --maxWorkers=1
  if [ "$PROFILE" = full ]; then
    run native timeout 300s env BENCH_OUT_DIR="$OUT/bench-agent" ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  fi
  run build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE"
  run exports timeout 180s ./node_modules/.bin/vp run check:exports
  run purity timeout 180s ./node_modules/.bin/vp run verify:package-purity
  fast_reject
  if [ "$PROFILE" = library ]; then install_native; fast_reject; fi
  cd "$SOURCE_ROOT"
  # All five clean consumers, raw-zero declarations, Node/Bun workflows, and the
  # complete browser, provider and Agent native suites, partitioned across the profiles.
  run packed-consumer timeout 900s bash tools/packed-consumer.sh "$TREE" "$OUT"
  if [ "$LAST_CODE" = 0 ]; then
    VERSION="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$OUT/release-set.json")"
    DIGEST="$(node --input-type=module -e 'import { releaseSetDigest } from "./tools/package-release.mjs"; console.log(releaseSetDigest(process.argv[1]));' "$OUT")"
    run release-identity node tools/verify-release.mjs "$OUT" "$(cat "$OUT/source-sha.txt")" "v$VERSION" "$DIGEST"
    run package-dry-run timeout 300s node tools/publish-release.mjs "$OUT" "$(cat "$OUT/source-sha.txt")" "v$VERSION" "$DIGEST" --dry-run
  fi
  # Whitespace errors anywhere in the owned source, checked against the empty tree so every
  # line counts, not only the lines this candidate changed.
  run review-check git diff --check "$(git hash-object -t tree /dev/null)" HEAD -- packages/browser packages/browserbase packages/agent-browser lint scripts
  tar -czf "$OUT/package-source.tar.gz" -C "$TREE" --exclude=node_modules --exclude=dist --exclude=downloads packages/browser packages/browserbase packages/agent-browser lint scripts
fi
exit "$FAILED"
