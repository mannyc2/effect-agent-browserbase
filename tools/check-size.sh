#!/usr/bin/env bash
# Count effect-browser's code with the same max-lines rule as lint: exclude blank and comment-only
# lines. A change crossing the 12,000-code-line ceiling must delete as much code as it adds.
set -euo pipefail
ceiling=12000
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/size.json" <<'JSON'
{"categories":{"correctness":"off"},"rules":{"max-lines":["warn",{"max":0,"skipBlankLines":true,"skipComments":true}]}}
JSON
"$root/node_modules/.bin/oxlint" --config "$work/size.json" --format json "$root/packages/browser/src" > "$work/count.json"
lines=$(node - "$work/count.json" <<'JS'
const fs = require("node:fs");
const { diagnostics } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let lines = 0;
for (const diagnostic of diagnostics) {
  const count = diagnostic.code === "eslint(max-lines)" && /\((\d+)\)/.exec(diagnostic.message);
  if (!count) throw new Error(`Cannot count source: ${diagnostic.message}`);
  lines += Number(count[1]);
}
if (lines === 0) throw new Error("No source code counted");
console.log(lines);
JS
)
if [ "$lines" -gt "$ceiling" ]; then
  echo "effect-browser's source is $lines code lines, over its ceiling of $ceiling: delete as much as the change adds." >&2
  exit 1
fi
echo "effect-browser's source is $lines code lines, of a $ceiling-code-line ceiling."
