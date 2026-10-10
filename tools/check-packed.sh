#!/usr/bin/env bash
# The packed-archive check: install the four packed packages in clean consumers, as ones from npm
# would be, and check what those consumers get. TypeScript, with `skipLibCheck: false`, checks the
# declarations of every entry point, and Node imports each one. `bun run ready` cannot see either:
# in the workspace every package resolves from its source.
#
#   tools/check-packed.sh [archives]
#
# `archives` is a directory of the archives `bun pm pack` wrote, as the release workflow packs
# them; without it, the script builds and packs the packages itself. The consumers are made in a
# new directory under $TMPDIR, outside the repository, so nothing resolves from the workspace: point
# TMPDIR at a disk with room if /tmp has none. The first is an npm project, where npm installs the
# peers as a consumer's install would, the newest each peer range allows; the second a Bun
# workspace with the isolated linker, whose application pins its peers exactly, as the consumer
# does. TypeScript and @types/node are at the versions the repository pins. Each is installed, then
# installed again from its lockfile alone, and must hold one copy of each runtime package. On
# success the directory is removed; on failure it is kept, and named.
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
  for dir in browser browserbase human-strokes agent-browser; do
    (cd "$root/packages/$dir" && bun run build > /dev/null && bun pm pack --destination "$archives" --quiet > /dev/null)
  done
fi
names=(effect-browser effect-browserbase effect-browser-human-strokes effect-agent-browser)
runtimes=(effect effect-browser @yielded/agent playwright-core)

