#!/usr/bin/env bash
# Guarded hosted acceptance. NOT run by ordinary CI.
# Budget: one Browserbase session, <=180s browser lifetime, <=10 actions,
# <=3s live capture, <=512 MiB provider-recording download, zero model calls.
set -euo pipefail
test "${EFFECT_AGENT_BROWSERBASE_LIVE:-}" = 1 || {
  echo "Refusing hosted Browserbase allocation without EFFECT_AGENT_BROWSERBASE_LIVE=1" >&2
  exit 2
}
: "${BROWSERBASE_API_KEY:?BROWSERBASE_API_KEY is required}"
: "${BROWSERBASE_PROJECT_ID:?BROWSERBASE_PROJECT_ID is required}"
TREE="${1:?pass the patched effect-agent worktree}"
cd "$TREE/packages/platform-browserbase"
../../node_modules/.bin/vp exec bun examples/hosted-acceptance.ts
