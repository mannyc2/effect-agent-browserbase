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
# Keep reproducible inputs and results, not a second copy of all tool binaries.
trap 'rm -rf "$CONSUMER/node_modules"' EXIT
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
{"name":"browserbase-packed-consumer","private":true,"type":"module","scripts":{"check":"tsc --noEmit -p tsconfig.json"},"dependencies":{"@effect-agent/platform-browserbase":"file:$TARBALL","effect":"4.0.0-rc.115","effect-agent":"0.1.0-beta.102","playwright-core":"1.63.0"},"devDependencies":{"@effect-agent/testing":"0.1.0-beta.102","@effect/vitest":"4.0.0-rc.115","@types/node":"26.1.2","typescript":"7.0.2","vite-plus":"0.3.2","vitest":"4.1.11"},"overrides":{"effect":"4.0.0-rc.115","vitest":"4.1.11"}}
JSON
(
  cd "$CONSUMER"
  bun install --ignore-scripts
  ./node_modules/.bin/vp install --frozen-lockfile --ignore-scripts
  cat > check.mjs <<'JS'
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Root from "@effect-agent/platform-browserbase";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { BrowserbaseRecordings } from "@effect-agent/platform-browserbase/recordings";
import { BrowserbaseReplays } from "@effect-agent/platform-browserbase/replays";
import { BrowserbaseDownloads } from "@effect-agent/platform-browserbase/downloads";
import * as Capture from "@effect-agent/platform-browserbase/capture";
import * as Tools from "@effect-agent/platform-browserbase/tools";
for (const subpath of ["", "/interactive-browser", "/types", "/tools", "/recordings", "/replays", "/downloads", "/capture"]) {
  const resolved = realpathSync(fileURLToPath(import.meta.resolve(`@effect-agent/platform-browserbase${subpath}`)));
  assert.ok(resolved.startsWith(realpathSync(process.cwd()) + "/"));
  assert.ok(resolved.includes("/dist/") && resolved.endsWith(".mjs"), resolved);
}
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
  mkdir -p test/native test/fixtures examples
  # Copy unchanged real suites/fixture, never production source or workspace aliases.
  cp "$PKG"/test/native/*.test.ts test/native/
  cp "$PKG/test/fixtures/LocalBrowser.ts" test/fixtures/
  cp "$PKG/examples/record-video.ts" examples/
  cp "$PKG/vite.native.config.ts" .
  cat > tsconfig.json <<'JSON'
{"compilerOptions":{"target":"ES2023","lib":["ES2023","DOM","DOM.Iterable"],"module":"NodeNext","moduleResolution":"NodeNext","allowImportingTsExtensions":true,"noEmit":true,"strict":true,"noUnusedLocals":true,"noUnusedParameters":true,"skipLibCheck":true,"types":["node"]},"include":["test","examples","vite.native.config.ts"]}
JSON
  ./node_modules/.bin/vp run check
  BROWSERBASE_VIDEO_EVIDENCE_DIR="$OUT/video-packed" ./node_modules/.bin/vp test --config vite.native.config.ts --run
  cat > native-consumer.mjs <<'JS'
import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { BrowserNavigateRequest, BrowserReadTextRequest } from "effect-agent/interactive-browser";
import { ObservedElement } from "@effect-agent/platform-browserbase/types";
import { localBrowser, policy, withProvider } from "./test/fixtures/LocalBrowser.ts";
import { recordInterval } from "./examples/record-video.ts";
const runtime = process.versions.bun === undefined ? "node" : "bun";
const output = join(process.cwd(), `video-${runtime}`);
await mkdir(output, { recursive: true });
const evidence = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fixture = yield* localBrowser;
  const captured = yield* withProvider(fixture, Effect.gen(function* () {
    const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);
    yield* session.handle.navigate(BrowserNavigateRequest.make({ url: fixture.url }));
    const observation = yield* session.observe();
    const control = observation.controls.find((item) => item.label === "Increment");
    assert.ok(control);
    yield* session.clickElement(ObservedElement.make({ observationId: observation.observationId, elementId: control.elementId }));
    assert.equal((yield* session.handle.readText(BrowserReadTextRequest.make({ selector: "#count" }))).text, "1");
    const path = join(fixture.directory, "consumer.mp4");
    const result = yield* recordInterval(session, path, 2000);
    const times = result.decodedFrames.map((frame) => frame.presentationTimeMillis);
    const decodedSpan = Math.max(...times) - Math.min(...times);
    assert.notEqual(result.summary.sourceFirstMillis, null);
    assert.notEqual(result.summary.sourceLastMillis, null);
    const sourceSpan = result.summary.sourceLastMillis - result.summary.sourceFirstMillis;
    const distinctFrames = new Set(result.decodedFrames.map((frame) => frame.checksum)).size;
    assert.ok(distinctFrames > 1);
    assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
    assert.ok(decodedSpan > 250 && Math.abs(decodedSpan - sourceSpan) < 160);
    assert.ok((yield* session.observe()).text.includes("Local browser fixture"));
    yield* Effect.promise(() => copyFile(path, join(output, "capture.mp4")));
    return { decodedFrameCount: result.decodedFrames.length, distinctFrames, decodedSpan, sourceSpan, frames: result.decodedFrames };
  }));
  assert.equal(fixture.createBodies.length, 1);
  assert.equal(fixture.releaseIds.length, 1);
  return { runtime, node: process.version, bun: process.versions.bun ?? null, result: "packed native consumer passed", captured };
})));
await writeFile(join(output, "verification.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
JS
  node native-consumer.mjs | tee node-native.log
  bun native-consumer.mjs | tee bun-native.log
)
sha256sum "$TARBALL"
