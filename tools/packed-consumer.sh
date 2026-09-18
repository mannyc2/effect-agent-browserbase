#!/usr/bin/env bash
# Verify the emitted Browserbase package from an npm tarball in a clean consumer.
set -euo pipefail
TREE="${1:?effect-agent worktree required}"
OUT="${2:?output directory required}"
PKG="$TREE/packages/platform-browserbase"
STAGE="$OUT/packed-stage"
CONSUMER="$OUT/packed-consumer"
rm -rf "$STAGE" "$CONSUMER"
mkdir -p "$STAGE/dist" "$CONSUMER"
cp -R "$PKG/dist/." "$STAGE/dist/"
cp "$PKG/LICENSE" "$PKG/README.md" "$STAGE/"
python3 - "$TREE/package.json" "$PKG/package.json" "$STAGE/package.json" <<'PY'
import json,sys
root=json.load(open(sys.argv[1]))
src=json.load(open(sys.argv[2]))
exports={}
for key,value in src["exports"].items():
    assert value.startswith("./src/") and value.endswith(".ts"), value
    stem=value[len("./src/"):-3]
    exports[key]={"types":f"./dist/{stem}.d.mts","default":f"./dist/{stem}.mjs"}
out={k:v for k,v in src.items() if k not in ("devDependencies","scripts","exports")}
out["exports"]=exports
for section in ("dependencies","optionalDependencies","peerDependencies"):
    deps=out.get(section,{})
    for name,value in list(deps.items()):
        if value=="workspace:*":
            if name=="effect-agent": deps[name]="0.1.0-beta.102"
            else: raise SystemExit(f"unresolved workspace dependency {name}")
        elif value=="catalog:":
            deps[name]=root["catalog"][name]
json.dump(out,open(sys.argv[3],"w"),indent=2);open(sys.argv[3],"a").write("\n")
PY
(
  cd "$STAGE"
  npm pack --ignore-scripts --pack-destination "$OUT" >/dev/null
)
TARBALL="$(find "$OUT" -maxdepth 1 -name 'effect-agent-platform-browserbase-*.tgz' -print -quit)"
test -n "$TARBALL"
cat > "$CONSUMER/package.json" <<JSON
{"name":"browserbase-packed-consumer","private":true,"type":"module","dependencies":{"@effect-agent/platform-browserbase":"file:$TARBALL","effect":"4.0.0-rc.115","effect-agent":"0.1.0-beta.102","playwright-core":"1.63.0"}}
JSON
(
  cd "$CONSUMER"
  bun install --ignore-scripts --frozen-lockfile 2>/dev/null || bun install --ignore-scripts
  cat > check.mjs <<'JS'
import assert from "node:assert/strict";
import * as Root from "@effect-agent/platform-browserbase";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { BrowserbaseRecordings } from "@effect-agent/platform-browserbase/recordings";
import { BrowserbaseReplays } from "@effect-agent/platform-browserbase/replays";
import { BrowserbaseDownloads } from "@effect-agent/platform-browserbase/downloads";
import * as Capture from "@effect-agent/platform-browserbase/capture";
import * as Tools from "@effect-agent/platform-browserbase/tools";
assert.ok(Root);
assert.equal(typeof BrowserbaseInteractiveHost.layer, "function");
assert.equal(typeof BrowserbaseRecordings.layer, "function");
assert.equal(typeof BrowserbaseReplays.layer, "function");
assert.equal(typeof BrowserbaseDownloads.layer, "function");
assert.equal(typeof Capture.start, "function");
assert.ok(Tools.toolkit);
console.log(JSON.stringify({runtime:process.version,bun:process.versions.bun??null,result:"packed imports passed"}));
JS
  node check.mjs
  bun check.mjs
)
sha256sum "$TARBALL"
