import { Effect, Exit, Schema } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { SnapshotJson } from "effect-browser/timeline-data";
import {
  BrowserbaseBrowser,
  type BrowserbaseSession,
  type LiveView,
} from "effect-browserbase/browser";

import { filming, released } from "./Backends.ts";
import { cursorFromInput } from "./Clip.ts";
import { makeInputLog, type InputLog } from "./InputLog.ts";
import { BenchError, type Journal, json, tagOf } from "./Records.ts";

export const OperatorRelease = Schema.Struct({ operatorReleasedControl: Schema.Literal(true) });

/** Only this terminal-side callback receives bearer Live View URLs. Nothing writes them to the journal. */
export interface Operator<E, R> {
  readonly showLiveView: (view: LiveView) => Effect.Effect<void, E, R>;
  /** The host must receive an explicit release message. A timeout is never release. */
  readonly waitReleased: Effect.Effect<unknown, E, R>;
}

export interface ReferenceOptions<E, R> {
  readonly onAir: Browser.Page;
  readonly inputLog: InputLog;
  readonly operator: Operator<E, R>;
  readonly durationMillis: number;
  readonly ttlSeconds?: number;
  readonly provenance?: "operator-controlled" | "unpaid-operator-protocol-fixture";
  readonly afterResume?: (pages: ReadonlyArray<Browser.Page>) => Effect.Effect<void, E, R>;
}

const Options = Schema.Struct({
  durationMillis: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 900000 })),
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900 })),
  provenance: Schema.Literals(["operator-controlled", "unpaid-operator-protocol-fixture"]),
}).check(
  Schema.makeFilter((options) => options.ttlSeconds <= Math.ceil(options.durationMillis / 1000), {
    title: "Live View TTL does not exceed the bounded reference interval",
  }),
);

const CaptureAccounting = Schema.Struct({
  discarded: Schema.Natural,
  upstreamDrops: Schema.Literal("unknown"),
});

/**
 * Use and close the exact original owner. Current handoff stops Capture before pausing automation;
 * this protocol records that gap and does not qualify the retained frames as human footage.
 */
export const reference = Effect.fn("Bench.humanReference")(function* <
  OwnerError,
  OperatorError,
  OperatorRequirements,
>(
  journal: Journal,
  browser: BrowserbaseSession<OwnerError>,
  options: ReferenceOptions<OperatorError, OperatorRequirements>,
) {
  const onAir = options.onAir;
  let handedOff = false;
  let operatorReleased = false;
  let resumed = false;
  let framesBeforeHandoff = 0;
  let handoffAtMillis: number | null = null;
  let releasedAtMillis: number | null = null;

  const workflow = Browser.scoped(Effect.succeed(browser), (owner) =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeEffect(Options)({
        durationMillis: options.durationMillis,
        ttlSeconds: options.ttlSeconds ?? Math.ceil(options.durationMillis / 1000),
        provenance: options.provenance ?? "operator-controlled",
      });

      yield* Browser.checkPage(owner, onAir);
      if (journal.manifest.backend !== "browserbase")
        return yield* BenchError.make({
          operation: "human reference",
          message: "Human reference requires the original Browserbase owner.",
        });

      return yield* filming(
        journal,
        onAir,
        Effect.gen(function* () {
          // A short baseline checks the exact Page's capture before handing any authority to the operator.
          yield* Effect.sleep("250 millis");
          framesBeforeHandoff = journal.recording?.frames.length ?? 0;
          const handoff = yield* owner.beginHandoff(config.ttlSeconds);

          handedOff = true;
          handoffAtMillis = journal.elapsedMillis();
          journal.append({
            kind: "host",
            turn: null,
            value: json({ phase: "operator-control", capture: "stopped-before-handoff" }),
          });
          yield* options.operator.showLiveView(handoff.view);
          yield* Schema.decodeUnknownEffect(OperatorRelease)(yield* options.operator.waitReleased);
          operatorReleased = true;
          releasedAtMillis = journal.elapsedMillis();

          const inventory = yield* owner.resume(handoff.token, true);
          const pages = yield* Effect.forEach(inventory.pages, (info) => owner.page(info));

          resumed = true;
          if (options.afterResume !== undefined) yield* options.afterResume(pages);
          journal.append({
            kind: "host",
            turn: null,
            value: json({
              phase: "resumed",
              generation: inventory.generation,
              pages: pages.length,
            }),
          });

          return inventory;
        }).pipe(Effect.timeout(config.durationMillis)),
      );
    }),
  );

  return yield* workflow.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        // The scoped owner already checked cleanup. This reads the same retained decision, never another connection.
        const cleanup = yield* browser.closeChecked.pipe(Effect.exit);

        journal.ownerClose = Exit.isSuccess(cleanup) ? "confirmed" : "failed";
        if (Exit.isSuccess(cleanup)) yield* released(journal)(cleanup.value);
        else journal.failure ??= tagOf(cleanup.cause);
        if (Exit.isFailure(exit)) journal.failure ??= tagOf(exit.cause);
        const timeline = yield* onAir.timeline.snapshot().pipe(Effect.exit);

        const encoded = Exit.isSuccess(timeline)
          ? yield* Schema.encodeEffect(SnapshotJson)(timeline.value).pipe(Effect.exit)
          : undefined;

        const input = options.inputLog.snapshot();

        journal.truth = json({
          provenance: options.provenance ?? "operator-controlled",
          inputs: input,
          timeline: encoded !== undefined && Exit.isSuccess(encoded) ? encoded.value : null,
        });
        journal.metrics = json({
          arm: "human-reference",
          provenance: options.provenance ?? "operator-controlled",
          handedOff,
          operatorReleased,
          resumed,
          handoffAtMillis,
          releasedAtMillis,
          framesBeforeHandoff,
          retainedFrames: journal.recording?.frames.length ?? 0,
          capture: handedOff ? "stopped-before-handoff" : "handoff-not-reached",
          humanFootage: "unavailable",
          panelEligible: false,
          inputEvents: input.events.length,
          inputLoss: input.lost,
          inputCompleteness: input.completeness,
          operatorInputDelivery: "handoff-pauses-binding-admission",
          followUp:
            "Passive capture during handoff or supported provider recording recovery is required before a human footage comparison.",
        });
      }),
    ),
  );
});

