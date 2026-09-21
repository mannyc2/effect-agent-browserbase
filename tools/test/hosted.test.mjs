import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadRegistry, select, verify } from "../hosted-registry.mjs";

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

test("the hosted runner refuses to allocate without an explicit operator opt-in", () => {
  const script = read("tools/hosted-run.sh");

  assert.ok(script.includes('test "${EFFECT_AGENT_BROWSERBASE_LIVE:-}" = 1 ||'));
  assert.ok(script.includes("exit 2"));
  assert.ok(script.includes(': "${BROWSERBASE_API_KEY:?'));
  assert.ok(script.includes(': "${BROWSERBASE_PROJECT_ID:?'));
  // Every name is validated against the registry before the first check runs.
  assert.ok(script.indexOf("hosted-registry.mjs\" select") < script.indexOf("vp exec bun"));
  // A check that needs an operator reads the terminal, so the plan must not occupy stdin.
  assert.ok(script.includes("read -r check media <&3") && script.includes('done 3<<< "$PLAN"'));
  // Nothing hosted may be reachable from the unpaid gate.
  assert.doesNotMatch(read("tools/run-acceptance.sh"), /hosted-run\.sh|hosted-registry|examples\/hosted/);
});

const hostedDirectory = "packages/browserbase/examples/hosted";
const registry = await loadRegistry(join(root, hostedDirectory, "checks.ts"));
const knownSettings = new Set(["BROWSERBASE_ARTIFACT_ORIGINS"]);

test("every registered check is a case that passes through the one gate", () => {
  const files = readdirSync(join(root, hostedDirectory)).filter((name) => name.endsWith(".ts"));
  const cases = files.filter((name) => name !== "harness.ts" && name !== "checks.ts");

  assert.deepEqual(cases.map((name) => name.slice(0, -3)).sort(), Object.keys(registry.checks).sort());
  for (const name of Object.keys(registry.checks)) {
    const source = read(`${hostedDirectory}/${name}.ts`);

    assert.ok(source.includes(`hostedCase(${JSON.stringify(name)})`), name);
    // Credentials, settings and allocation come from the harness, never from a case itself.
    assert.doesNotMatch(source, /process\.env|BrowserbaseClient|account\.layer|Account\.layer/, name);
    assert.doesNotMatch(source, /\)\.open\(|\.acquire\(|\.attach\(/, name);
    assert.ok(source.includes("await h.run("), name);
  }
});

test("every registered check stays inside the ceiling and declares what it supports", () => {
  const { ceiling, checks } = registry;
  const headings = new Set(
    read("docs/STATUS.md")
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")),
  );

  for (const [name, check] of Object.entries(checks)) {
    for (const [key, limit] of Object.entries(ceiling)) {
      assert.ok(Number.isSafeInteger(check.budget[key]) && check.budget[key] >= 0, `${name} ${key}`);
      assert.ok(check.budget[key] <= limit, `${name} exceeds the ${key} ceiling`);
    }
    assert.ok(check.budget.sessions >= 1, name);
    assert.ok(check.claim.length > 0, name);
    for (const key of check.env) assert.ok(knownSettings.has(key), `${name} requires ${key}`);
    // A recorded claim must point at the run record that established it.
    if (check.evidence !== null) {
      const [page, anchor] = check.evidence.split("#");

      assert.equal(page, "docs/STATUS.md", name);
      assert.ok(headings.has(anchor), `${name} cites a missing record: ${anchor}`);
    }
  }
  // Provider media is only ever fetched through origins an operator approved.
  for (const [name, check] of Object.entries(checks)) {
    const source = read(`${hostedDirectory}/${name}.ts`);

    if (/BrowserbaseRecordings|BrowserbaseReplays|BrowserbaseDownloads/.test(source)) {
      assert.ok(check.env.includes("BROWSERBASE_ARTIFACT_ORIGINS"), name);
    }
  }
});

test("the registry refuses unknown, duplicate, unconfigured and unattended checks", () => {
  const env = { BROWSERBASE_ARTIFACT_ORIGINS: "https://example.test" };

  assert.deepEqual(
    select(registry, ["acceptance", "demo"], env).map((item) => [item.name, item.media]),
    [["acceptance", false], ["demo", true]],
  );
  assert.throws(() => select(registry, [], env), /at least one/);
  assert.throws(() => select(registry, ["demo", "demo"], env), /twice/);
  assert.throws(() => select(registry, ["toString"], env), /Unknown hosted check/);
  assert.throws(() => select(registry, ["acceptance"], {}), /BROWSERBASE_ARTIFACT_ORIGINS/);
  assert.throws(() => select(registry, ["handoff"], { CI: "true" }), /never runs in CI/);
  const inflated = { ...registry, checks: { demo: { ...registry.checks.demo, budget: { ...registry.checks.demo.budget, sessions: 9 } } } };

  assert.throws(() => select(inflated, ["demo"], {}), /sessions ceiling/);
});

test("a hosted record fails when it overspent or never completed", () => {
  const line = (phase) => JSON.stringify({ check: "demo", phase, result: null });

  assert.deepEqual(verify(registry, "demo", [line("allocated"), line("complete")].join("\n")), {
    name: "demo",
    allocated: 1,
  });
  assert.throws(
    () => verify(registry, "demo", [line("allocated"), line("allocated"), line("complete")].join("\n")),
    /allocated 2 of 1/,
  );
  assert.throws(() => verify(registry, "demo", [line("allocated"), line("failure")].join("\n")), /did not complete/);
});

test("the demo check encodes its own frames instead of retrieving provider media", () => {
  const example = read(`${hostedDirectory}/demo.ts`);

  assert.ok(example.includes("recordSession: false"));
  assert.doesNotMatch(example, /artifactOrigins|BrowserbaseRecordings|BrowserbaseReplays|BrowserbaseDownloads/);
  assert.deepEqual(registry.checks.demo.env, []);
  // A published recording shows a host-configured destination, never one a page or a model chose.
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
