/**
 * Reading a page: its outline with refs, whether it shows some text, and an observation that
 * pairs the outline with a picture.
 */
import { Duration, Effect, Ref, Schedule, Schema } from "effect";

import { type BrowserError, NotFound, Timeout } from "../../BrowserError.ts";
import type { Image } from "../../Frame.ts";
import { Observation, type ObservationMode } from "../../Page.ts";
import { Snapshot, type SnapshotOptions } from "../../Snapshot.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext } from "../page/context.ts";
import { type SnapshotRequest, SnapshotResultSchema } from "./outline.inpage.ts";

export const make = Effect.fnUntraced(function* (
  page: PageContext,
  bridge: Bridge,
  screenshot: () => Effect.Effect<Image, BrowserError>,
) {
  const { settings, now, span, owned } = page;
  const { evaluate } = bridge;
  const nextRef = yield* Ref.make(1);

  const snapshot = (snapshotOptions: SnapshotOptions = {}) =>
    Effect.gen(function* () {
      const request: SnapshotRequest = {
        full: snapshotOptions.full ?? false,
        query: snapshotOptions.query ?? null,
        maxChars: snapshotOptions.maxChars ?? 12_000,
        firstRef: yield* Ref.get(nextRef),
      };

      const result = yield* evaluate("snapshot", scriptCall("snapshot", request)).pipe(
        Effect.flatMap(decodeWith("snapshot", SnapshotResultSchema)),
      );

      yield* Ref.set(nextRef, result.nextRef);
      yield* Effect.annotateCurrentSpan({ chars: result.text.length, truncated: result.truncated });

      return new Snapshot({
        url: result.url,
        title: result.title,
        text: result.text,
        truncated: result.truncated,
        above: result.above,
        below: result.below,
        viewport: { width: result.width, height: result.height },
        scroll: { y: result.scrollY, height: result.scrollHeight },
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: settings.actionTimeout,
        orElse: () =>
          failWith("snapshot", new Timeout({ millis: Duration.toMillis(settings.actionTimeout) })),
      }),
      span("Page.snapshot", { full: snapshotOptions.full ?? false }),
      owned,
    );

  const observe = (
    observeOptions: {
      readonly mode?: ObservationMode;
      readonly full?: boolean;
      readonly maxChars?: number;
    } = {},
  ) =>
    Effect.all(
      {
        snapshot:
          observeOptions.mode === "screenshot"
            ? Effect.void
            : snapshot({ full: observeOptions.full, maxChars: observeOptions.maxChars }),
        image: observeOptions.mode === "outline" ? Effect.void : screenshot(),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map(
        ({ snapshot, image }) =>
          new Observation({
            snapshot: snapshot ?? undefined,
            image: image ?? undefined,
            at: now(),
          }),
      ),
      span("Page.observe", { mode: observeOptions.mode ?? "both" }),
      owned,
    );

  const hasText = (text: string) =>
    evaluate("hasText", scriptCall("hasText", text)).pipe(
      Effect.flatMap(decodeWith("hasText", Schema.Boolean)),
    );

  const waitForText = (text: string, timeout: Duration.Input = Duration.seconds(10)) =>
    hasText(text).pipe(
      Effect.repeat({ schedule: Schedule.spaced(Duration.millis(250)), until: (found) => found }),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => failWith("waitForText", new NotFound({ target: JSON.stringify(text) })),
      }),
      Effect.asVoid,
      span("Page.waitForText"),
      owned,
    );

  return { snapshot, observe, hasText, waitForText };
});

export type Reading = Effect.Success<ReturnType<typeof make>>;
