import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Host, ReleaseError, runRelease } from "@mannyc1/ts-release";
import { openGitJournal } from "@mannyc1/ts-release/node";
import { ProvenanceSource } from "@mannyc1/ts-release-npm";
import { packageReleaseSet, publicationManifest, releaseSetDigest } from "../package-release.mjs";
import { packages } from "../packages.mjs";
import { loadPrepared, prepare } from "./application.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sourceSha = "1234567890abcdef1234567890abcdef12345678";
const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const json = (value) => new TextEncoder().encode(JSON.stringify(value));
const response = (status, body = {}) => ({ status, headers: {}, body: json(body) });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));

// The signature/trust ports below are offline structural fixtures, not evidence
// of a real OIDC exchange or valid Sigstore signature. Native npm statement,
// tarball, request, observation and journal validation all remain real.
function structuralBundle(payload) {
  return json({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(payload).toString("base64"),
      signatures: [{ sig: "AA==" }],
    },
    verificationMaterial: {
      certificate: { rawBytes: "AA==" },
      tlogEntries: [
        {
          canonicalizedBody: "AA==",
          logId: { keyId: "AA==" },
          integratedTime: "1",
          logIndex: "0",
          kindVersion: { kind: "dsse", version: "0.0.1" },
          inclusionProof: {
            logIndex: "0",
            treeSize: "1",
            hashes: [],
            rootHash: Buffer.alloc(32).toString("base64"),
            checkpoint: {
              envelope: `untrusted-fixture\n1\n${Buffer.alloc(32).toString("base64")}\n\n`,
            },
          },
        },
      ],
    },
  });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "browserbase-native-release-"));
  temporaryDirectories.push(directory);
  const tree = join(directory, "tree");
  const out = join(directory, "output");
  mkdirSync(join(tree, "packages/effect-agent"), { recursive: true });
  mkdirSync(out);
  const sources = packages.map((item) => readJson(join(root, item.directory, "package.json")));
  const version = sources[0].version;
  const tag = `v${version}`;
  const versions = { [packages[0].name]: version, "effect-agent": version };
  writeJson(join(tree, "package.json"), { catalog: {} });
  writeJson(join(tree, "packages/effect-agent/package.json"), { version });
  for (const [index, item] of packages.entries()) {
    const pkg = join(tree, item.directory);
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeJson(join(pkg, "package.json"), sources[index]);
    writeFileSync(join(pkg, "README.md"), "# Offline release fixture\n");
    cpSync(join(root, "LICENSE"), join(pkg, "LICENSE"));
    const manifest = publicationManifest(sources[index], {}, versions);
    for (const path of Object.values(manifest.exports).flatMap(Object.values)) {
      const target = join(pkg, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "export {};\n");
    }
  }
  const receipt = packageReleaseSet(tree, out, sourceSha);
  const source = new ProvenanceSource({
    format: "npm-github-actions-provenance-source/v1",
    serverUrl: "https://github.com",
    repository: "mannyc2/effect-agent-browserbase",
    workflow: ".github/workflows/publish.yml",
    workflowRef: `refs/tags/${tag}`,
    sourceRef: `refs/tags/${tag}`,
    sourceCommit: sourceSha,
    eventName: "workflow_dispatch",
    repositoryId: "1",
    repositoryOwnerId: "2",
    runnerEnvironment: "github-hosted",
    runId: "3",
    runAttempt: "1",
    repositoryVisibility: "public",
  });
  const options = {
    directory: out,
    sourceSha,
    tag,
    expectedDigest: releaseSetDigest(out),
    source,
    attest: ({ payload }) => Effect.succeed({ bundleBytes: structuralBundle(payload) }),
  };
  const dependencies = {
    read: () => Effect.succeed(response(404)),
    verifyProvenance: () => Effect.void,
  };
  return { directory, out, receipt, tag, source, options, dependencies };
}

