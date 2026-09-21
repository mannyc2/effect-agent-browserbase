#!/usr/bin/env bash
# Run the 66-case independent Effect boundary harness against real effect@4.0.0-rc.115.
#
# This needs no monorepo, no upstream checkout and no browser — only npm access.
# It is NOT repository, framework-integration or native-browser acceptance; for
# those use tools/bootstrap.sh and the repository's own `vp` commands.
#
#   ./tools/run-boundary-suite.sh [OUTDIR]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTDIR="${1:-$REPO_ROOT/results/local-$(date -u +%Y%m%dT%H%M%SZ)}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUTDIR" "$STAGE/overlay/packages" "$STAGE/probes"
cp -r "$REPO_ROOT/packages/browserbase" "$STAGE/overlay/packages/"
cp "$REPO_ROOT/tools/boundary-runner.mjs" "$STAGE/probes/run.mjs"
printf '{"name":"boundary-harness","private":true,"type":"module"}\n' > "$STAGE/package.json"

echo "==> installing effect@4.0.0-rc.115"
( cd "$STAGE" && npm install --ignore-scripts --no-audit --no-fund --silent effect@4.0.0-rc.115 )

status=0
for runtime in node bun; do
  command -v "$runtime" >/dev/null || { echo "Required runtime missing: $runtime" >&2; exit 1; }
  echo "==> $runtime $("$runtime" --version 2>/dev/null || echo '?')"
  if ( cd "$STAGE" && "$runtime" probes/run.mjs all "$OUTDIR/$runtime.json" ) \
    > "$OUTDIR/$runtime.log" 2>&1; then
    tail -1 "$OUTDIR/$runtime.log"
  else
    status=1
    cat "$OUTDIR/$runtime.log"
  fi
done

echo "==> results written to $OUTDIR"
exit "$status"
