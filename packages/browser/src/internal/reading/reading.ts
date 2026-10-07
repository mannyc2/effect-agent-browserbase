/**
 * Reading a page: its outline with refs, the elements a query finds, the text it shows, and an
 * observation that pairs the outline with a picture.
 */
import { Duration, Effect, Ref, Schedule } from "effect";

import {
  type BrowserError,
  InvalidRequest,
  NotFound,
  StaleRef,
  Timeout,
} from "../../BrowserError.ts";
import { Subject } from "../../BrowserEvent.ts";
import type { Image } from "../../Frame.ts";
import {
  type FindQuery,
  Found,
  Observation,
  type ObservationMode,
  Text,
  type TextOptions,
} from "../../Page.ts";
import { Snapshot, type SnapshotOptions } from "../../Snapshot.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext } from "../page/context.ts";
import type { FindRequest, Wanted } from "./match.inpage.ts";
import { type SnapshotRequest, SnapshotResultSchema } from "./outline.inpage.ts";
import { FindResultSchema } from "./subjects.inpage.ts";
import { type TextRequest, TextResultSchema } from "./text.inpage.ts";

// A pattern crosses into the page as its source and flags.
const wanted = (value: string | RegExp | undefined): Wanted | null =>
  value === undefined
    ? null
    : typeof value === "string"
      ? value
      : { source: value.source, flags: value.flags };

export const make = Effect.fnUntraced(function* (
  page: PageContext,
  bridge: Bridge,
  screenshot: () => Effect.Effect<Image, BrowserError>,
) {
  const { settings, now, span, owned } = page;
  const { evaluate } = bridge;
  // Refs count up across the page's documents, so one never names two elements.
  const nextRef = yield* Ref.make(1);
  const counted = (next: number) => Ref.update(nextRef, (current) => Math.max(current, next));

  const bounded = (operation: string) =>
    Effect.timeoutOrElse({
      duration: settings.actionTimeout,
      orElse: () =>
        failWith(operation, new Timeout({ millis: Duration.toMillis(settings.actionTimeout) })),
    });

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

      yield* counted(result.nextRef);
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
      bounded("snapshot"),
      span("Page.snapshot", { full: snapshotOptions.full ?? false }),
      owned,
    );

  const find = (query: FindQuery = {}) =>
    Effect.gen(function* () {
      const request: FindRequest = {
        role: query.role ?? null,
        name: wanted(query.name),
        text: wanted(query.text),
        near: query.near ?? null,
        scope: query.scope ?? "viewport",
        firstRef: yield* Ref.get(nextRef),
      };

      const result = yield* evaluate("find", scriptCall("find", request)).pipe(
        Effect.flatMap(decodeWith("find", FindResultSchema)),
      );

      yield* counted(result.nextRef);
      yield* Effect.annotateCurrentSpan({ found: result.found.length });

      return result.found.map(
        ({ ref, role, name, tag, context, box, inViewport, state }) =>
          new Found({
            ref,
            subject: new Subject({ role, name, tag, context }),
            box,
            inViewport,
            state,
          }),
      );
    }).pipe(
      bounded("find"),
      // The query's words are the caller's, and may be anything; only its shape is traced.
      span("Page.find", { scope: query.scope ?? "viewport", role: query.role ?? "" }),
      owned,
    );

  const text = (options: TextOptions = {}) => {
    const scope = options.scope ?? "viewport";

    return Effect.gen(function* () {
      if (scope !== "viewport" && !/^e\d+$/.test(scope))
        return yield* failWith(
          "text",
          new InvalidRequest({ detail: `${scope} is neither "viewport" nor a ref such as e12` }),
        );

      const request: TextRequest = {
        ref: scope === "viewport" ? null : scope,
        maxChars: options.maxChars ?? 12_000,
        unmask: options.unmask ?? false,
      };

      const result = yield* evaluate("text", scriptCall("text", request)).pipe(
        Effect.flatMap(decodeWith("text", TextResultSchema)),
      );

      if ("error" in result) return yield* failWith("text", new StaleRef({ ref: scope }));
      yield* Effect.annotateCurrentSpan({ chars: result.text.length, truncated: result.truncated });

      return new Text({ ...result, at: now() });
    }).pipe(
      bounded("text"),
      span("Page.text", { scope: scope === "viewport" ? "viewport" : "ref" }),
      owned,
    );
  };

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

  const waitForText = (text: string, timeout: Duration.Input = Duration.seconds(10)) =>
    find({ text, scope: "document" }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(Duration.millis(250)),
        until: (found) => found.length > 0,
      }),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => failWith("waitForText", new NotFound({ target: JSON.stringify(text) })),
      }),
      Effect.asVoid,
      span("Page.waitForText"),
      owned,
    );

  return { snapshot, find, text, observe, waitForText };
});

export type Reading = Effect.Success<ReturnType<typeof make>>;