test("preparation adopts both tested tarballs into a native trusted-publishing dependency plan", async () => {
  const f = fixture();
  const prepared = await Effect.runPromise(prepare(f.options));
  assert.equal(prepared.plan.operations.length, 2);
  const byName = new Map(
    prepared.plan.operations.map((operation) => [operation.intent.name, operation]),
  );
  const generic = byName.get(packages[0].name);
  const adapter = byName.get(packages[1].name);
  assert.deepEqual(generic.dependsOn, []);
  assert.deepEqual(adapter.dependsOn, [generic.operationId]);
  for (const operation of byName.values()) {
    assert.equal(operation.intent.authorization._tag, "TrustedAuthorization");
    assert.equal(operation.intent.provenance._tag, "GitHubActionsProvenance");
    assert.equal(operation.intent.provenance.source.sourceCommit, sourceSha);
    assert.equal(operation.intent.authorization.workflow, ".github/workflows/publish.yml");
  }
  let verifications = 0;
  const loaded = await Effect.runPromise(
    loadPrepared(f.out, sourceSha, f.tag, {
      ...f.dependencies,
      verifyProvenance: ({ source, bundleBytes }) =>
        Effect.sync(() => {
          assert.deepEqual(source, f.source);
          assert.ok(JSON.parse(new TextDecoder().decode(bundleBytes)).dsseEnvelope);
          verifications++;
        }),
    }),
  );
  assert.equal(loaded.plan.planId, prepared.plan.planId);
  assert.equal(verifications, 2);
});

test("a corrupt complete-set receipt fails before requesting either attestation", async () => {
  const f = fixture();
  writeJson(join(f.out, "release-set.json"), { ...f.receipt, packages: [f.receipt.packages[0]] });
  let attestations = 0;
  await assert.rejects(
    Effect.runPromise(
      prepare({
        ...f.options,
        expectedDigest: releaseSetDigest(f.out),
        attest: () => {
          attestations++;
          return Effect.die("must not attest an incomplete set");
        },
      }),
    ),
  );
  assert.equal(attestations, 0);
});

test("reloading refuses altered source, receipt, bundle content, plan edges and untrusted provenance", async () => {
  const f = fixture();
  const prepared = await Effect.runPromise(prepare(f.options));
  const load = (dependencies = f.dependencies) =>
    Effect.runPromise(loadPrepared(f.out, sourceSha, f.tag, dependencies));
  await assert.rejects(
    Effect.runPromise(loadPrepared(f.out, "f".repeat(40), f.tag, f.dependencies)),
  );
  await assert.rejects(
    load({
      ...f.dependencies,
      verifyProvenance: () =>
        Effect.fail(
          new ReleaseError({ code: "fixture-untrusted", message: "Signature trust rejected" }),
        ),
    }),
    /Signature trust rejected/,
  );
  const receiptPath = join(f.out, "release-set.json");
  const originalReceipt = readFileSync(receiptPath);
  writeJson(receiptPath, { ...f.receipt, packages: [f.receipt.packages[0]] });
  await assert.rejects(load());
  writeFileSync(receiptPath, originalReceipt);
  const planPath = join(f.out, "plan.json");
  const originalPlan = readFileSync(planPath);
  const plan = readJson(planPath);
  plan.operations.find((operation) => operation.intent.name === packages[1].name).dependsOn = [];
  writeJson(planPath, plan);
  await assert.rejects(load());
  writeFileSync(planPath, originalPlan);
  const file = prepared.plan.operations[0].intent.tarball;
  const content = await Effect.runPromise(prepared.access.readContent(file.content));
  const corrupted = content.slice();
  corrupted[corrupted.length - 1] ^= 1;
  const contentPath = join(f.out, "content", file.content.sha256);
  chmodSync(contentPath, 0o600);
  writeFileSync(contentPath, corrupted);
  await assert.rejects(load());
});

