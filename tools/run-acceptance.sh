#!/usr/bin/env bash
# Fixed unpaid verification program. Each command owns its log and exit record;
# expected check failures do not prevent independent boundaries from executing.
set -euo pipefail
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_ROOT="${BROWSERBASE_WORK_ROOT:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/browserbase-acceptance.XXXXXX")}"
OUT="$WORK_ROOT/results"
test ! -e "$OUT" || { echo "Refusing existing results: $OUT" >&2; exit 1; }
mkdir -p "$OUT"
# Never label a dirty working copy with a clean commit's identity.
test -z "$(git -C "$SOURCE_ROOT" status --porcelain)" || { echo 'Commit all candidate source before acceptance.' >&2; exit 1; }
test "$(node --version)" = "v$(cat "$SOURCE_ROOT/.node-version")"
test "$(bun --version)" = "$(cat "$SOURCE_ROOT/.bun-version")"
git -C "$SOURCE_ROOT" rev-parse HEAD > "$OUT/source-sha.txt"
printf 'Node %s\nBun %s\n' "$(node --version)" "$(bun --version)" > "$OUT/runtimes.txt"
FAILED=0
LAST_CODE=0
declare -A CODE=()
run() {
  local name="$1" code=0
  shift
  { printf 'cwd=%q\n' "$PWD"; printf '%q ' "$@"; printf '\n'; } > "$OUT/$name.command"
  printf '\n== %s ==\n' "$name"
  if "$@" > "$OUT/$name.log" 2>&1; then code=0; else code=$?; fi
  LAST_CODE="$code"
  CODE["$name"]="$code"
  printf '%s %s\n' "$name" "$code" | tee -a "$OUT/statuses.txt"
  tail -70 "$OUT/$name.log"
  if [ "$code" != 0 ]; then FAILED=1; fi
  return 0
}

# A stage that was deliberately not executed still owes the record an entry and a
# reason. `satisfied` is a prerequisite already met by the host, which is not a
# finding; `skipped` is work this run could not judge because something it needs
# failed, which is. Neither is reported as a pass.
note() {
  local name="$1" state="$2" reason="$3"
  printf '%s\n' "$reason" > "$OUT/$name.log"
  printf 'cwd=%q\n(not executed: %s)\n' "$PWD" "$state" > "$OUT/$name.command"
  CODE["$name"]="$state"
  printf '%s %s\n' "$name" "$state" | tee -a "$OUT/statuses.txt"
  printf '\n== %s (%s: %s) ==\n' "$name" "$state" "$reason"
}

