/** Explicit picture and change evidence; bounded delivery and the production change fold. */
import { Duration, Effect, Option, PubSub, Stream, type Take } from "effect";

import { type BrowserError, InvalidRequest, NotFound, undispatched } from "../BrowserError.ts";
import { Change, Changes } from "../Change.ts";
import { type Frame, sameCapture } from "../Frame.ts";
import { fold } from "../internal/timeline/fold.inpage.ts";
import type { Page } from "../Page.ts";
import * as Model from "./model.ts";

export const make = Effect.fnUntraced(function* (options: {
  readonly id: string;
  readonly connection: string;
  readonly session: string;
  readonly now: () => number;
  readonly model: ReturnType<typeof Model.make>;
}) {
  const { model, now } = options;
  const { unsupported } = Model;
  const feed = yield* PubSub.sliding<Take.Take<Frame, BrowserError>>(64);
  let frames: ReadonlyArray<Frame> = [];
  const folding = fold();

  const owned = (frame: Frame) =>
    frame.page === options.id &&
    frame.connection === options.connection &&
    frame.session === options.session;

  const inDocument = (frame: Frame) =>
    !model.isClosed() && owned(frame) && frame.document === model.document();

  const isCurrent = (frame: Frame) =>
    inDocument(frame) && sameCapture(frame, frames.findLast(inDocument));

  const emitFrame = (frame: Frame) =>
    Effect.gen(function* () {
      yield* model.check("emitFrame");
      if (!owned(frame) || frame.document > model.document())
        return yield* undispatched(
          "emitFrame",
          new InvalidRequest({
            detail: "the frame belongs to another page, connection or future document",
          }),
        );
      frames = [...frames.slice(-255), frame];
      yield* PubSub.publish(feed, [frame]);
    });

  const frame: Page["frame"] = (asked) =>
    Effect.suspend(() => {
      if (asked?.after !== undefined) return unsupported("frame:after");
      const age = Duration.fromInput(asked?.maxAge ?? Duration.millis(250));

      const found = frames.findLast(
        (frame) =>
          isCurrent(frame) &&
          Option.isSome(age) &&
          now() - (frame.hostTime - frame.timing.uncertaintyMillis) <= Duration.toMillis(age.value),
      );

      return found === undefined
        ? Effect.fail(undispatched("frame", new NotFound({ target: "a current seeded frame" })))
        : Effect.as(model.check("frame"), found);
    });

  const changes: Page["changes"] = (asked) =>
    Effect.gen(function* () {
      yield* model.check("changes");
      const start = asked?.since;

      const since =
        typeof start === "number"
          ? start
          : start === undefined
            ? 0
            : "cursor" in start
              ? start.cursor
              : start.hostTime;

      const until = Math.min(
        now(),
        typeof asked?.until === "number" ? asked.until : (asked?.until?.hostTime ?? now()),
      );

      if (!Number.isFinite(since) || !Number.isFinite(until))
        return yield* undispatched(
          "changes",
          new InvalidRequest({ detail: "change bounds must be finite" }),
        );

      const changes = (model.get().changes ?? []).flatMap((record) => {
        const over = folding.over(
          { ...record, key: record, samples: [...record.samples] },
          since,
          until,
        );

        if (over === undefined) return [];
        const hidden = record.secret || (record.kind === "value" && !asked?.unmask);

        return [
          new Change({
            ...over,
            subject: record.subject,
            before: hidden && over.before !== undefined ? "••••" : over.before,
            after: hidden && over.after !== undefined ? "••••" : over.after,
          }),
        ];
      });

      return new Changes({
        document: model.document(),
        from: since,
        until,
        cursor: until,
        dropped: 0,
        changes,
      });
    });

  const capture: Page["capture"] = (asked) =>
    asked?.quality === undefined && asked?.size === undefined
      ? Effect.gen(function* () {
          yield* model.check("capture");
          const subscription = yield* PubSub.subscribe(feed);

          return {
            stream: Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(Stream.flattenTake),
            get current() {
              return frames.findLast(inDocument);
            },
            isCurrent,
            confirm: (frame) => Effect.as(model.check("confirm"), isCurrent(frame)),
            sync: model.check("sync"),
            stats: () => unsupported("captureStats"),
          };
        })
      : unsupported("capture:options");

  for (const frame of model.get().frames ?? []) yield* emitFrame(frame);
  yield* Effect.addFinalizer(() => PubSub.shutdown(feed));

  return {
    frame,
    changes,
    capture,
    emitFrame,
    recentFrames: Effect.sync(() => frames),
    // Keep the terminal available to captures acquired before their reader starts.
    close: Effect.flatMap(Effect.exit(model.check("capture")), (end) =>
      PubSub.publish(feed, end),
    ).pipe(Effect.asVoid),
  };
});
