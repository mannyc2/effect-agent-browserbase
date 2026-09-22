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
  run install-browser timeout 300s ./node_modules/.bin/vp run --no-cache -F effect-browser install:test-browser
  run install-media-tools timeout 300s bash -lc 'if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then sudo apt-get update >/dev/null && sudo apt-get install -y ffmpeg; fi; ffmpeg -version && ffprobe -version'
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
run boundary timeout 300s bash tools/run-boundary-suite.sh "$OUT/boundary"
run bootstrap timeout 600s bash tools/bootstrap.sh "$WORK_ROOT/upstream"
TREE="$WORK_ROOT/upstream/tree"
if [ "$LAST_CODE" = 0 ]; then
  cd "$TREE"
  cp bun.lock "$OUT/bun.lock"
  # Fail a spacing/type regression before downloading Chromium or starting a browser.
  run format timeout 120s ./node_modules/.bin/vp fmt --check packages/browser packages/browserbase packages/agent-browser test
  run lint timeout 180s ./node_modules/.bin/vp lint --type-aware packages/browser packages/browserbase packages/agent-browser test
  fast_reject
  run integration-typecheck timeout 180s ./node_modules/.bin/vp run check:integration
  run browser-typecheck timeout 180s ./node_modules/.bin/vp run -F effect-browser check
  run generic-typecheck timeout 180s ./node_modules/.bin/vp run -F effect-browserbase check
  run typecheck timeout 180s ./node_modules/.bin/vp run -F effect-agent-browser check
  fast_reject
  run integration-unit timeout 180s ./node_modules/.bin/vp run test:integration
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
    run native timeout 300s ../../node_modules/.bin/vp test --config vite.native.config.ts --run
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
  cd "$TREE"
  if [ "$PROFILE" = full ]; then
    # Upstream CI transfers node_modules/.vite/task-cache between runs; do the same for the
    # two upstream stages below, which are where a full run's time goes. Vite Task keys each
    # result by that task's own inputs, so a restored entry is replayed only when those inputs
    # match, and each upstream stage's log keeps every task's hit/miss decision.
    #
    # Seed HERE, never earlier. A replayed result restores workspace files, not effects outside
    # the workspace: Chromium lives in ~/.cache/ms-playwright, so everything above (browser
    # install, native suites, packed consumers) has already run for real on this candidate.
    TASK_CACHE="$TREE/node_modules/.vite/task-cache"
    SEED="${BROWSERBASE_TASK_CACHE:-}"
    if [ -n "$SEED" ] && [ -d "$SEED" ]; then
      mkdir -p "$TASK_CACHE"
      cp -a "$SEED/." "$TASK_CACHE/"
      # A lock file belongs to the run that made it.
      find "$TASK_CACHE" -name '*.lock' -delete
      printf 'seeded from %s: %s files, %s\n' "$SEED" "$(find "$TASK_CACHE" -type f | wc -l)" \
        "$(du -sh "$TASK_CACHE" | cut -f1)" > "$OUT/task-cache.txt"
    else
      printf 'no seed (%s)\n' "${SEED:-BROWSERBASE_TASK_CACHE unset}" > "$OUT/task-cache.txt"
    fi
    # Upstream's `ready` is `check && test && build`. Check and build still cover the whole
    # workspace: the patch touches root manifests, the lockfile, docs and a testing-package
    # suite that every package feeds, and the release dry-run below packs every workspace.
    # Tests run for the workspaces the patch can reach — the three owned packages and the
    # testing package, whose toolchain audit reads every manifest in the tree. The other
    # suites (workerd actors, the travel planner, storage engines) exercise upstream code this
    # patch does not change, and their timing assertions fail on a shared runner for reasons no
    # change here can cause. The scheduled canary still runs them all (BROWSERBASE_UPSTREAM_TESTS=all)
    # so upstream drift is seen daily without being paid for on every candidate.
    UPSTREAM_TESTS="${BROWSERBASE_UPSTREAM_TESTS:-reachable}"
    # Upstream isolates heavy suites because concurrent worker pools can starve ownership-lease
    # renewals; both spellings keep this single runner's test graph serial, as the patched root
    # script does. `all` is that root script itself.
    case "$UPSTREAM_TESTS" in
      reachable) TEST_ARGS=(--parallel --concurrency-limit 1 --fail-if-no-match -F effect-browser -F effect-browserbase -F effect-agent-browser -F @effect-agent/testing test) ;;
      all) TEST_ARGS=(test) ;;
      *) echo "Unknown BROWSERBASE_UPSTREAM_TESTS: $UPSTREAM_TESTS" >&2; exit 2 ;;
    esac
    printf '%s\n' "$UPSTREAM_TESTS" > "$OUT/upstream-tests.txt"
    run upstream-check timeout 900s ./node_modules/.bin/vp run -v check
    run upstream-test timeout 900s ./node_modules/.bin/vp run -v "${TEST_ARGS[@]}"
    run upstream-build timeout 900s ./node_modules/.bin/vp run -v build
    # Upstream's own release adapter builds and inspects npm-ready manifests without publishing.
    run release-dry-run timeout 900s ./node_modules/.bin/vp run release:publish --dry-run
    # Hand results back even after a failure above: a task that passed produced a legitimate
    # result. Copy over the seed rather than replacing it, so no caller path is deleted.
    if [ -n "$SEED" ] && [ -d "$TASK_CACHE" ]; then
      mkdir -p "$SEED"
      cp -a "$TASK_CACHE/." "$SEED/"
      find "$SEED" -name '*.lock' -delete
      printf 'exported to %s: %s files, %s\n' "$SEED" "$(find "$SEED" -type f | wc -l)" \
        "$(du -sh "$SEED" | cut -f1)" >> "$OUT/task-cache.txt"
    fi
    # How much the seed saved, from vp's own per-task decisions, so the gain stays measured.
    grep -hoiE 'cache (hit|miss)' "$OUT"/upstream-{check,test,build}.log "$OUT/release-dry-run.log" 2>/dev/null \
      | tr '[:upper:]' '[:lower:]' | sort | uniq -c >> "$OUT/task-cache.txt" || true
  fi
  # Only candidate source files belong in the review patch. Native CDP can leave
  # generated downloads below the package; a directory-wide add would include them.
  git -C "$SOURCE_ROOT" ls-files -z -- packages/browser packages/browserbase packages/agent-browser test | \
    git --literal-pathspecs add -N --pathspec-from-file=- --pathspec-file-nul
  git add -N .changeset/browserbase-interactive.md .changeset/config.json docs/guide/browser.md package.json
  run review-check git diff --check

  git diff --binary > "$OUT/review.patch"
  tar -czf "$OUT/package-source.tar.gz" --exclude=node_modules --exclude=dist --exclude=downloads packages/browser packages/browserbase packages/agent-browser test
fi
exit "$FAILED"
