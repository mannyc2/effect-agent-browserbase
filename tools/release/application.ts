import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { ReleaseError, createPlan, loadPlan, type Operation, type Plan } from "@mannyc1/ts-release";
import {
  File,
  encodeBundle,
  finalize,
  loadBundle,
  type AdoptionError,
  type ArtifactAccess,
  type Bundle,
  type Content,
  type ContentOwner,
} from "@mannyc1/ts-release/bundle";
import { sameData, type HttpProviderDefinition, type HttpRead } from "@mannyc1/ts-release/http";
import { fileContentOwner } from "@mannyc1/ts-release/node";
import * as Npm from "@mannyc1/ts-release-npm";
import { regularFile } from "../packages.mjs";
import { verifyReleaseSet } from "../verify-release.mjs";
import { repository, workflow } from "./config.js";

export { repository, workflow } from "./config.js";

export interface ReleasePackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly integrity: string;
}

/** The existing verifier admits exactly this complete, ordered release set. */
export interface ReleaseReceipt {
  readonly schemaVersion: 2;
  readonly repository: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly frameworkVersion: string;
  readonly distTag: string;
  readonly packages: readonly [ReleasePackage, ReleasePackage];
}

export interface PrepareInput {
  readonly directory: string;
  readonly sourceSha: string;
  readonly tag: string;
  readonly expectedDigest: string;
  readonly source: Npm.ProvenanceSource;
  readonly attest: Npm.Attest;
}

export interface PublicationDependencies {
  readonly read: HttpRead;
  readonly verifyProvenance: Npm.VerifyProvenance;
}

export interface PackageAuthorization {
  readonly authorization: Npm.TrustedAuthorization;
  readonly packageName: string;
}

export interface PreparedRelease {
  readonly bundle: Bundle;
  readonly plan: Plan;
  readonly metadata: Metadata;
  readonly access: ArtifactAccess;
  readonly authorizations: readonly PackageAuthorization[];
}

export interface LoadedRelease extends PreparedRelease {
  readonly providers: readonly HttpProviderDefinition[];
}

type PreparationError = ReleaseError | AdoptionError;

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));

export class Metadata extends Schema.Class<Metadata>("BrowserbaseRelease.Metadata")({
  format: Schema.Literal("browserbase-ts-release/1"),
  sourceSha: gitSha,
  tag: Schema.String,
  receiptDigest: sha256,
  bundleSha256: sha256,
  planId: sha256,
  source: Npm.ProvenanceSource,
}) {}

const failure = (message: string): ReleaseError =>
  new ReleaseError({ code: "browserbase-release", message });

const admit = <A>(body: () => A): Effect.Effect<A, ReleaseError> =>
  Effect.try({
    try: body,
    catch: (error) => failure(error instanceof Error ? error.message : "Release input is invalid"),
  });

const io = <A>(body: () => Promise<A>): Effect.Effect<A, ReleaseError> =>
  Effect.tryPromise({
    try: body,
    catch: () => failure("Retained release files could not be read or written"),
  });

const readRetainedFile = Effect.fn("browserbaseRelease.readRetainedFile")((path: string) =>
  io(async () => {
    regularFile(path);
    return readFile(path);
  }),
);

const writeRetainedFile = Effect.fn("browserbaseRelease.writeRetainedFile")(
  (path: string, bytes: string | Uint8Array) =>
    io(() => writeFile(path, bytes, { flag: "wx", mode: 0o600 })),
);
const provenanceName = (entry: ReleasePackage): string => `${entry.filename}.provenance.json`;
const producer = { name: "browserbase-release", version: "1" };

const ownedFile = (logicalName: string, content: Content): File =>
  new File({
    logicalName,
    content,
    deliveryMode: 0o644,
    executable: null,
    producedBy: producer,
  });
const accessFor = (bundle: Bundle, owner: ContentOwner): ArtifactAccess => ({
  bundle,
  readContent: (content) =>
    owner
      .read(content)
      .pipe(Effect.mapError(() => failure("Retained release content does not match its identity"))),
});

const verifyReceipt = (
  directory: string,
  sourceSha: string,
  tag: string,
  expectedDigest: string,
): ReleaseReceipt => verifyReleaseSet(directory, sourceSha, tag, expectedDigest);

export const verifyCandidate = Effect.fn("release.verifyCandidate")(
  (directory: string, sourceSha: string, tag: string, expectedDigest: string) =>
    admit(() => verifyReceipt(directory, sourceSha, tag, expectedDigest)),
);