/** The CLI supplies the authorized provider layer and session cap; this adds only origin-limited logging. */
export const openReference = Effect.fn("Bench.openHumanReference")(function* <
  OperatorError,
  OperatorRequirements,
>(
  journal: Journal,
  options: Omit<ReferenceOptions<OperatorError, OperatorRequirements>, "onAir" | "inputLog"> & {
    readonly origins: ReadonlyArray<string>;
    readonly url: string;
    readonly maxInputEvents?: number;
  },
) {
  const config = yield* Schema.decodeEffect(Options)({
    durationMillis: options.durationMillis,
    ttlSeconds: options.ttlSeconds ?? Math.ceil(options.durationMillis / 1000),
    provenance: options.provenance ?? "operator-controlled",
  });

  const inputLog = yield* makeInputLog({
    origins: options.origins,
    maxEvents: options.maxInputEvents ?? 8192,
  });

  const url = yield* Effect.try({
    try: () => new URL(options.url),
    catch: () =>
      BenchError.make({ operation: "human reference", message: "Reference URL is malformed." }),
  });

  if (!options.origins.includes(url.origin))
    return yield* BenchError.make({
      operation: "human reference",
      message: "Reference URL must use a declared logging origin.",
    });

  return yield* Browser.scoped(
    BrowserbaseBrowser.open(
      BrowserPolicy.unrestricted({
        maxActions: 1000,
        maxElapsedMillis: config.durationMillis + 30000,
      }),
      { bootstrap: inputLog.bootstrap },
    ),
    (browser) =>
      Effect.gen(function* () {
        yield* browser.initialPage.navigate({ url: options.url });

        return yield* reference(journal, browser, {
          ...options,
          ...config,
          inputLog,
          onAir: browser.initialPage,
        });
      }),
  );
});

export type OperatorOnlyOptions<E, R> = Omit<ReferenceOptions<E, R>, "afterResume">;

/**
 * Host-operated protocol: the callback receives only the redacted Live View, and this observer
 * makes no browser mutations or model calls while waiting. Unlike handoff, Live View leaves
 * capture and the origin-limited input binding active. The host must not run concurrent automation.
 */
