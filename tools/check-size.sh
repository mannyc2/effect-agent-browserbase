#!/usr/bin/env bash
# effect-browser's source ceiling: its TypeScript under packages/browser/src, counted as
# docs/STATUS.md counts it (`wc -l`), stays at or under 15,000 lines. A change that would cross it
# deletes as much as it adds.
set -euo pipefail
ceiling=15000
root="$(cd "$(dirname "$0")/.." && pwd)"
lines=$(find "$root/packages/browser/src" -name '*.ts' -print0 | xargs -0 cat | wc -l)
lines=$((lines))
if [ "$lines" -gt "$ceiling" ]; then
  echo "effect-browser's source is $lines lines, over its ceiling of $ceiling: delete as much as the change adds." >&2
  exit 1
fi
echo "effect-browser's source is $lines lines, of a $ceiling-line ceiling."
