import { Deferred, Effect, Fiber, FiberSet, Queue, Schema, Semaphore, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import * as AgentRuntime from "effect-agent/agent-runtime";
import type { RunEvent } from "effect-agent/run-event";
import type { BrowserSession, Page } from "effect-browser/browser";
import * as Capture from "effect-browser/capture";
import { BrowserError, Reasons } from "effect-browser/errors";
import type { Event, Stamp, TimelineError } from "effect-browser/timeline-data";

import { MaxCaption, Narrator, type Step } from "./Narrator.ts";
import { Stage } from "./Stage.ts";

const toolkit = BrowserTools.toolkit;

export const agent = Agent.make("livestream-example", {
  input: Schema.String,
  output: Schema.Struct({ summary: Schema.String }),
  instructions: BrowserTools.instructions(toolkit),
  toolkit,
  policy: BrowserTools.policy({ maxTurns: 8, maxToolCalls: 12, maxDuration: "2 minutes" }),
});

export interface LivestreamOptions {
  /** How far behind the browser viewers are. `0` shows it live. */
  readonly delayMillis: number;
  readonly size?: Capture.CaptureSize;
  /** Host pacing and queue policy; the agent never chooses this configuration. */
  readonly execution?: BrowserTools.HandlerOptions["execution"];
  /** Everything as it airs, on the host monotonic clock that stamps captured frames. */
  readonly onAir?: (event: AirEvent) => Effect.Effect<void>;
}

/** One browser Tool call as viewers see it: from its start until the next one starts. */
export interface StepWindow {
  readonly toolCallId: string;
  readonly startedNanos: bigint;
  /** When the next step started, or the run ended. */
  readonly nextNanos: bigint | null;
  readonly invocationId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
}

export type AirEvent =
  | { readonly _tag: "Gap"; readonly consumer: "composition" | "metrics"; readonly count: number }
  | { readonly _tag: "PresentationEnded"; readonly reason: string }
  | { readonly _tag: "CaptureFailed"; readonly reason: string }
  | { readonly _tag: "FrameSkipped"; readonly sequence: number; readonly reason: "metadata-gap" }
  | { readonly _tag: "Frame"; readonly frame: Capture.CapturedFrame; readonly airedNanos: bigint }
  | { readonly _tag: "Address"; readonly address: string | null; readonly airedNanos: bigint }
  | { readonly _tag: "Title"; readonly title: string; readonly airedNanos: bigint }
  | {
      readonly _tag: "Caption";
      readonly text: string;
      readonly step: StepWindow;
      readonly airedNanos: bigint;
    }
  | { readonly _tag: "Clear"; readonly step: StepWindow; readonly airedNanos: bigint }
  | {
      readonly _tag: "Skipped";
      readonly step: StepWindow;
      /** Not written before its step's pictures aired, silent by choice, or the narrator failed. */
      readonly reason: "late" | "silent" | "failed";
    };

const Millis = 1_000_000n;

/** Origin and path: a query or fragment can carry a token, and viewers are not the session. */
const addressOf = (url: string | null) => {
  if (url === null) return null;
  try {
    const parsed = new URL(url);

    return parsed.origin === "null"
      ? `${parsed.protocol}${parsed.pathname}`
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
};

/** Long enough to read (20 characters a second) and never under 5/6 s; at most 7 s. */
const displayNanos = (text: string) =>
  BigInt(Math.round(Math.max(5000 / 6, (text.length / 20) * 1000))) * Millis;

const MaxDisplayNanos = 7000n * Millis;

/**
 * Pointer and address graphics waiting in the delay line, in the order they air. The timeline
 * reader only queues them, so a long delay never lets the timeline evict unread events; a fuller
 * line resets presentation as a timeline gap does.
 */
const MaxCues = 16_384;

interface Cue {
  /** When it airs, before the delay, on the capture owner's clock. */
  readonly at: bigint;
  /** Its event's own time: presentation reset after it drops the cue. */
  readonly since: bigint;
  readonly apply: Effect.Effect<void>;
}

class CueOverflow extends Schema.TaggedError<CueOverflow>()("CueOverflow", {}) {}

interface StepState {
  readonly toolCallId: string;
  readonly tool: string;
  readonly target: string | undefined;
  readonly startedNanos: bigint;
  nextNanos: bigint | null;
  readonly next: Deferred.Deferred<bigint>;
  readonly frameAired: Deferred.Deferred<void>;
  invocationId?: string;
  runId?: string;
  attemptId?: string;
}

const Controls = Schema.Struct({
  controls: Schema.Array(Schema.Struct({ elementId: Schema.String, label: Schema.String })),
});

const decodeControls = Schema.decodeUnknownOption(Controls);

// A click names its control directly; fill, type, press, select and wait name it as `reference`.
const Reference = Schema.Struct({ elementId: Schema.String });
const Target = Schema.Union([Reference, Schema.Struct({ reference: Reference })]);

const decodeTarget = Schema.decodeUnknownOption(Target);

/**
 * Run one agent on `session` and show it to viewers `delayMillis` behind.
 *
 * The capture interval's own bounded buffer is the delay line: each frame is shown once it is
 * `delayMillis` old on the host monotonic clock. Captions, the address and the tab title are
 * scheduled on that clock too, so each airs with the pictures it belongs to. A step's caption
 * is written while the step waits in the delay and airs from the step's start until the next
 * step starts. Text that would not be on screen long enough to read in its own step's window is
 * skipped, never shown over another step.
 */
export const livestream = Effect.fn("Livestream.run")(function* <E>(
  session: BrowserSession<E>,
  page: Page,
  task: string,
  options: LivestreamOptions,
) {
  const delayMillis = yield* Schema.decodeEffect(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600000 })),
  )(options.delayMillis).pipe(
    Effect.mapError(() =>
      BrowserError.make({
        operation: "configure",
        reason: Reasons.Configuration.make({ path: "delayMillis" }),
        outcome: "undispatched",
      }),
    ),
  );

  const stage = yield* Stage;

  const host = yield* BrowserTools.makeHost(
    session,
    page,
    options.execution === undefined ? {} : { execution: options.execution },
  );

  const narrator = yield* Narrator;
  const background = yield* FiberSet.make<void, never>();
  const presentation = yield* Semaphore.make(1);
  const delay = BigInt(delayMillis) * Millis;
  const onAir = options.onAir ?? (() => Effect.void);

  /** Wait until `stamp` is `delayMillis` old. */
  const airAt = (stamp: bigint): Effect.Effect<void> =>
    Effect.flatMap(session.monotonicTimeNanos, (now) =>
      stamp + delay > now
        ? // A timer can wake a few milliseconds early by this clock, so check again.
          Effect.andThen(Effect.sleep(Number(stamp + delay - now) / 1e6), airAt(stamp))
        : Effect.void,
    );

  const originBefore = yield* session.monotonicTimeNanos;
  const timelineNow = yield* page.timeline.now;
  const originAfter = yield* session.monotonicTimeNanos;
  // Relative timeline offsets share the capture owner's clock. Bracketing retains uncertainty;
  // the upper bound schedules presentation conservatively, never by treating an offset as raw time.
  const originUpper = originAfter - timelineNow.offsetNanos;
  const rawTime = (stamp: Stamp) => originUpper + stamp.offsetNanos;

  const interval = yield* Capture.start(page, {
    lifetime: "page",
    size: options.size ?? { width: 1280, height: 720 },
    // Held while they wait: up to ~15 s of a busy page, bounded by bytes before that.
    maxFrames: 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    maxBufferedBytes: 64 * 1024 * 1024,
    maxDurationMillis: 60 * 60_000,
  });

  let document = -1;
  let resetAfterNanos = 0n;
  let metadataFailure: TimelineError | undefined;
  let captureFailure: BrowserError | undefined;
  let skippedFrames = 0;
  let presentationEnded = false;
  let addressAfterNanos = 0n;
  const consumed = { composition: 0n, metrics: 0n };

  const timelineMetrics = {
    compositionEvents: 0,
    metricsEvents: 0,
    compositionGaps: 0,
    metricsGaps: 0,
    refused: 0,
    unknown: 0,
  };

  let latestFrame: Capture.CapturedFrame | undefined;
  let captioned: StepState | undefined;
  let latest: StepState | undefined;
  const pendingFrames = new Set<StepState>();

  const airing = yield* interval.frames.pipe(
    Stream.runForEach((frame) =>
      Effect.gen(function* () {
        yield* airAt(frame.receivedMonotonicNanos);
        yield* presentation.withPermits(1)(
          Effect.gen(function* () {
            if (frame.receivedMonotonicNanos < resetAfterNanos) {
              skippedFrames++;

              return yield* onAir({
                _tag: "FrameSkipped",
                sequence: frame.sequence,
                reason: "metadata-gap",
              });
            }
            const activeCaption = captioned;

            // A later step's first picture closes the previous caption before that picture airs.
            if (
              activeCaption !== undefined &&
              activeCaption.nextNanos !== null &&
              frame.receivedMonotonicNanos >= activeCaption.nextNanos
            ) {
              captioned = undefined;
              yield* stage.update({ caption: null });
              yield* onAir({
                _tag: "Clear",
                step: windowOf(activeCaption),
                airedNanos: yield* session.monotonicTimeNanos,
              });
            }

            yield* stage.show(frame);
            latestFrame = frame;
            // Capture preserves receipt order. Wake every still-open step whose window contains
            // this frame; a later tool call may already be latest while an older frame is airing.
            for (const step of pendingFrames)
              if (
                frame.receivedMonotonicNanos >= step.startedNanos &&
                (step.nextNanos === null || frame.receivedMonotonicNanos < step.nextNanos)
              ) {
                pendingFrames.delete(step);
                yield* Deferred.succeed(step.frameAired, undefined);
              }

            const airedNanos = yield* session.monotonicTimeNanos;

            if (frame.document !== document) {
              document = frame.document;
              const { initialUrl, documentBoundaries } = yield* interval.snapshot;
              const boundary = documentBoundaries.find((known) => known.document === document);
              const addressAt = document === 0 ? 0n : (boundary?.observedMonotonicNanos ?? 0n);

              if (addressAt >= addressAfterNanos && addressAt >= resetAfterNanos) {
                addressAfterNanos = addressAt;
                const address = addressOf(document === 0 ? initialUrl : (boundary?.url ?? null));

                yield* stage.update({ address });
                yield* onAir({ _tag: "Address", address, airedNanos });
              }
            }
            yield* onAir({ _tag: "Frame", frame, airedNanos });
          }),
        );
      }),
    ),
    Effect.catch((error) =>
      Effect.gen(function* () {
        captureFailure = error;
        yield* stage.update({ status: "failed" });
        yield* onAir({ _tag: "CaptureFailed", reason: error.reason._tag });
      }),
    ),
    Effect.forkScoped,
  );

  const labels = new Map<string, string>();
  const declared = new Map<string, string>();
  let finished: { readonly step: StepState; readonly succeeded: boolean } | undefined;
  let summary: unknown = null;

  const windowOf = (step: StepState): StepWindow => ({
    toolCallId: step.toolCallId,
    startedNanos: step.startedNanos,
    nextNanos: step.nextNanos,
    ...(step.invocationId === undefined ? {} : { invocationId: step.invocationId }),
    ...(step.runId === undefined ? {} : { runId: step.runId }),
    ...(step.attemptId === undefined ? {} : { attemptId: step.attemptId }),
  });

  const cues = yield* Queue.dropping<Cue>(MaxCues);

  /** Airs each queued cue in order; a cue from before a presentation reset is dropped. */
  const presenter = yield* Queue.take(cues).pipe(
    Effect.flatMap((cue) =>
      airAt(cue.at).pipe(
        Effect.andThen(
          Effect.suspend(() => (cue.since < resetAfterNanos ? Effect.void : cue.apply)),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  /** Takes one event promptly: whatever it shows waits in `cues`, never in the timeline reader. */
  const projectMetadata = (envelope: Event) =>
    Effect.gen(function* () {
      if (envelope.sequence <= consumed.composition) return;
      consumed.composition = envelope.sequence;
      timelineMetrics.compositionEvents++;
      const since = rawTime(envelope.at);

      if (since < resetAfterNanos) return;
      const event = envelope.event;

      const cue = (at: bigint, apply: Effect.Effect<void>) =>
        Queue.offer(cues, { at, since, apply }).pipe(
          Effect.flatMap((queued) => (queued ? Effect.void : Effect.fail(new CueOverflow()))),
        );

      if (event._tag === "Glide") {
        for (const sample of event.schedule)
          yield* cue(
            rawTime(sample.at),
            presentation.withPermits(1)(stage.update({ pointer: sample.position })),
          );
      } else if (event._tag === "Pointer") {
        yield* cue(
          rawTime(event.interval.end),
          presentation.withPermits(1)(stage.update({ pointer: event.position })),
        );
      } else if (
        event._tag === "CaptureBoundary" &&
        event.captureId === interval.id &&
        event.sameDocument
      ) {
        const observedAt = rawTime(event.observed);
        const address = addressOf(event.url);

        yield* cue(
          observedAt,
          presentation.withPermits(1)(
            Effect.suspend(() => {
              if (observedAt < addressAfterNanos || observedAt < resetAfterNanos)
                return Effect.void;
              addressAfterNanos = observedAt;

              return stage.update({ address }).pipe(
                Effect.andThen(session.monotonicTimeNanos),
                Effect.flatMap((airedNanos) => onAir({ _tag: "Address", address, airedNanos })),
              );
            }),
          ),
        );
      } else if (event._tag === "Terminal") {
        yield* cue(
          since,
          Effect.gen(function* () {
            yield* Fiber.join(airing);
            presentationEnded = true;
            yield* presentation.withPermits(1)(
              stage.update({
                status: captureFailure === undefined ? "ended" : "failed",
                caption: null,
                pointer: null,
              }),
            );
            yield* onAir({ _tag: "PresentationEnded", reason: event.reason });
          }),
        );
      }
    });

  const measureMetadata = (envelope: Event) =>
    Effect.sync(() => {
      if (envelope.sequence <= consumed.metrics) return;
      consumed.metrics = envelope.sequence;
      timelineMetrics.metricsEvents++;
      const event = envelope.event;

      if (
        (event._tag === "Failed" || event._tag === "Cancelled") &&
        (event.outcome === "undispatched" || event.outcome === "rejected")
      )
        timelineMetrics.refused++;
      if ((event._tag === "Failed" || event._tag === "Cancelled") && event.outcome === "unknown")
        timelineMetrics.unknown++;
    });

  /** Metadata consumers own subscriptions only; neither acquires the interval's pixel stream. */
  const consumeTimeline = (
    consumer: "composition" | "metrics",
  ): Effect.Effect<void, TimelineError> =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const snapshot = yield* page.timeline.snapshot();
        const project = consumer === "composition" ? projectMetadata : measureMetadata;

        yield* Effect.forEach(snapshot.events, project, { discard: true });
        yield* page.timeline.events(snapshot.resumeAfter).pipe(Stream.runForEach(project));
      }).pipe(
        // A full delay line is a gap too: what it would have shown is no longer known.
        Effect.catchTag(["TimelineGap", "CueOverflow"], () =>
          Effect.gen(function* () {
            const count =
              consumer === "composition"
                ? ++timelineMetrics.compositionGaps
                : ++timelineMetrics.metricsGaps;

            if (consumer === "composition") {
              yield* presentation.withPermits(1)(
                Effect.gen(function* () {
                  resetAfterNanos = yield* session.monotonicTimeNanos;
                  addressAfterNanos = resetAfterNanos;
                  latestFrame = undefined;
                  captioned = undefined;
                  yield* Queue.clear(cues);
                  yield* stage.update({
                    status: "gap",
                    address: null,
                    title: null,
                    caption: null,
                    pointer: null,
                  });
                }),
              );
            }
            yield* onAir({ _tag: "Gap", consumer, count });

            return yield* consumeTimeline(consumer);
          }),
        ),
      ),
    );

  const readers = yield* Effect.forEach(["composition", "metrics"] as const, (consumer) =>
    consumeTimeline(consumer).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          metadataFailure = error;
          yield* stage.update({ status: "failed" });
        }),
      ),
      Effect.forkScoped,
    ),
  );

  const close = (at: bigint) =>
    latest === undefined
      ? Effect.void
      : Effect.suspend(() => {
          const step = latest;

          if (step === undefined) return Effect.void;
          step.nextNanos = at;

          return Effect.asVoid(Deferred.succeed(step.next, at));
        });

  /** The step's pictures have aired: a caption written later could only cover another step. */
  const windowClosed = (step: StepState) => Effect.flatMap(Deferred.await(step.next), airAt);

  const narrate = (step: StepState, facts: Step) =>
    Effect.gen(function* () {
      const written = yield* Effect.raceFirst(
        narrator.caption(facts).pipe(
          Effect.map((text) => ({ _tag: "Written", text }) as const),
          Effect.orElseSucceed(() => ({ _tag: "Failed" }) as const),
        ),
        Effect.as(windowClosed(step), { _tag: "Late" } as const),
      );

      if (written._tag !== "Written" || written.text === null)
        return yield* onAir({
          _tag: "Skipped",
          step: windowOf(step),
          reason:
            written._tag === "Late" ? "late" : written._tag === "Failed" ? "failed" : "silent",
        });
      const text = written.text.slice(0, MaxCaption);

      const hasFrame = yield* Effect.raceFirst(
        Deferred.await(step.frameAired).pipe(Effect.as(true)),
        windowClosed(step).pipe(Effect.as(false)),
      );

      if (!hasFrame) return yield* onAir({ _tag: "Skipped", step: windowOf(step), reason: "late" });

      yield* airAt(step.startedNanos);

      const shownNanos = yield* presentation.withPermits(1)(
        Effect.gen(function* () {
          const frame = latestFrame;
          const now = yield* session.monotonicTimeNanos;

          // Recheck under the same lane as frame presentation; a later step may have aired while
          // the narrator was writing or waiting for this permit.
          if (
            presentationEnded ||
            step.startedNanos < resetAfterNanos ||
            frame === undefined ||
            frame.receivedMonotonicNanos < step.startedNanos ||
            (step.nextNanos !== null && frame.receivedMonotonicNanos >= step.nextNanos) ||
            (step.nextNanos !== null && step.nextNanos + delay - now < displayNanos(text))
          )
            return undefined;

          const previousCaption = captioned;

          if (previousCaption !== undefined) {
            captioned = undefined;
            yield* stage.update({ caption: null });
            yield* onAir({
              _tag: "Clear",
              step: windowOf(previousCaption),
              airedNanos: yield* session.monotonicTimeNanos,
            });
          }

          captioned = step;
          yield* stage.update({ caption: text });
          const airedNanos = yield* session.monotonicTimeNanos;

          yield* onAir({ _tag: "Caption", text, step: windowOf(step), airedNanos });

          return airedNanos;
        }),
      );

      if (shownNanos === undefined)
        return yield* onAir({ _tag: "Skipped", step: windowOf(step), reason: "late" });

      yield* windowClosed(step).pipe(Effect.timeoutOption(Number(MaxDisplayNanos) / 1e6));
      yield* presentation.withPermits(1)(
        Effect.gen(function* () {
          if (captioned === step) {
            captioned = undefined;
            yield* stage.update({ caption: null });
            yield* onAir({
              _tag: "Clear",
              step: windowOf(step),
              airedNanos: yield* session.monotonicTimeNanos,
            });
          }
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingFrames.delete(step);
        }),
      ),
    );

  /**
   * A finished step's facts are complete once the next model call starts, when the page it left
   * can be read. A step that no model call follows is narrated without the page.
   */
  const narrateFinished = (facts: { readonly url: string; readonly title: string } | undefined) =>
    Effect.suspend(() => {
      const done = finished;

      finished = undefined;
      if (done === undefined) return Effect.void;
      const address = facts === undefined ? null : addressOf(facts.url);

      return FiberSet.run(
        background,
        narrate(done.step, {
          tool: done.step.tool,
          ...(done.step.target === undefined ? {} : { target: done.step.target }),
          ...(address === null ? {} : { address }),
          ...(facts === undefined || facts.title === "" ? {} : { title: facts.title }),
          succeeded: done.succeeded,
        }),
      );
    });

  /** Stamp each event on receipt: a fast consumer is within a couple of milliseconds of it. */
  const observe = (event: RunEvent) =>
    Effect.gen(function* () {
      const now = yield* session.monotonicTimeNanos;

      if (event._tag === "ModelStarted") {
        // Other Page hosts may still be running. Read this exact Page with ordinary bounded admission.
        const facts = yield* Effect.orElseSucceed(
          page.describe({ admission: { queue: 1000 } }),
          () => undefined,
        );

        const title = facts?.title;
        const observedAt = yield* session.monotonicTimeNanos;

        if (title !== undefined && title !== "")
          yield* FiberSet.run(
            background,
            airAt(observedAt).pipe(
              Effect.andThen(
                presentation.withPermits(1)(
                  Effect.suspend(() =>
                    presentationEnded || observedAt < resetAfterNanos
                      ? Effect.void
                      : stage.update({ title }).pipe(
                          Effect.andThen(session.monotonicTimeNanos),
                          Effect.flatMap((airedNanos) =>
                            onAir({ _tag: "Title", title, airedNanos }),
                          ),
                        ),
                  ),
                ),
              ),
            ),
          );
        yield* narrateFinished(facts);
      } else if (event._tag === "ToolCallDeclared") {
        const target = decodeTarget(event.parameters);

        if (target._tag === "Some")
          declared.set(
            event.toolCallId,
            "reference" in target.value ? target.value.reference.elementId : target.value.elementId,
          );
      } else if (event._tag === "ToolCallStarted") {
        yield* narrateFinished(undefined);
        yield* close(now);
        const target = declared.get(event.toolCallId);

        declared.delete(event.toolCallId);

        latest = {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          target: target === undefined ? undefined : labels.get(target),
          startedNanos: now,
          nextNanos: null,
          next: yield* Deferred.make<bigint>(),
          frameAired: yield* Deferred.make<void>(),
        };
        pendingFrames.add(latest);
        const frame = latestFrame;

        // A frame can finish presentation while this step's event is being assembled. Reconcile
        // that receipt here so its waiter cannot miss the only frame in a still page.
        if (
          frame !== undefined &&
          frame.receivedMonotonicNanos >= latest.startedNanos &&
          (latest.nextNanos === null || frame.receivedMonotonicNanos < latest.nextNanos)
        ) {
          pendingFrames.delete(latest);
          yield* Deferred.succeed(latest.frameAired, undefined);
        }
      } else if (event._tag === "ToolCallSucceeded" || event._tag === "ToolCallFailed") {
        if (event._tag === "ToolCallSucceeded") {
          const observed = decodeControls(event.result);

          if (observed._tag === "Some") {
            labels.clear();
            for (const control of observed.value.controls)
              labels.set(control.elementId, control.label);
          }
        }
        const step = latest;

        if (step?.toolCallId === event.toolCallId) {
          const receipt = (yield* host.receipts).receipts.findLast(
            (candidate) =>
              candidate.toolCallId === event.toolCallId && candidate.toolName === event.toolName,
          );

          if (receipt !== undefined) step.invocationId = receipt.invocationId;
          if (receipt?._tag === "Run") {
            step.runId = receipt.operation.id;
            const attempts = yield* receipt.operation.attempts;
            const attempt = attempts.attempts.at(-1);

            if (attempt !== undefined) step.attemptId = attempt.id;
          }
          finished = { step, succeeded: event._tag === "ToolCallSucceeded" };
        }
      } else if (event._tag === "RunCompleted" || event._tag === "RunFailed") {
        if (event._tag === "RunCompleted") summary = event.output;
        yield* narrateFinished(undefined);
        yield* close(now);
      }
    });

  const outcome = yield* host
    .run(AgentRuntime.stream(agent, task).pipe(Stream.runForEach(observe)))
    .pipe(Effect.exit);

  // Let the last moment air, then stop capturing and show what is still waiting.
  yield* Effect.sleep(1000);
  const capture = yield* interval.stop;

  yield* FiberSet.awaitEmpty(background).pipe(
    Effect.timeoutOption(Number(delay + MaxDisplayNanos) / 1e6),
  );
  yield* Fiber.join(airing);
  yield* Effect.forEach([...readers, presenter], Fiber.interrupt, { discard: true });
  if (!presentationEnded) {
    presentationEnded = true;
    yield* presentation.withPermits(1)(
      stage.update({
        status: captureFailure === undefined && metadataFailure === undefined ? "ended" : "failed",
        caption: null,
        pointer: null,
      }),
    );
    yield* onAir({ _tag: "PresentationEnded", reason: capture.reason });
  }

  return {
    outcome,
    summary,
    capture,
    captureFailure,
    timeline: {
      ...timelineMetrics,
      skippedFrames,
      failure: metadataFailure,
      clock: { clockId: timelineNow.clockId, uncertaintyNanos: originAfter - originBefore },
    },
  };
}, Effect.scoped);