export const operatorOnlyReference = Effect.fn("Bench.operatorOnlyReference")(function* <
  OwnerError,
  OperatorError,
  OperatorRequirements,
>(
  journal: Journal,
  browser: BrowserbaseSession<OwnerError>,
  options: OperatorOnlyOptions<OperatorError, OperatorRequirements>,
) {
  const onAir = options.onAir;
  let operatorReleased = false;
  let operatorStartedAtMillis: number | null = null;
  let releasedAtMillis: number | null = null;
  let framesBeforeOperator = 0;

  const workflow = Browser.scoped(Effect.succeed(browser), (owner) =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeEffect(Options)({
        durationMillis: options.durationMillis,
        ttlSeconds: options.ttlSeconds ?? Math.ceil(options.durationMillis / 1000),
        provenance: options.provenance ?? "operator-controlled",
      });

      yield* Browser.checkPage(owner, onAir);
      if (
        journal.manifest.backend !== "browserbase" ||
        journal.manifest.capture.maxDurationMillis < config.durationMillis
      )
        return yield* BenchError.make({
          operation: "operator-only reference",
          message:
            "The original Browserbase owner and a capture duration covering the interval are required.",
        });

      yield* filming(
        journal,
        onAir,
        Effect.gen(function* () {
          yield* Effect.sleep("250 millis");
          const view = yield* owner.liveView(config.ttlSeconds);

          framesBeforeOperator = journal.recording?.frames.length ?? 0;
          operatorStartedAtMillis = journal.elapsedMillis();
          journal.append({
            kind: "host",
            turn: null,
            value: json({ phase: "operator-control", mode: "operator-only-live-view" }),
          });
          yield* options.operator.showLiveView(view);
          yield* Schema.decodeUnknownEffect(OperatorRelease)(yield* options.operator.waitReleased);
          operatorReleased = true;
          releasedAtMillis = journal.elapsedMillis();
          journal.append({ kind: "host", turn: null, value: json({ phase: "operator-released" }) });
          // Let the page's 50 ms logger flush its current batch; navigation tails remain qualified.
          yield* Effect.sleep("100 millis");
        }).pipe(Effect.timeout(config.durationMillis)),
      );
    }),
  );

  return yield* workflow.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const cleanup = yield* browser.closeChecked.pipe(Effect.exit);

        journal.ownerClose = Exit.isSuccess(cleanup) ? "confirmed" : "failed";
        if (Exit.isSuccess(cleanup)) yield* released(journal)(cleanup.value);
        else journal.failure ??= tagOf(cleanup.cause);
        if (Exit.isFailure(exit)) journal.failure ??= tagOf(exit.cause);
        const timeline = yield* onAir.timeline.snapshot().pipe(Effect.exit);

        const encoded = Exit.isSuccess(timeline)
          ? yield* Schema.encodeEffect(SnapshotJson)(timeline.value).pipe(Effect.exit)
          : undefined;

        const input = options.inputLog.snapshot();
        const recording = journal.recording;
        const firstFrame = recording?.frames[0];

        const accounting = yield* Schema.decodeUnknownEffect(CaptureAccounting)(
          recording?.summary,
        ).pipe(Effect.exit);

        const operatorFrames =
          recording?.frames.filter(
            (frame) =>
              operatorStartedAtMillis !== null &&
              releasedAtMillis !== null &&
              frame.receivedAt >= operatorStartedAtMillis &&
              frame.receivedAt <= releasedAtMillis,
          ).length ?? 0;

        const captureActiveThroughRelease =
          operatorReleased &&
          operatorFrames > 0 &&
          framesBeforeOperator > 0 &&
          releasedAtMillis !== null &&
          (recording?.captureEndedAt ?? -1) >= releasedAtMillis &&
          recording?.nativeStop === "confirmed" &&
          recording.error === null &&
          recording.limitReached === null;

        const provenance = options.provenance ?? "operator-controlled";

        journal.truth = json({
          provenance,
          inputs: input,
          timeline: encoded !== undefined && Exit.isSuccess(encoded) ? encoded.value : null,
          cursorSamples:
            firstFrame === undefined
              ? []
              : cursorFromInput(input.events, firstFrame.sourceTimeMillis),
          cursorClock: {
            qualification: "browser-reported-shared-unix-epoch",
            videoStartSourceMillis: firstFrame?.sourceTimeMillis ?? null,
          },
        });
        journal.metrics = json({
          arm: "human-reference",
          mode: "operator-only-live-view",
          provenance,
          operatorReleased,
          operatorStartedAtMillis,
          releasedAtMillis,
          framesBeforeOperator,
          operatorFrames,
          retainedFrames: recording?.frames.length ?? 0,
          capture: captureActiveThroughRelease
            ? "active-through-operator-interval"
            : operatorReleased
              ? "operator-interval-incomplete"
              : "operator-release-not-received",
          humanFootage:
            provenance === "unpaid-operator-protocol-fixture"
              ? "protocol-fixture-only"
              : captureActiveThroughRelease
                ? "operator-interval-retained"
                : "unavailable",
          panelEligible:
            provenance === "operator-controlled" &&
            captureActiveThroughRelease &&
            Exit.isSuccess(exit) &&
            journal.cleanup === "confirmed" &&
            input.lost === 0 &&
            Exit.isSuccess(accounting) &&
            accounting.value.discarded === 0 &&
            recording?.discardedFrames === 0,
          capturePackageDiscarded: Exit.isSuccess(accounting) ? accounting.value.discarded : null,
          captureRetainedDiscarded: recording?.discardedFrames ?? null,
          captureUpstreamDrops: "unknown",
          panelEligibilityBasis:
            "retained-operator-interval-with-known-loss-checks-and-unverified-navigation-tail",
          inputEvents: input.events.length,
          inputLoss: input.lost,
          inputCompleteness: input.completeness,
          operatorInputDelivery: "binding-active",
        });
      }),
    ),
  );
});

