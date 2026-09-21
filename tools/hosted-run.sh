#!/usr/bin/env bash
# The single guarded entry point for paid hosted checks. NOT run by ordinary CI.
#
#   bash tools/hosted-run.sh <patched-worktree> <new-output-dir> <check>...
#
# Every check, its budget, the settings it needs and the one claim it supports are declared in
# packages/browserbase/examples/hosted/checks.ts. Names not listed there are refused, and every
# named check is validated before the first one allocates. Each check writes <check>.jsonl; a
# record that allocated past its session budget or never completed fails the run.
set -euo pipefail
test "${EFFECT_AGENT_BROWSERBASE_LIVE:-}" = 1 || {
  echo "Refusing hosted Browserbase allocation without EFFECT_AGENT_BROWSERBASE_LIVE=1" >&2
  exit 2
}
: "${BROWSERBASE_API_KEY:?BROWSERBASE_API_KEY is required}"
: "${BROWSERBASE_PROJECT_ID:?BROWSERBASE_PROJECT_ID is required}"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TREE="$(cd "${1:?pass the patched effect-agent worktree}" && pwd)"
OUT="${2:?pass a new output directory}"
shift 2
REGISTRY="$TREE/packages/browserbase/examples/hosted/checks.ts"

PLAN="$(node "$SOURCE_ROOT/tools/hosted-registry.mjs" select "$REGISTRY" "$@")"
test ! -e "$OUT" || { echo "Refusing existing hosted output: $OUT" >&2; exit 1; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# Identify the exact source behind every record, so a result is never mistaken for evidence
# from some other revision.
git -C "$SOURCE_ROOT" rev-parse HEAD > "$OUT/source-sha.txt"

while IFS=$'\t' read -r check media; do
  (
    cd "$TREE/packages/browserbase"
    BROWSERBASE_HOSTED_OUTPUT="$OUT/$check" ../../node_modules/.bin/vp exec bun "examples/hosted/$check.ts"
  ) | tee "$OUT/$check.jsonl"
  node "$SOURCE_ROOT/tools/hosted-registry.mjs" verify "$REGISTRY" "$check" "$OUT/$check.jsonl"
  if [ "$media" = media ]; then bash "$SOURCE_ROOT/tools/hosted-media.sh" "$OUT/$check"; fi
done <<< "$PLAN"

(
  cd "$OUT"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
printf '\nHosted records: %s\n' "$OUT"
