import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect, Schema, type Redacted } from "effect";
import { ReleaseError } from "@mannyc1/ts-release";
import type { CredentialBinding } from "@mannyc1/ts-release/http";
import {
  makeGithubTrustedPublisherHost,
  makeHttpRead,
  makeHttpTransport,
  openGitJournal,
  runApplication,
  runInterruptibleProcess,
} from "@mannyc1/ts-release/node";
import * as Npm from "@mannyc1/ts-release-npm";
import { loadPrepared, prepare, verifyCandidate } from "./application.js";
import {
  hostIdentity,
  httpBounds,
  provenanceSource,
  releaseNodeVersion,
  remote,
  ReleaseInput,
} from "./config.js";
import { persistState, restoreState } from "./state.js";

export { checkHost } from "./config.js";

const require = createRequire(import.meta.url);

function fileOperation<A>(operation: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: () => new ReleaseError({ code: "release-files", message: `Could not ${operation}` }),
  });
}

/** Use the frozen dependency's trust seed, never a root supplied by release data. */
const prepareTrust = Effect.fn("release.prepareTrust")(function* (cacheDirectory: string) {
  const rootPath = join(cacheDirectory, "sigstore-root.json");
  yield* fileOperation("initialize Sigstore trust", async () => {
    const seeds = JSON.parse(await readFile(require.resolve("@sigstore/tuf/seeds.json"), "utf8"));
    const root = Buffer.from(seeds["https://tuf-repo-cdn.sigstore.dev"]["root.json"], "base64");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(rootPath, root);
  });
  return {
    tufRootPath: rootPath,
    tufCachePath: join(cacheDirectory, "tuf"),
    timeoutMilliseconds: 30_000,
  } satisfies Npm.SigstoreTrustOptions;
});

const retainPrepared = Effect.fn("release.retainPrepared")(function* (
  input: ReleaseInput,
  token: Redacted.Redacted<string>,
  source: Npm.ProvenanceSource,
  trust: Npm.SigstoreTrustOptions,
) {
  const state = {
    remote,
    ref: `refs/heads/ts-release-prepared/${input.sourceSha}`,
    directory: input.directory,
    token,
  };
  if (yield* restoreState(state)) return;
  if (!input.authorize) {
    return yield* new ReleaseError({
      code: "release-unprepared",
      message: "No retained release exists to observe",
    });
  }

  const receipt = yield* verifyCandidate(
    input.artifacts,
    input.sourceSha,
    input.tag,
    input.expectedDigest,
  );
  yield* fileOperation("stage the tested release set", async () => {
    const filenames = ["release-set.json", ...receipt.packages.map((entry) => entry.filename)];
    for (const filename of filenames) {
      await cp(join(input.artifacts, filename), join(input.directory, filename), {
        errorOnExist: true,
        force: false,
      });
    }
  });

  const publisher = makeGithubTrustedPublisherHost(httpBounds);
  const attest = Npm.makeSigstoreAttester({
    ...trust,
    source,
    oidc: publisher.oidc,
    fulcioUrl: "https://fulcio.sigstore.dev",
    rekorUrl: "https://rekor.sigstore.dev",
  });
  yield* prepare({
    directory: input.directory,
    sourceSha: input.sourceSha,
    tag: input.tag,
    expectedDigest: input.expectedDigest,
    source,
    attest,
  });
  // Publication cannot begin until the complete original preparation is durable.
  yield* persistState(state);
});

/** The runtime boundary: admit identity, restore content, then compose the native host. */
export const createApplication = Effect.fn("release.createApplication")(function* (
  raw: ReleaseInput,
) {
  const identity = yield* hostIdentity(raw.sourceSha, raw.tag);
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const input = yield* Schema.decodeUnknownEffect(ReleaseInput)(raw);
  const trust = yield* prepareTrust(input.cacheDirectory);
  yield* retainPrepared(input, token, provenanceSource(identity, input), trust);

  const prepared = yield* loadPrepared(input.directory, input.sourceSha, input.tag, {
    read: makeHttpRead({ ...httpBounds, credentials: () => Effect.succeed({}) }),
    verifyProvenance: Npm.makeSigstoreVerifier(trust),
  });
  const publisher = makeGithubTrustedPublisherHost(httpBounds);
  const credentials = Effect.fn("release.npmCredential")(function* (binding: CredentialBinding) {
    const selected = prepared.authorizations.find(
      ({ authorization }) => authorization.principal === binding.principal,
    );
    if (!selected) {
      return yield* new ReleaseError({
        code: "release-principal",
        message: "Unknown npm publication principal",
      });
    }
    return yield* Npm.authorizeTrusted({ ...selected, binding }, publisher);
  });
  const store = yield* openGitJournal({
    cacheDirectory: join(input.cacheDirectory, "journal"),
    remote,
    principal: "browserbase-release-journal",
    scope: `browserbase:${input.sourceSha}`,
    gitExecutable: "/usr/bin/git",
    timeoutMilliseconds: 30_000,
    maximumOutputBytes: 16 * 1024 * 1024,
    credentials: () =>
      Effect.succeed({ _tag: "Basic", username: "x-access-token", password: token }),
  });
  return {
    bundle: prepared.bundle,
    options: { plan: prepared.plan, authorize: input.authorize },
    host: {
      store,
      providers: prepared.providers,
      transport: makeHttpTransport({ ...httpBounds, providers: prepared.providers, credentials }),
      now: Date.now,
      uniqueId: randomUUID,
    },
  };
});

async function main() {
  const [artifacts, sourceSha, tag, expectedDigest, mode] = process.argv.slice(2);
  assert.ok(
    artifacts &&
      sourceSha &&
      tag &&
      expectedDigest &&
      mode &&
      ["--check", "--publish", "--observe"].includes(mode),
    "Usage: node main.js ARTIFACTS SOURCE_SHA TAG RELEASE_SET_SHA256 --check|--publish|--observe",
  );
  assert.equal(
    process.versions.node,
    releaseNodeVersion,
    `Use release runtime Node ${releaseNodeVersion}`,
  );
  await Effect.runPromise(verifyCandidate(resolve(artifacts), sourceSha, tag, expectedDigest));
  if (mode === "--check") return;

  const cacheDirectory = await mkdtemp(join(tmpdir(), "browserbase-publisher-"));
  const input = new ReleaseInput({
    artifacts: resolve(artifacts),
    sourceSha,
    tag,
    expectedDigest,
    cacheDirectory,
    directory: join(cacheDirectory, "prepared"),
    authorize: mode === "--publish",
  });
  await runInterruptibleProcess(async (signal, interruptionCode) => {
    try {
      const report = await runApplication(
        fileURLToPath(import.meta.url),
        input,
        signal,
        mode === "--observe" ? "observe" : "run",
      );
      const json = JSON.stringify(report, null, 2) + "\n";
      await writeFile(join(input.artifacts, "publication-report.json"), json);
      process.stdout.write(json);
      if (report.operations.some((operation) => operation.status !== "Satisfied"))
        process.exitCode = 2;
    } finally {
      if (interruptionCode()) process.exitCode = interruptionCode();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release application failed"}\n`,
    );
    process.stderr.write("Retain the prepared ref and journal; inspect them before continuing.\n");
    process.exitCode ||= 1;
  });
}