/** Configure logging before allocation. The host supplies its authorized provider layer and terminal callbacks. */
export const openOperatorOnlyReference = Effect.fn("Bench.openOperatorOnlyReference")(function* <
  OperatorError,
  OperatorRequirements,
>(
  journal: Journal,
  options: Omit<OperatorOnlyOptions<OperatorError, OperatorRequirements>, "onAir" | "inputLog"> & {
    readonly origins: ReadonlyArray<string>;
    readonly url: string;
    readonly maxInputEvents?: number;
  },
) {
  const config = yield* Schema.decodeEffect(Options)({
    durationMillis: options.durationMillis,
    ttlSeconds: options.ttlSeconds ?? Math.ceil(options.durationMillis / 1000),
    provenance: options.provenance ?? "operator-controlled",
  });

  const inputLog = yield* makeInputLog({
    origins: options.origins,
    maxEvents: options.maxInputEvents ?? 8192,
  });

  const url = yield* Effect.try({
    try: () => new URL(options.url),
    catch: () =>
      BenchError.make({
        operation: "operator-only reference",
        message: "Reference URL is malformed.",
      }),
  });

  if (
    !options.origins.includes(url.origin) ||
    journal.manifest.backend !== "browserbase" ||
    journal.manifest.capture.maxDurationMillis < config.durationMillis
  )
    return yield* BenchError.make({
      operation: "operator-only reference",
      message:
        "A declared logging origin, Browserbase backend and capture duration covering the interval are required.",
    });

  return yield* Browser.scoped(
    BrowserbaseBrowser.open(
      BrowserPolicy.unrestricted({
        maxActions: 1,
        maxElapsedMillis: config.durationMillis + 30000,
      }),
      { bootstrap: inputLog.bootstrap },
    ),
    (browser: BrowserbaseSession) =>
      Effect.gen(function* () {
        yield* browser.initialPage.navigate({ url: options.url });
        yield* operatorOnlyReference(journal, browser, {
          ...options,
          ...config,
          inputLog,
          onAir: browser.initialPage,
        });
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // Also retain a navigation failure that occurs before the operator interval begins.
            const cleanup = yield* browser.closeChecked.pipe(Effect.exit);

            journal.ownerClose = Exit.isSuccess(cleanup) ? "confirmed" : "failed";
            if (Exit.isSuccess(cleanup)) yield* released(journal)(cleanup.value);
            else journal.failure ??= tagOf(cleanup.cause);
            if (Exit.isFailure(exit)) journal.failure ??= tagOf(exit.cause);
          }),
        ),
      ),
  );
});
