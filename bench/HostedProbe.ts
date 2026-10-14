/** Private evidence and one-session admission for the H1/H3 experiments; no autonomous retries. */
import {
  Cause,
  Clock,
  Console,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import { BrowserError } from "effect-browser/BrowserError";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as Client from "effect-browserbase/BrowserbaseClient";
import { BrowserbaseError, InvalidRequest } from "effect-browserbase/BrowserbaseError";
import * as ContextLease from "effect-browserbase/ContextLease";
import { FetchHttpClient } from "effect/http";

import { BenchError, optedIn, refuse } from "./Budget.ts";
import * as Handover from "./HandoverProbe.ts";
import { revision } from "./Trial.ts";

const privateFile = () =>
  new BenchError({ message: "Could not read or write private probe evidence" });

/** This is still owner-supplied dashboard evidence, never independent verification of billing. */
export const prepare = Effect.fnUntraced(function* (kind: "h1" | "h3", allowanceFile: string) {
  if (!(yield* optedIn("EFFECT_BROWSER_BENCH_HOSTED")))
    return yield* refuse(
      "Set EFFECT_BROWSER_BENCH_HOSTED=1 only after verifying included allowance and disabled overage",
    );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const allowance = yield* fs.readFileString(allowanceFile).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.flatMap(Handover.validateAllowance),
    Effect.mapError(
      () =>
        new BenchError({
          message:
            "Probe needs ten included minutes verified within the last hour; see docs/HOSTED_CHECKS.md",
        }),
    ),
  );

  const source = yield* revision;

  if (source.commit === null || source.dirty !== false)
    return yield* refuse("Hosted probes require a clean tested commit");

  const verification = yield* fs
    .readFile(allowance.verificationFile)
    .pipe(Effect.mapError(privateFile));

  if (verification.length === 0)
    return yield* refuse("Retain nonempty private dashboard verification evidence before running");
  const hash = yield* crypto.digest("SHA-256", verification);
  const runId = yield* crypto.randomUUIDv4();
  const directory = path.join(import.meta.dirname, "..", ".work", kind, runId);
  const versions: Record<string, string> = {};

  for (const name of ["browser", "browserbase", "agent-browser", "human-strokes"]) {
    const manifest = yield* fs
      .readFileString(path.join(import.meta.dirname, "..", "packages", name, "package.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
          ),
        ),
        Effect.mapError(privateFile),
      );

    versions[manifest.name] = manifest.version;
  }
  yield* fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(privateFile));

  const write = (name: string, value: unknown) =>
    fs
      .writeFileString(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(Effect.mapError(privateFile));

  const { verificationFile: _, ...verified } = allowance;

  const setup = {
    runId,
    kind,
    source,
    versions,
    allowance: { ...verified, verificationSha256: Buffer.from(hash).toString("hex") },
    usageDeltaMinutes: null,
  };

  yield* write("started.json", setup);

  return { runId, directory, setup, write };
});

export type Evidence = Effect.Success<ReturnType<typeof prepare>>;

/** Reuse H2's sanitized observer, but close admission permanently after one create attempt. */
export const single = (source: Client.Service, now: () => number) => {
  const observed = Handover.admission(source, now);
  let attempted = false;

  const client: Client.Service = {
    ...observed.client,
    createSession: (options) =>
      Effect.suspend(() => {
        if (attempted)
          return Effect.fail(
            new BrowserbaseError({
              operation: "createSession",
              reason: new InvalidRequest({ detail: "This probe admits only one session attempt" }),
            }),
          );
        attempted = true;

        return observed.client.createSession(options);
      }),
  };

  return { ...observed, client };
};

/** Run once, write outcome after cleanup, preserve failures, and retain only closed error tags. */
export const run = Effect.fnUntraced(function* <A, E, R>(
  evidence: Evidence,
  seconds: 300 | 420,
  work: (hosted: Browserbase.Hosted) => Effect.Effect<A, E, R>,
  report: () => unknown,
) {
  const clock = yield* Clock.Clock;

  const observed = single(
    yield* Client.BrowserbaseClient,
    () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6,
  );

  let release: "Settled" | "Unconfirmed" | undefined;

  yield* Effect.scoped(
    Effect.gen(function* () {
      const hosted = yield* Browserbase.open({
        session: {
          timeout: seconds,
          proxies: false,
          userMetadata: { probe: evidence.setup.kind, run: evidence.runId },
          browserSettings: {
            viewport: { width: 1280, height: 720 },
            solveCaptchas: false,
            recordSession: false,
            logSession: false,
            verified: false,
          },
        },
        eventHistory: 4096,
      });

      yield* Effect.addFinalizer(() =>
        hosted.release.pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              release = outcome._tag;
            }),
          ),
        ),
      );
      yield* work(hosted);
    }),
  ).pipe(
    Effect.provideService(Client.BrowserbaseClient, observed.client),
    Effect.timeout(seconds === 420 ? "390 seconds" : "240 seconds"),
    Effect.onExit((exit) => {
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

      const failure =
        Schema.is(BrowserError)(error) || Schema.is(BrowserbaseError)(error)
          ? error.reason._tag
          : Exit.isFailure(exit)
            ? Exit.hasInterrupts(exit)
              ? "Interrupted"
              : "OperationFailed"
            : undefined;

      return evidence
        .write("result.json", {
          ...evidence.setup,
          status: Exit.isSuccess(exit) && release === "Settled" ? "completed" : "incomplete",
          release,
          failure,
          ...observed.evidence(),
          measurements: report(),
        })
        .pipe(Effect.orDie);
    }),
  );
  yield* Console.log(`${evidence.setup.kind.toUpperCase()} evidence: ${evidence.directory}`);
  if (release !== "Settled")
    return yield* refuse(
      "Provider release is unconfirmed; reconcile this run before any new session",
    );
});

export const provider = Layer.mergeAll(
  Client.layerConfig().pipe(Layer.provide(FetchHttpClient.layer)),
  ContextLease.layer,
);