# Run only when every prerequisite stage actually passed. Without this a failed
# build is followed by three stages failing against a missing tarball, which
# reads as four independent defects instead of one.
run_after() {
  local deps="$1" name="$2" dep
  shift 2
  for dep in $deps; do
    case "${CODE[$dep]:-missing}" in
      0 | satisfied) ;;
      *)
        note "$name" skipped "prerequisite stage '$dep' did not pass"
        FAILED=1
        return 0
        ;;
    esac
  done
  run "$name" "$@"
}
cd "$SOURCE_ROOT"
run tooling timeout 120s env npm_config_offline=true node --test tools/test/*.test.mjs
run checkpoint python3 tools/verify-checkpoint.py checkpoints/browserbase-continuation-04.zip
run boundary timeout 300s bash tools/run-boundary-suite.sh "$OUT/boundary"
run bootstrap timeout 600s bash tools/bootstrap.sh "$WORK_ROOT/upstream"
TREE="$WORK_ROOT/upstream/tree"
if [ "$LAST_CODE" = 0 ]; then
  cd "$TREE"
  cp bun.lock "$OUT/bun.lock"
  TASK_CACHE="$TREE/node_modules/.vite/task-cache"
  SEED="${BROWSERBASE_TASK_CACHE:-}"
  run generic-typecheck timeout 180s ./node_modules/.bin/vp run -F @effect-agent/browserbase check
  run typecheck timeout 180s ./node_modules/.bin/vp run -F @effect-agent/platform-browserbase check
  # These two stages exist to make the native boundary runnable, not to prove
  # anything. Installing over a host that already has them needs root and a
  # working apt, which a maintenance host generally does not have, so the whole
  # program used to be unrunnable outside a GitHub runner. Check first; a fresh
  # runner still installs exactly as before.
  if node -e 'process.exit(require("node:fs").existsSync(require(process.argv[1]).chromium.executablePath()) ? 0 : 1)' \
    "$TREE/packages/browserbase/node_modules/playwright-core" 2>/dev/null; then
    note install-browser satisfied 'pinned Playwright Chromium already installed'
  else
    run install-browser timeout 300s ./node_modules/.bin/vp run -F @effect-agent/browserbase install:test-browser
  fi
  # record-video intentionally keeps ffmpeg/ffprobe caller-owned; install them only
  # in this unpaid native acceptance environment rather than as package dependencies.
  if command -v ffmpeg > /dev/null && command -v ffprobe > /dev/null; then
    note install-media-tools satisfied 'ffmpeg and ffprobe already on PATH'
  else
    run install-media-tools timeout 300s bash -lc 'sudo apt-get update >/dev/null && sudo apt-get install -y ffmpeg && ffmpeg -version && ffprobe -version'
  fi
  cd packages/browserbase
  run generic-unit timeout 180s ../../node_modules/.bin/vp test --run --maxWorkers=1
  # The browser owner, live capture and provider artifacts all belong to this package now.
  run generic-native timeout 600s env BROWSERBASE_VIDEO_EVIDENCE_DIR="$OUT/video-generic" ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  run generic-build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE/packages/platform-browserbase"
  run unit timeout 180s ../../node_modules/.bin/vp test --run --passWithNoTests --maxWorkers=1
  run native timeout 300s ../../node_modules/.bin/vp test --config vite.native.config.ts --run
  run build timeout 180s ../../node_modules/.bin/vp pack
  cd "$TREE"
  run exports timeout 180s ./node_modules/.bin/vp run check:exports
  run purity timeout 180s ./node_modules/.bin/vp run verify:package-purity
  cd "$SOURCE_ROOT"
  # A failed build is one finding; the stages that consume its tarballs are then
  # recorded as skipped rather than as further independent failures.
  run_after "generic-build build" packed-consumer timeout 900s bash tools/packed-consumer.sh "$TREE" "$OUT"
  if [ "${CODE[packed-consumer]:-1}" = 0 ]; then
    VERSION="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$OUT/release-set.json")"
    DIGEST="$(node --input-type=module -e 'import { releaseSetDigest } from "./tools/package-release.mjs"; console.log(releaseSetDigest(process.argv[1]));' "$OUT")"
    run release-identity node tools/verify-release.mjs "$OUT" "$(cat "$OUT/source-sha.txt")" "v$VERSION" "$DIGEST"
    run package-dry-run timeout 300s node tools/publish-release.mjs "$OUT" "$(cat "$OUT/source-sha.txt")" "v$VERSION" "$DIGEST" --dry-run
  else
    note release-identity skipped 'no release set: packed-consumer did not pass'
    note package-dry-run skipped 'no release set: packed-consumer did not pass'
  fi
  cd "$TREE"
  # Upstream CI transfers node_modules/.vite/task-cache between runs; do the same
  # instead of paying for every upstream task on every candidate. Vite Task keys
  # each result by that task's own inputs, so a restored entry is replayed only
  # when those inputs match, and ready.log keeps the per-task hit/miss decision.
  #
  # Seed HERE, not earlier. A replayed task result restores workspace files, not
  # effects outside the workspace, and `install:test-browser` puts Chromium in
  # ~/.cache/ms-playwright. Seeding before it let that task report success from
  # cache without installing the browser, so `native` and `packed-consumer` then
  # failed against a missing Chromium. Every stage above this line therefore runs
  # for real on every candidate, which is also what keeps their evidence fresh.
  # A lock file belongs to the run that made it.
  if [ -n "$SEED" ] && [ -d "$SEED" ]; then
    mkdir -p "$TASK_CACHE"
    cp -a "$SEED/." "$TASK_CACHE/"
    find "$TASK_CACHE" -name '*.lock' -delete
    # Task results live in cache.db; only tasks with output files add a blob.
    printf 'seeded from %s: %s files, %s\n' \
      "$SEED" "$(find "$TASK_CACHE" -type f | wc -l)" \
      "$(du -sh "$TASK_CACHE" | cut -f1)" > "$OUT/task-cache.txt"
  else
    printf 'no seed (%s)\n' \
      "${SEED:-BROWSERBASE_TASK_CACHE unset}" > "$OUT/task-cache.txt"
  fi
  # Run the entire upstream gate, without filtering suites or changing assertions.
  # Upstream docs/TOOLCHAIN.md and CI isolate heavy suites because concurrent
  # worker pools can starve ownership-lease renewals. Bound this single runner's
  # task graph too; retain verbose task/cache decisions for the acceptance record.
  run ready timeout 1800s ./node_modules/.bin/vp run -v --concurrency-limit 1 ready
  # Upstream's own release adapter builds and inspects npm-ready manifests without publishing.
  run release-dry-run timeout 900s ./node_modules/.bin/vp run release:publish --dry-run
  # Only candidate source files belong in the review patch. Native CDP can leave
  # generated downloads below the package; a directory-wide add would include them.
  git -C "$SOURCE_ROOT" ls-files -z -- packages/browserbase packages/platform-browserbase | \
    git --literal-pathspecs add -N --pathspec-from-file=- --pathspec-file-nul
  git add -N .changeset/browserbase-interactive.md .changeset/config.json docs/guide/browser.md package.json
  run review-check git diff --check

  git diff --binary > "$OUT/review.patch"
  tar -czf "$OUT/package-source.tar.gz" --exclude=node_modules --exclude=dist --exclude=downloads packages/browserbase packages/platform-browserbase
  # Hand the cache back even when a stage above failed: a task that did pass
  # produced a legitimate result, and discarding it would make the next run pay
  # for it again. Only whole successful task results are stored by Vite Task.
  # Copy over the seed rather than replacing it: everything in it came from there
  # in the first place, so no recursive delete of a caller-supplied path is needed.
  if [ -n "$SEED" ] && [ -d "$TASK_CACHE" ]; then
    mkdir -p "$SEED"
    cp -a "$TASK_CACHE/." "$SEED/"
    find "$SEED" -name '*.lock' -delete
    printf 'exported to %s: %s files, %s\n' \
      "$SEED" "$(find "$SEED" -type f | wc -l)" \
      "$(du -sh "$SEED" | cut -f1)" >> "$OUT/task-cache.txt"
  fi
fi
cd "$SOURCE_ROOT"
run source-cleanliness bash -c 'test -z "$(git status --porcelain)"'
git archive --format=tar.gz HEAD > "$OUT/candidate.tar.gz"
cat "$OUT/statuses.txt" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
(
  cd "$OUT"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
printf '\nAcceptance evidence: %s\n' "$OUT"
exit "$FAILED"