const requireFile = (bundle: Bundle, logicalName: string): File => {
  const artifact = bundle.artifacts.find((candidate) => candidate.logicalName === logicalName);
  assert.ok(artifact?._tag === "OwnedFile", `Expected retained file ${logicalName}`);
  return artifact;
};

const checkSource = (raw: unknown, sourceSha: string, tag: string): Npm.ProvenanceSource => {
  const source = Schema.decodeUnknownSync(Npm.ProvenanceSource, { onExcessProperty: "error" })(raw);
  assert.equal(source.repository, repository);
  assert.equal(source.workflow, workflow);
  assert.equal(source.workflowRef, `refs/tags/${tag}`);
  assert.equal(source.sourceRef, `refs/tags/${tag}`);
  assert.equal(source.sourceCommit, sourceSha);
  assert.equal(source.eventName, "workflow_dispatch");
  assert.equal(source.runnerEnvironment, "github-hosted");
  return source;
};

const authorizePackage = (name: string, tag: string): Npm.TrustedAuthorization =>
  new Npm.TrustedAuthorization({
    principal: `npm:${name}`,
    repository,
    workflow,
    workflowRef: `refs/tags/${tag}`,
    issuer: "https://token.actions.githubusercontent.com",
    audience: "npm:registry.npmjs.org",
  });

const authorOperations = Effect.fn("browserbaseRelease.authorOperations")(function* (
  receipt: ReleaseReceipt,
  source: Npm.ProvenanceSource,
  bundle: Bundle,
  owner: ContentOwner,
) {
  const access = accessFor(bundle, owner);
  const operations: Operation[] = [];
  const authorizations: PackageAuthorization[] = [];
  for (const entry of receipt.packages) {
    const { tarball, provenance } = yield* admit(() => {
      const tarball = requireFile(bundle, entry.filename);
      const provenance = requireFile(bundle, provenanceName(entry));
      assert.equal(tarball.content.sha256, entry.sha256);
      assert.equal(tarball.content.bytes, entry.bytes);
      return { tarball, provenance };
    });
    const inspected = yield* Npm.inspectTarball(tarball, access);
    yield* admit(() => {
      assert.equal(inspected.name, entry.name);
      assert.equal(inspected.version, entry.version);
      assert.equal(inspected.integrity, entry.integrity);
      assert.equal(inspected.private, false);
    });
    const authorization = authorizePackage(entry.name, `v${receipt.version}`);
    const intent = new Npm.PublishIntent({
      registry: "https://registry.npmjs.org/",
      name: entry.name,
      version: entry.version,
      tarball,
      integrity: inspected.integrity,
      shasum: inspected.shasum,
      initialTag: receipt.distTag,
      access: "public",
      authorization,
      provenance: new Npm.GitHubActionsProvenance({
        source,
        bundle: provenance,
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      }),
    });
    // The adapter can dispatch only after the generic package is satisfied.
    const prerequisites = operations.map((operation) => operation.operationId);
    operations.push(yield* Npm.publish(intent, prerequisites));
    authorizations.push({ authorization, packageName: entry.name });
  }
  return { operations, authorizations, access };
});

