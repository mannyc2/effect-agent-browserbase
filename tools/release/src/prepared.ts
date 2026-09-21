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
import { distTag, packages, regularFile } from "../../packages.mjs";
import { verifyReleaseSet } from "../../verify-release.mjs";
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
  readonly access: ArtifactAccess;
  readonly authorizations: readonly PackageAuthorization[];
}

export interface LoadedRelease extends PreparedRelease {
  readonly providers: readonly HttpProviderDefinition[];
}

type PreparationError = ReleaseError | AdoptionError;

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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

/** Only the receipt, two canonical tarballs and their provenance enter this Bundle. */
const checkBundle = (bundle: Bundle, version: string): readonly string[] => {
  distTag(version);
  const filenames = packages.map(({ stem }) => `${stem}-${version}.tgz`);
  assert.deepEqual(
    bundle.artifacts.map((file) => file.logicalName),
    ["release-set.json", ...filenames, ...filenames.map((name) => `${name}.provenance.json`)],
  );
  for (const file of bundle.artifacts) {
    assert.ok(file._tag === "OwnedFile");
    assert.ok(sameData(file, ownedFile(file.logicalName, file.content)));
  }
  return filenames;
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
  // The native Plan is written last. Existing preparation is never overwritten.
  yield* writeRetainedFile(join(directory, "bundle.json"), bundleBytes);
  yield* writeRetainedFile(join(directory, "plan.json"), JSON.stringify(plan));
  return { bundle, plan, access, authorizations };
});

/** Persist native identities and their owned bytes, without another manifest. */
export const snapshotPrepared = Effect.fn("release.snapshotPrepared")(function* (
  prepared: PreparedRelease,
): Effect.fn.Return<ReadonlyMap<string, Uint8Array>, PreparationError> {
  const snapshot = new Map<string, Uint8Array>([
    ["bundle.json", encodeBundle(prepared.bundle)],
    ["plan.json", new TextEncoder().encode(JSON.stringify(prepared.plan))],
  ]);
  for (const artifact of prepared.bundle.artifacts) {
    const file = yield* admit(() => requireFile(prepared.bundle, artifact.logicalName));
    snapshot.set(file.content.sha256, yield* prepared.access.readContent(file.content));
  }
  return snapshot;
});

/** Restore bounded native content, then materialize only the verifier's fixed filenames. */
export const restorePrepared = Effect.fn("release.restorePrepared")(function* (
  directory: string,
  snapshot: ReadonlyMap<string, Uint8Array>,
): Effect.fn.Return<void, PreparationError> {
  const { bundleBytes, planBytes } = yield* admit(() => {
    const bundleBytes = snapshot.get("bundle.json");
    const planBytes = snapshot.get("plan.json");
    assert.ok(bundleBytes && planBytes, "Prepared state must contain a Bundle and Plan");
    assert.ok(snapshot.size <= 7, "Prepared state has unexpected files");
    return { bundleBytes, planBytes };
  });
  const owner = fileContentOwner(join(directory, "content"));
  for (const [name, bytes] of snapshot) {
    if (name === "bundle.json" || name === "plan.json") continue;
    yield* admit(() => assert.match(name, /^[a-f0-9]{64}$/u));
    const content = yield* owner.putOwned(bytes);
    yield* admit(() => assert.equal(content.sha256, name, "Prepared content digest differs"));
  }
  const bundle = yield* loadBundle(owner, bundleBytes);
  const receiptFile = yield* admit(() => requireFile(bundle, "release-set.json"));
  const receiptBytes = yield* owner.read(receiptFile.content);
  const filenames = yield* admit(() => {
    const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
      JSON.parse(new TextDecoder().decode(receiptBytes)),
    );
    const filenames = checkBundle(bundle, version);
    const contentNames = bundle.artifacts.map(
      (file) => requireFile(bundle, file.logicalName).content.sha256,
    );
    assert.deepEqual(
      [...snapshot.keys()].sort(),
      [...new Set(["bundle.json", "plan.json", ...contentNames])].sort(),
      "Prepared state must contain exactly the Bundle's owned content",
    );
    return filenames;
  });
  // Names come from this repository's package inventory and an admitted version.
  // Receipt metadata cannot supply an extraction path.
  for (const filename of ["release-set.json", ...filenames]) {
    const file = yield* admit(() => requireFile(bundle, filename));
    yield* writeRetainedFile(join(directory, filename), yield* owner.read(file.content));
  }
  yield* writeRetainedFile(join(directory, "bundle.json"), bundleBytes);
  yield* writeRetainedFile(join(directory, "plan.json"), planBytes);
});

/** Admit the original retained Plan and every byte before constructing a live host. */
export const loadPrepared = Effect.fn("browserbaseRelease.loadPrepared")(function* (
  directory: string,
  sourceSha: string,
  tag: string,
  { read: readHttp, verifyProvenance }: PublicationDependencies,
): Effect.fn.Return<LoadedRelease, PreparationError> {
  const owner = fileContentOwner(join(directory, "content"));
  const bundleBytes = yield* readRetainedFile(join(directory, "bundle.json"));
  const bundle = yield* loadBundle(owner, bundleBytes);
  const receipt = yield* admit(() => {
    const receiptFile = requireFile(bundle, "release-set.json");
    const receipt = verifyReceipt(directory, sourceSha, tag, receiptFile.content.sha256);
    checkBundle(bundle, receipt.version);
    return receipt;
  });
  const access = accessFor(bundle, owner);
  const providers = Npm.definitions({ ...access, read: readHttp, verifyProvenance });
  const planBytes = yield* readRetainedFile(join(directory, "plan.json"));
  const plan = yield* loadPlan(
    yield* admit(() => JSON.parse(planBytes.toString("utf8"))),
    providers,
  );
  const source = yield* admit(() => {
    const generic = plan.operations
      .filter((operation) => operation.definitionId === "npm.publish")
      .map((operation) => Schema.decodeUnknownSync(Npm.PublishIntent)(operation.intent))
      .find((intent) => intent.name === receipt.packages[0].name);
    assert.ok(generic?.provenance._tag === "GitHubActionsProvenance");
    return checkSource(generic.provenance.source, sourceSha, tag);
  });
  const { operations, authorizations } = yield* authorOperations(receipt, source, bundle, owner);
  const expectedPlan = yield* createPlan(hash(bundleBytes), operations, `browserbase:${sourceSha}`);
  yield* admit(() => {
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
  return { bundle, plan, access, providers, authorizations };
});
