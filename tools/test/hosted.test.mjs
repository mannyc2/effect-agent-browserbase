import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("the only paid workflow is manual, opt-in gated and credential-isolated", () => {
  const workflow = read(".github/workflows/hosted.yml");
  const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:\n"));

  // Secrets must never reach a trigger that unreviewed code can influence.
  assert.doesNotMatch(triggers, /pull_request|pull_request_target|schedule|push:/);
  assert.ok(triggers.includes("workflow_dispatch:"));
  assert.doesNotMatch(workflow, /id-token: write|contents: write|git push/);

  const live = workflow.slice(workflow.indexOf("\n  live:\n"));
  assert.ok(live.includes("environment: browserbase-live"));
  assert.equal((workflow.match(/environment:/g) ?? []).length, 1);
  assert.ok(workflow.includes("BROWSERBASE_LIVE_ENABLED"));
  assert.ok(workflow.includes("cancel-in-progress: false"));

  // Every secret reference belongs to the protected job, not the gate job.
  const resolve = workflow.slice(workflow.indexOf("\n  resolve:\n"), workflow.indexOf("\n  live:\n"));
  assert.doesNotMatch(resolve, /secrets\./);
  for (const reference of live.match(/secrets\.[A-Z_]+/g) ?? []) {
    assert.match(reference, /^secrets\.BROWSERBASE_(API_KEY|PROJECT_ID|ARTIFACT_ORIGINS)$/);
  }
  assert.ok((live.match(/secrets\./g) ?? []).length > 0);
});

test("both hosted commands refuse to allocate without an explicit operator opt-in", () => {
  for (const name of ["tools/hosted-acceptance.sh", "tools/hosted-demo.sh"]) {
    const script = read(name);
    assert.ok(script.includes('test "${EFFECT_AGENT_BROWSERBASE_LIVE:-}" = 1 ||'), name);
    assert.ok(script.includes('exit 2'), name);
    assert.ok(script.includes(': "${BROWSERBASE_API_KEY:?'), name);
    assert.ok(script.includes(': "${BROWSERBASE_PROJECT_ID:?'), name);
  }
  // A recording published as documentation must not silently become the
  // provider-artifact acceptance run, which needs approved delivery origins.
  assert.ok(read("tools/hosted-acceptance.sh").includes('BROWSERBASE_ARTIFACT_ORIGINS:?'));
  assert.doesNotMatch(read("tools/hosted-demo.sh"), /BROWSERBASE_ARTIFACT_ORIGINS/);
  // Neither one may be reachable from the unpaid gate.
  assert.doesNotMatch(read("tools/run-acceptance.sh"), /hosted-demo\.sh|hosted-acceptance\.sh/);
});

test("the demo example encodes its own frames instead of retrieving provider media", () => {
  const example = read("packages/browserbase/examples/hosted-demo.ts");
  assert.ok(example.includes("recordSession: false"));
  assert.doesNotMatch(example, /artifactOrigins|BrowserbaseRecordings|BrowserbaseReplays|BrowserbaseDownloads/);
  assert.ok(example.includes('process.env.EFFECT_AGENT_BROWSERBASE_LIVE !== "1"'));
  // A published recording shows a host-configured destination, never one a page
  // or a model chose.
  assert.ok(example.includes('url.protocol !== "https:"'));
});

test("committed documentation media stays inside its declared commit budget", () => {
  const budget = JSON.parse(read("docs/media/budget.json"));
  const directory = join(root, "docs/media");

  assert.ok(existsSync(directory), "docs/media holds the committed demo recording and its rules");
  const names = readdirSync(directory);

  assert.ok(names.length <= budget.maxFiles, `docs/media holds ${names.length} files`);
  for (const name of names) {
    const extension = extname(name);

    assert.ok(budget.allowedExtensions.includes(extension), `Unexpected media file: ${name}`);
    const bytes = statSync(join(directory, name)).size;

    if (extension === ".gif") assert.ok(bytes <= budget.maxGifBytes, `${name} is ${bytes} bytes`);
    if (extension === ".mp4") assert.ok(bytes <= budget.maxMp4Bytes, `${name} is ${bytes} bytes`);
  }
});

test("media referenced by a README is actually committed", () => {
  const referenced = new Set();

  for (const page of ["README.md", "docs/media/README.md", "docs/HOSTED.md"]) {
    // Fenced blocks document the snippet to paste once the media exists; only a
    // live reference in prose has to resolve.
    const prose = read(page).replace(/```[\s\S]*?```/g, "");

    for (const match of prose.matchAll(/docs\/media\/([A-Za-z0-9._-]+\.(?:gif|mp4))/g)) {
      referenced.add(match[1]);
    }
  }
  for (const name of referenced) {
    assert.ok(existsSync(join(root, "docs/media", name)), `README references missing media: ${name}`);
  }
});


test("hosted execution pins reviewed main and still requires external environment protection", () => {
  const workflow = read(".github/workflows/hosted.yml");
  const resolve = workflow.slice(workflow.indexOf("\n  resolve:\n"), workflow.indexOf("\n  live:\n"));
  const live = workflow.slice(workflow.indexOf("\n  live:\n"));

  for (const job of [resolve, live]) {
    assert.ok(job.includes("github.ref == 'refs/heads/main'"));
    assert.ok(job.includes("github.event_name == 'workflow_dispatch'"));
  }
  assert.ok(live.includes("ref: ${{ github.sha }}"));
  assert.ok(live.includes("persist-credentials: false"));
  assert.ok(read("docs/HOSTED.md").includes("branch-restricted protected environment"));
});