# Until the pinned @yielded/agent is on npm, the repository overrides it with an archive pinned to
# a commit, and effect-agent-browser's README has consumers install that archive as a dependency
# and as an override, by its address and integrity. Both consumers here install it so, and their
# lockfiles must hold the integrity bun.lock holds, which the workspace's frozen install checked.
yielded="$(node -p "require('$root/package.json').overrides?.['@yielded/agent'] ?? ''")"
if [ -n "$yielded" ]; then
  [[ $yielded =~ ^https://raw\.githubusercontent\.com/[^/]+/[^/]+/[0-9a-f]{40}/[^/]+\.tgz$ ]] ||
    { echo "The @yielded/agent override, $yielded, is not an archive pinned to a commit." >&2; exit 1; }
  integrity="$(grep -F "[\"@yielded/agent@$yielded\"," "$root/bun.lock" | grep -oE 'sha512-[A-Za-z0-9+/]+=*')"
  for documented in "$yielded" "$integrity"; do
    grep -qF "$documented" "$root/packages/agent-browser/README.md" ||
      { echo "effect-agent-browser's README does not give the archive's $documented." >&2; exit 1; }
  done
fi
quiet() { # runs an install, failing on any word of a peer it could not satisfy
  local log
  log="$("$@" 2>&1)" || { printf '%s\n' "$log" >&2; return 1; }
  if grep -qi 'peer' <<< "$log"; then printf '%s\n' "$log" >&2; echo "$* warned of a peer." >&2; return 1; fi
}
locked() { # $1, the integrity a lockfile holds for the archive
  if [ -n "$yielded" ] && [ "$1" != "$integrity" ]; then
    echo "The consumer locked $yielded at ${1:-no integrity}, not $integrity." >&2
    exit 1
  fi
}
once() { # $@, how many copies of each runtime package a consumer holds, in the order of runtimes
  local index=0
  for count in "$@"; do
    test "$count" = 1 || { echo "The consumer holds $count copies of ${runtimes[$index]}." >&2; exit 1; }
    index=$((index + 1))
  done
}

consumer="$work/consumer"
mkdir "$consumer"
node -e '
  const yielded = process.argv[1];
  const archive = yielded ? { dependencies: { "@yielded/agent": yielded }, overrides: { "@yielded/agent": yielded } } : {};
  console.log(JSON.stringify({ private: true, type: "module", ...archive }, null, 2));
' "$yielded" > "$consumer/package.json"
archived=()
for name in "${names[@]}"; do archived+=("$archives/$name-$version.tgz"); done
quiet npm install --prefix "$consumer" --ignore-scripts --no-audit --no-fund \
  "${archived[@]}" "typescript@$(pin typescript)" "@types/node@$(pin @types/node)"
quiet npm ci --prefix "$consumer" --ignore-scripts --no-audit --no-fund
locked "$(node -p "require('$consumer/package-lock.json').packages['node_modules/@yielded/agent']?.integrity ?? ''")"
mapfile -t counts < <(node -e '
  const keys = Object.keys(require(process.argv[1]).packages);
  for (const name of process.argv.slice(2)) console.log(keys.filter((key) => key.endsWith(`node_modules/${name}`)).length);
' "$consumer/package-lock.json" "${runtimes[@]}")
once "${counts[@]}"

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
imports="$(printf 'await import("%s");\n' "${entries[@]}")"

# Yielded Agent's own declarations do not pass `skipLibCheck: false`: its memory modules, as
# published in 0.1.0-beta.167 too, name types they never declare. Only an error in another file
# fails the check. TypeScript 7 colours its errors even into a pipe, which would hide every
# `error TS` line from the filter, so they come plain. With noEmit, its diagnostic exit is 1;
# fatal exits and output other than these diagnostics and their indented continuations fail.
typecheck() { # $1, a consumer directory with its tsconfig.json
  local checked compiler_status errors ours
  checked="$("$1/node_modules/.bin/tsc" -p "$1/tsconfig.json" --pretty false 2>&1)" && compiler_status=0 || compiler_status=$?
  if [ "$compiler_status" -ne 0 ]; then
    errors="$(printf '%s\n' "$checked" | grep 'error TS' || true)"
    if [ "$compiler_status" -ne 1 ]; then printf '%s\n' "$checked" >&2; exit "$compiler_status"; fi
    ours="$(printf '%s\n' "$checked" | grep -vE '^[^(]*node_modules/@yielded/agent/[^()]+\([0-9]+,[0-9]+\): error TS[0-9]+:|^[[:space:]]|^$' || true)"
    if [ -z "$errors" ] || [ -n "$ours" ]; then printf '%s\n' "$checked" >&2; exit 1; fi
    echo "Yielded Agent's own declarations have $(printf '%s\n' "$errors" | grep -c 'error TS') errors; none is in these packages."
  fi
}
typecheck "$consumer"
(cd "$consumer" && node --input-type=module -e "$imports")
echo "The ${#entries[@]} entry points of ${names[*]} $version typecheck and load in a clean npm consumer."

# The same in a Bun workspace with the isolated linker, where a package sees only the peers linked
# to it. Bun takes a range peer from a registry, so the archives of the other packages are
# overrides too, as their registry versions would be found.
workspace="$work/workspace"
application="$workspace/apps/consumer"
mkdir -p "$application"
printf '[install]\nlinker = "isolated"\n' > "$workspace/bunfig.toml"
node -e '
  const { writeFileSync } = require("node:fs");
  const [workspace, yielded, archives, version, effect, playwright, typescript, types, ...names] = process.argv.slice(1);
  const archive = (name) => `${archives}/${name}-${version}.tgz`;
  const dependencies = { effect, "playwright-core": playwright, typescript, "@types/node": types };
  for (const name of names) dependencies[name] = archive(name);
  // Bun reads overrides from the workspace root only.
  const overrides = { "effect-browser": archive("effect-browser") };
  if (yielded) dependencies["@yielded/agent"] = overrides["@yielded/agent"] = yielded;
  const json = (value) => JSON.stringify(value, null, 2);
  writeFileSync(`${workspace}/package.json`, json({ private: true, workspaces: ["apps/*"], overrides }));
  writeFileSync(`${workspace}/apps/consumer/package.json`, json({ name: "consumer", private: true, type: "module", dependencies }));
' "$workspace" "$yielded" "$archives" "$version" "$(pin effect)" "$(pin playwright-core)" "$(pin typescript)" "$(pin @types/node)" "${names[@]}"
(cd "$workspace" && quiet bun install --ignore-scripts && rm -rf node_modules apps/consumer/node_modules && quiet bun install --frozen-lockfile --ignore-scripts)
if [ -n "$yielded" ]; then locked "$(grep -F "[\"@yielded/agent@$yielded\"," "$workspace/bun.lock" | grep -oE 'sha512-[A-Za-z0-9+/]+=*')"; fi
mapfile -t counts < <(for name in "${runtimes[@]}"; do ls "$workspace/node_modules/.bun" | grep -c "^${name/\//+}@" || true; done)
once "${counts[@]}"
cp "$consumer/index.ts" "$consumer/tsconfig.json" "$application/"
typecheck "$application"
(cd "$application" && node --input-type=module -e "$imports" && bun --eval "$imports")
echo "The ${#entries[@]} entry points of ${names[*]} $version typecheck and load in a clean Bun workspace."
rm -rf "$work"