/** Attest and retain an already-tested release set; never publish to npm. */
export const prepare = Effect.fn("browserbaseRelease.prepare")(function* ({
  directory,
  sourceSha,
  tag,
  expectedDigest,
  source: rawSource,
  attest,
}: PrepareInput): Effect.fn.Return<PreparedRelease, PreparationError> {
  const receipt = yield* admit(() => verifyReceipt(directory, sourceSha, tag, expectedDigest));
  const source = yield* admit(() => checkSource(rawSource, sourceSha, tag));
  const owner = fileContentOwner(join(directory, "content"));
  const receiptBytes = yield* readRetainedFile(join(directory, "release-set.json"));
  yield* admit(() => assert.equal(hash(receiptBytes), expectedDigest));
  const files = [ownedFile("release-set.json", yield* owner.putOwned(receiptBytes))];
  for (const entry of receipt.packages) {
    const content = yield* owner.putFileOwned({
      path: join(directory, entry.filename),
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
    files.push(ownedFile(entry.filename, content));
  }
  const tarballBundle = yield* finalize(files);
  const tarballAccess = accessFor(tarballBundle, owner);
  for (const entry of receipt.packages) {
    const tarball = yield* admit(() => requireFile(tarballBundle, entry.filename));
    const result = yield* Npm.createProvenance(
      {
        authorize: true,
        name: entry.name,
        version: entry.version,
        tarball,
        source,
      },
      { ...tarballAccess, attest },
    );
    files.push(ownedFile(provenanceName(entry), yield* owner.putOwned(result.bytes)));
  }
  const bundle = yield* finalize(files);
  const bundleBytes = encodeBundle(bundle);
  const { operations, authorizations, access } = yield* authorOperations(
    receipt,
    source,
    bundle,
    owner,
  );
  const plan = yield* createPlan(hash(bundleBytes), operations, `browserbase:${sourceSha}`);
  const metadata = new Metadata({
    format: "browserbase-ts-release/1",
    sourceSha,
    tag,
    receiptDigest: expectedDigest,
    bundleSha256: hash(bundleBytes),
    planId: plan.planId,
    source,
  });
  // Metadata is the completion marker. Existing preparation is never overwritten.
  yield* writeRetainedFile(join(directory, "bundle.json"), bundleBytes);
  yield* writeRetainedFile(join(directory, "plan.json"), JSON.stringify(plan));
  yield* writeRetainedFile(join(directory, "metadata.json"), JSON.stringify(metadata));
  return { bundle, plan, metadata, access, authorizations };
});

/** Admit the original retained Plan and every byte before constructing a live host. */
export const loadPrepared = Effect.fn("browserbaseRelease.loadPrepared")(function* (
  directory: string,
  sourceSha: string,
  tag: string,
  { read: readHttp, verifyProvenance }: PublicationDependencies,
): Effect.fn.Return<LoadedRelease, PreparationError> {
  const metadataBytes = yield* readRetainedFile(join(directory, "metadata.json"));
  const metadata = yield* admit(() =>
    Schema.decodeUnknownSync(Metadata, { onExcessProperty: "error" })(
      JSON.parse(metadataBytes.toString("utf8")),
    ),
  );
  const receipt = yield* admit(() => {
    assert.equal(metadata.sourceSha, sourceSha);
    assert.equal(metadata.tag, tag);
    checkSource(metadata.source, sourceSha, tag);
    return verifyReceipt(directory, sourceSha, tag, metadata.receiptDigest);
  });
  const owner = fileContentOwner(join(directory, "content"));
  const bundleBytes = yield* readRetainedFile(join(directory, "bundle.json"));
  yield* admit(() => assert.equal(hash(bundleBytes), metadata.bundleSha256));
  const bundle = yield* loadBundle(owner, bundleBytes);
  yield* admit(() => {
    assert.deepEqual(
      bundle.artifacts.map((file) => file.logicalName),
      [
        "release-set.json",
        ...receipt.packages.map((entry) => entry.filename),
        ...receipt.packages.map(provenanceName),
      ],
    );
    for (const file of bundle.artifacts) {
      assert.ok(file._tag === "OwnedFile");
      assert.ok(sameData(file, ownedFile(file.logicalName, file.content)));
    }
    assert.equal(requireFile(bundle, "release-set.json").content.sha256, metadata.receiptDigest);
  });
  const { operations, authorizations, access } = yield* authorOperations(
    receipt,
    metadata.source,
    bundle,
    owner,
  );
  const providers = Npm.definitions({ ...access, read: readHttp, verifyProvenance });
  const planBytes = yield* readRetainedFile(join(directory, "plan.json"));
  const plan = yield* loadPlan(
    yield* admit(() => JSON.parse(planBytes.toString("utf8"))),
    providers,
  );
  const expectedPlan = yield* createPlan(
    metadata.bundleSha256,
    operations,
    `browserbase:${sourceSha}`,
  );
  yield* admit(() => {
    assert.equal(plan.planId, metadata.planId);
    assert.ok(sameData(plan, expectedPlan), "Retained Plan differs from the exact release set");
  });
  // Native provider preparation checks statement/tarball correspondence and
  // signature trust without obtaining npm credentials or dispatching a write.
  for (const operation of operations) {
    const provider = yield* admit(() => {
      const selected = providers.find(
        (candidate) => candidate.definitionId === operation.definitionId,
      );
      assert.ok(selected, `Provider ${operation.definitionId} is unavailable`);
      return selected;
    });
    yield* provider.prepare(operation, {
      own: { operation, receipts: [], observations: [] },
      dependencies: operations
        .filter((candidate) => operation.dependsOn.includes(candidate.operationId))
        .map((dependency) => ({ operation: dependency, receipts: [], observations: [] })),
    });
  }
  return { bundle, plan, metadata, access, providers, authorizations };
});
