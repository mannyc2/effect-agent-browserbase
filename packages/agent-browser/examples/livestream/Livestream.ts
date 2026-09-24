import { Clock, Deferred, Effect, Fiber, FiberSet, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import * as AgentRuntime from "effect-agent/agent-runtime";
import type { RunEvent } from "effect-agent/run-event";
import type { BrowserSession } from "effect-browser/browser";
import * as Capture from "effect-browser/capture";

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
  /** Everything as it airs, on the host monotonic clock that stamps captured frames. */
  readonly onAir?: (event: AirEvent) => Effect.Effect<void>;
}

/** One browser Tool call as viewers see it: from its start until the next one starts. */
export interface StepWindow {
  readonly toolCallId: string;
  readonly startedNanos: bigint;
  /** When the next step started, or the run ended. */
  readonly nextNanos: bigint | null;
}

export type AirEvent =
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
  | { readonly _tag: "Skipped"; readonly step: StepWindow; readonly reason: "late" | "empty" };

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

interface StepState {
  readonly toolCallId: string;
  readonly tool: string;
  readonly target: string | undefined;
  readonly startedNanos: bigint;
  nextNanos: bigint | null;
  readonly next: Deferred.Deferred<bigint>;
}

const Controls = Schema.Struct({
  controls: Schema.Array(Schema.Struct({ elementId: Schema.String, label: Schema.String })),
});

const decodeControls = Schema.decodeUnknownOption(Controls);