test("an uncertain native npm PUT stays fenced after reopening the Git journal; exact observation releases its dependent", async () => {
  const f = fixture();
  await Effect.runPromise(prepare(f.options));
  const remote = join(f.directory, "journal.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const observed = new Map();
  const sends = [];
  let attempt = 0;
  async function run(acknowledge = false) {
    const cacheDirectory = join(f.directory, `cache-${++attempt}`);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const loaded = yield* loadPrepared(f.out, sourceSha, f.tag, {
            ...f.dependencies,
            read: ({ url }) => {
              const name = decodeURIComponent(new URL(url).pathname.slice(1));
              return Effect.succeed(observed.get(name) ?? response(404));
            },
          });
          const store = yield* openGitJournal({
            cacheDirectory,
            remote: pathToFileURL(remote).href,
            principal: "offline-test",
            scope: "release",
            gitExecutable: Bun.which("git"),
            timeoutMilliseconds: 5000,
            maximumOutputBytes: 4 * 1024 * 1024,
            credentials: () => Effect.succeed({ _tag: "Anonymous" }),
          });
          const host = {
            providers: loaded.providers,
            store,
            now: Date.now,
            uniqueId: randomUUID,
            transport: {
              send: (request) =>
                Effect.gen(function* () {
                  const before = yield* store.read(loaded.plan.journalId);
                  assert.equal(before.events.at(-1).body._tag, "DispatchStarted");
                  const document = JSON.parse(new TextDecoder().decode(request.body));
                  sends.push(document.name);
                  assert.equal(request.facts.method, "PUT");
                  assert.equal(request.facts.replay._tag, "None");
                  const provider = loaded.providers.find((candidate) =>
                    candidate.ownsRequest(request),
                  );
                  assert.ok(provider, "native npm must own every dispatched request");
                  if (!acknowledge)
                    return { _tag: "Unknown", reason: "fixture lost response after write" };
                  return yield* provider.decodeResponse(
                    request,
                    response(201, { token: "do-not-retain" }),
                  );
                }),
            },
          };
          const report = yield* runRelease({ plan: loaded.plan, authorize: true }).pipe(
            Effect.provide(Layer.succeed(Host, host)),
          );
          const journal = yield* store.read(loaded.plan.journalId);
          return { report, journal, plan: loaded.plan };
        }),
      ),
    );
  }
  const first = await run();
  assert.deepEqual(sends, [packages[0].name]);
  assert.ok(first.report.operations.every((operation) => operation.status !== "Satisfied"));
  const absent = await run();
  assert.deepEqual(
    sends,
    [packages[0].name],
    "a fresh runner must not resend after a 404 observation",
  );
  assert.equal(
    absent.journal.events.filter((event) => event.body._tag === "DispatchStarted").length,
    1,
  );
  const genericOperation = first.plan.operations.find(
    (operation) => operation.intent.name === packages[0].name,
  );
  const publication = genericOperation.intent;
  const metadata = {
    name: publication.name,
    versions: {
      [publication.version]: {
        name: publication.name,
        version: publication.version,
        dist: { integrity: publication.integrity, shasum: publication.shasum },
      },
    },
    "dist-tags": { [publication.initialTag]: publication.version },
  };
  const wrong = structuredClone(metadata);
  wrong.versions[publication.version].dist.integrity =
    `sha512-${Buffer.alloc(64).toString("base64")}`;
  observed.set(publication.name, response(200, wrong));
  const conflict = await run();
  const conflictingOperation = conflict.report.operations.find(
    (operation) => operation.operationId === genericOperation.operationId,
  );
  assert.equal(conflictingOperation.status, "Conflict");
  assert.deepEqual(sends, [packages[0].name], "different bytes cannot unlock the dependent");
  observed.set(publication.name, response(200, metadata));
  const complete = await run(true);
  assert.deepEqual(
    sends,
    packages.map((item) => item.name),
  );
  assert.ok(complete.report.operations.every((operation) => operation.status === "Satisfied"));
  assert.equal(
    complete.journal.events.filter((event) => event.body._tag === "DispatchStarted").length,
    2,
  );
  assert.ok(!JSON.stringify(complete.journal).includes("do-not-retain"));
}, 30_000);
