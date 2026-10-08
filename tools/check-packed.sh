#!/usr/bin/env bash
# The packed-archive check: install the four packed packages in a clean consumer, as one from npm
# would be, and check what that consumer gets. TypeScript, with `skipLibCheck: false`, checks the
# declarations of every entry point, and Node imports each one. `bun run ready` cannot see either:
# in the workspace every package resolves from its source.
#
#   tools/check-packed.sh [archives]
#
# `archives` is a directory of the archives `bun pm pack` wrote, as the release workflow packs
# them; without it, the script builds and packs the packages itself. The consumer is made in a new
# directory under $TMPDIR, outside the repository, so nothing resolves from the workspace: point
# TMPDIR at a disk with room if /tmp has none. npm installs the peers as a consumer's install
# would, the newest each peer range allows, and TypeScript and @types/node at the versions the
# repository pins. On success the directory is removed; on failure it is kept, and named.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/check-packed.XXXXXX")"
case "$work/" in "$root"/*) echo "$work is inside the repository; set TMPDIR outside it." >&2; exit 1 ;; esac
echo "Checking in $work"
version="$(node -p "require('$root/packages/browser/package.json').version")"
pin() { node -p "require('$root/package.json').devDependencies['$1']"; }

if [ $# -gt 0 ]; then
  archives="$(cd "$1" && pwd)"
else
  archives="$work/archives"
  for dir in browser browserbase human-strokes agent; do
    (cd "$root/packages/$dir" && bun run build > /dev/null && bun pm pack --destination "$archives" --quiet > /dev/null)
  done
fi

consumer="$work/consumer"
mkdir "$consumer"
echo '{ "private": true, "type": "module" }' > "$consumer/package.json"
names=(effect-browser effect-browserbase effect-browser-human-strokes effect-browser-agent)
archived=()
for name in "${names[@]}"; do archived+=("$archives/$name-$version.tgz"); done
npm install --prefix "$consumer" --ignore-scripts --no-audit --no-fund \
  "${archived[@]}" "typescript@$(pin typescript)" "@types/node@$(pin @types/node)"

# Every entry point the packages export, as a consumer would import it.
mapfile -t entries < <(cd "$consumer" && node -e '
  for (const name of process.argv.slice(1))
    for (const key of Object.keys(require(`./node_modules/${name}/package.json`).exports))
      console.log(key === "." ? name : name + key.slice(1));
' "${names[@]}")
index=0
for entry in "${entries[@]}"; do echo "export * as m$((index++)) from \"$entry\";"; done > "$consumer/index.ts"
cat > "$consumer/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "files": ["index.ts"]
}
EOF

# Yielded Agent's own declarations do not pass `skipLibCheck: false`: its memory modules, as
# published in 0.1.0-beta.167 too, name types they never declare. Only an error in another file
# fails the check.
if ! checked="$("$consumer/node_modules/.bin/tsc" -p "$consumer/tsconfig.json")"; then
  ours="$(printf '%s\n' "$checked" | grep 'error TS' | grep -v 'node_modules/@yielded/' || true)"
  if [ -n "$ours" ]; then printf '%s\n' "$checked" >&2; exit 1; fi
  echo "Yielded Agent's own declarations have $(printf '%s\n' "$checked" | grep -c 'error TS') errors; none is in these packages."
fi
(cd "$consumer" && node --input-type=module -e "$(printf 'await import("%s");\n' "${entries[@]}")")
echo "The ${#entries[@]} entry points of ${names[*]} $version typecheck and load in a clean consumer."
rm -rf "$work"