const Target = Schema.Struct({ elementId: Schema.String });

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
  task: string,
  options: LivestreamOptions,
) {
  const stage = yield* Stage;
  const narrator = yield* Narrator;
  const background = yield* FiberSet.make<void, never>();
  const delay = BigInt(options.delayMillis) * Millis;
  const onAir = options.onAir ?? (() => Effect.void);

  /** Wait until `stamp` is `delayMillis` old. */
  const airAt = (stamp: bigint) =>
    Effect.flatMap(Clock.monotonicTimeNanos, (now) =>
      stamp + delay > now ? Effect.sleep(Number(stamp + delay - now) / 1e6) : Effect.void,
    );

  const interval = yield* Capture.start(session, {
    lifetime: "page",
    size: options.size ?? { width: 1280, height: 720 },
    // Held while they wait: up to ~15 s of a busy page, bounded by bytes before that.
    maxFrames: 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    maxBufferedBytes: 64 * 1024 * 1024,
    maxDurationMillis: 60 * 60_000,
  });

  let document = -1;

  const airing = yield* interval.frames.pipe(
    Stream.runForEach((frame) =>
      Effect.gen(function* () {
        yield* airAt(frame.receivedMonotonicNanos);
        yield* stage.show(frame);
        const airedNanos = yield* Clock.monotonicTimeNanos;

        if (frame.document !== document) {
          document = frame.document;
          const { initialUrl, documentBoundaries } = yield* interval.snapshot;
          const boundary = documentBoundaries.find((known) => known.document === document);
          const address = addressOf(document === 0 ? initialUrl : (boundary?.url ?? null));

          yield* stage.update({ address });
          yield* onAir({ _tag: "Address", address, airedNanos });
        }
        yield* onAir({ _tag: "Frame", frame, airedNanos });
      }),
    ),
    Effect.orElseSucceed(() => undefined),
    Effect.forkScoped,
  );

  const labels = new Map<string, string>();
  const declared = new Map<string, unknown>();
  let latest: StepState | undefined;
  let captioned: string | undefined;
  let summary: unknown = null;

  const windowOf = (step: StepState): StepWindow => ({
    toolCallId: step.toolCallId,
    startedNanos: step.startedNanos,
    nextNanos: step.nextNanos,
  });

  const close = (at: bigint) =>
    latest === undefined
      ? Effect.void
      : Effect.suspend(() => {
          const step = latest;

          if (step === undefined) return Effect.void;
          step.nextNanos = at;

          return Effect.asVoid(Deferred.succeed(step.next, at));
        });

  const narrate = (step: StepState, succeeded: boolean) =>
    Effect.gen(function* () {
      const facts: Step = {
        tool: step.tool,
        ...(step.target === undefined ? {} : { target: step.target }),
        succeeded,
      };

      const text = (yield* narrator.caption(facts)).slice(0, MaxCaption);

      if (text === "")
        return yield* onAir({ _tag: "Skipped", step: windowOf(step), reason: "empty" });
      yield* airAt(step.startedNanos);
      const shownNanos = yield* Clock.monotonicTimeNanos;

      // Only inside this step's own window, and only if it can stay long enough to be read.
      if (step.nextNanos !== null && step.nextNanos + delay - shownNanos < displayNanos(text))
        return yield* onAir({ _tag: "Skipped", step: windowOf(step), reason: "late" });
      captioned = step.toolCallId;
      yield* stage.update({ caption: text });
      yield* onAir({ _tag: "Caption", text, step: windowOf(step), airedNanos: shownNanos });
      yield* Deferred.await(step.next).pipe(
        Effect.flatMap(airAt),
        Effect.timeoutOption(Number(MaxDisplayNanos) / 1e6),
      );
      if (captioned !== step.toolCallId) return;
      captioned = undefined;
      yield* stage.update({ caption: null });
      yield* onAir({
        _tag: "Clear",
        step: windowOf(step),
        airedNanos: yield* Clock.monotonicTimeNanos,
      });
    });

  /** Stamp each event on receipt: a fast consumer is within a couple of milliseconds of it. */
  const observe = (event: RunEvent) =>
    Effect.gen(function* () {
      const now = yield* Clock.monotonicTimeNanos;

      if (event._tag === "ModelStarted") {
        // No browser call runs while the model thinks, so the page's title can be read.
        const pages = yield* Effect.orElseSucceed(session.pages, () => []);
        const title = pages.find((page) => page.selected)?.title;

        if (title !== undefined && title !== "")
          yield* FiberSet.run(
            background,
            airAt(now).pipe(
              Effect.andThen(stage.update({ title })),
              Effect.andThen(Clock.monotonicTimeNanos),
              Effect.flatMap((airedNanos) => onAir({ _tag: "Title", title, airedNanos })),
            ),
          );
      } else if (event._tag === "ToolCallDeclared")
        declared.set(event.toolCallId, event.parameters);
      else if (event._tag === "ToolCallStarted") {
        yield* close(now);
        const target = decodeTarget(declared.get(event.toolCallId));

        latest = {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          target: target._tag === "Some" ? labels.get(target.value.elementId) : undefined,
          startedNanos: now,
          nextNanos: null,
          next: yield* Deferred.make<bigint>(),
        };
      } else if (event._tag === "ToolCallSucceeded" || event._tag === "ToolCallFailed") {
        if (event._tag === "ToolCallSucceeded") {
          const observed = decodeControls(event.result);

          if (observed._tag === "Some")
            for (const control of observed.value.controls)
              labels.set(control.elementId, control.label);
        }
        const step = latest;

        if (step?.toolCallId === event.toolCallId)
          yield* FiberSet.run(background, narrate(step, event._tag === "ToolCallSucceeded"));
      } else if (event._tag === "RunCompleted") {
        summary = event.output;
        yield* close(now);
      } else if (event._tag === "RunFailed") yield* close(now);
    });

  const outcome = yield* BrowserTools.run(
    session,
    AgentRuntime.stream(agent, task).pipe(Stream.runForEach(observe)),
  ).pipe(Effect.exit);

  // Let the last moment air, then stop capturing and show what is still waiting.
  yield* Effect.sleep(1000);
  const capture = yield* interval.stop;

  yield* FiberSet.awaitEmpty(background).pipe(
    Effect.timeoutOption(Number(delay + MaxDisplayNanos) / 1e6),
  );
  yield* Fiber.join(airing);

  return { outcome, summary, capture };
});
