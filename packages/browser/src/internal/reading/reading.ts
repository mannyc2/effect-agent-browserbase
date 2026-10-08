/**
 * Reading a page: its outline with refs, the elements a query finds, the text it shows, and an
 * observation that pairs the outline with a picture. Each read takes its turn on the page and
 * shares its work with identical reads, as `lane.ts` describes. The viewport's text as it was last
 * read is kept, for `Page.state`.
 */
import { Duration, Effect, Option, Ref, Result, Schema } from "effect";

import { type BrowserError, InvalidRequest, NotFound, StaleRef } from "../../BrowserError.ts";
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
import { contextGone, decodeWith, failWith, type PageContext } from "../page/context.ts";
import * as Url from "../page/url.ts";
import type { FindRequest, Wanted } from "./match.inpage.ts";
import type { SnapshotRequest } from "./outline.inpage.ts";
import { type TextRequest, TextResultSchema } from "./text.inpage.ts";

// What `snapshot` and `find` read back, each with the next ref the page may give.
const SnapshotResult = Schema.Struct({ snapshot: Snapshot, nextRef: Schema.Finite });
const FindResults = Schema.Struct({ found: Schema.Array(Found), nextRef: Schema.Finite });

// A pattern crosses into the page as its source and flags.
const wanted = (value: string | RegExp | undefined): Wanted | null =>
  value === undefined
    ? null
    : typeof value === "string"
      ? value
      : { source: value.source, flags: value.flags };

// One part of an observation: how its read went, or nothing when it was not asked for.
const part = <A>(asked: boolean, read: () => Effect.Effect<A, BrowserError>) =>
  asked ? Effect.asSome(Effect.result(read())) : Effect.succeedNone;

const succeeded = <A>(part: Option.Option<Result.Result<A, BrowserError>>) =>
  Option.getOrUndefined(Option.flatMap(part, Result.getSuccess));

const failed = <A>(part: Option.Option<Result.Result<A, BrowserError>>) =>
  Option.toArray(Option.flatMap(part, Result.getFailure));

export const make = Effect.fnUntraced(function* (
  page: PageContext,
  bridge: Bridge,
  screenshot: () => Effect.Effect<Image, BrowserError>,
) {
  const { now, span, owned, within, lane } = page;
  const { evaluate } = bridge;
  // Refs count up across the page's documents, so one never names two elements.
  const nextRef = yield* Ref.make(1);
  const counted = (next: number) => Ref.update(nextRef, (current) => Math.max(current, next));
  const snapshots = lane.shared<Snapshot>("snapshot", true);
  const finds = lane.shared<ReadonlyArray<Found>>("find", true);
  const texts = lane.shared<Text>("text", true);
  let viewed: Text | undefined;

  const snapshot = (snapshotOptions: SnapshotOptions = {}) => {
    const asked = {
      full: snapshotOptions.full ?? false,
      query: snapshotOptions.query ?? null,
      maxChars: snapshotOptions.maxChars ?? 12_000,
    };

    return snapshots(
      JSON.stringify(asked),
      Effect.gen(function* () {
        const request: SnapshotRequest = { ...asked, firstRef: yield* Ref.get(nextRef) };

        const result = yield* evaluate("snapshot", scriptCall("snapshot", request)).pipe(
          Effect.flatMap(decodeWith("snapshot", SnapshotResult)),
        );

        const { text, truncated, url } = result.snapshot;

        yield* counted(result.nextRef);
        yield* Effect.annotateCurrentSpan({ chars: text.length, truncated });

        return new Snapshot({ ...result.snapshot, url: Url.redact(url) });
      }).pipe(within("snapshot")),
    ).pipe(span("Page.snapshot", { full: asked.full }), owned);
  };

  const find = (query: FindQuery = {}) => {
    const asked = {
      role: query.role ?? null,
      name: wanted(query.name),
      text: wanted(query.text),
      near: query.near ?? null,
      at: query.at ?? null,
      scope: query.scope ?? "viewport",
    };

    return finds(
      JSON.stringify(asked),
      Effect.gen(function* () {
        const request: FindRequest = { ...asked, firstRef: yield* Ref.get(nextRef) };

        const result = yield* evaluate("find", scriptCall("find", request)).pipe(
          Effect.flatMap(decodeWith("find", FindResults)),
        );

        yield* counted(result.nextRef);
        yield* Effect.annotateCurrentSpan({ found: result.found.length });

        return result.found;
      }).pipe(within("find")),
    ).pipe(
      // The query's words are the caller's, and may be anything; only its shape is traced.
      span("Page.find", { scope: asked.scope, role: asked.role ?? "" }),
      owned,
    );
  };

  const text = (options: TextOptions = {}) => {
    const scope = options.scope ?? "viewport";

    const request: TextRequest = {
      ref: scope === "viewport" ? null : scope,
      maxChars: options.maxChars ?? 12_000,
      unmask: options.unmask ?? false,
    };

    return (
      scope !== "viewport" && !/^e\d+$/.test(scope)
        ? failWith(
            "text",
            new InvalidRequest({ detail: `${scope} is neither "viewport" nor a ref such as e12` }),
          )
        : texts(
            JSON.stringify(request),
            Effect.gen(function* () {
              const result = yield* evaluate("text", scriptCall("text", request)).pipe(
                Effect.flatMap(decodeWith("text", TextResultSchema)),
              );

              if (result === null) return yield* failWith("text", new StaleRef({ ref: scope }));
              yield* Effect.annotateCurrentSpan({
                chars: result.text.length,
                truncated: result.truncated,
              });
              const shown = new Text({ ...result, url: Url.redact(result.url), at: now() });

              if (request.ref === null) viewed = shown;

              return shown;
            }).pipe(within("text")),
          )
    ).pipe(span("Page.text", { scope: scope === "viewport" ? "viewport" : "ref" }), owned);
  };

  // What could be read, each part apart, and why the rest could not; a failure only when nothing
  // asked for could be read.
  const observe = (
    observeOptions: {
      readonly mode?: ObservationMode;
      readonly full?: boolean;
      readonly maxChars?: number;
    } = {},
  ) =>
    Effect.all(
      [
        part(observeOptions.mode !== "screenshot", () =>
          snapshot({ full: observeOptions.full, maxChars: observeOptions.maxChars }),
        ),
        part(observeOptions.mode !== "outline", () => screenshot()),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.flatMap(([outline, picture]) => {
        const read = { snapshot: succeeded(outline), image: succeeded(picture) };
        const missing = [...failed(outline), ...failed(picture)];
        const [first] = missing;

        return read.snapshot === undefined && read.image === undefined && first !== undefined
          ? Effect.fail(first)
          : Effect.succeed(new Observation({ ...read, missing, at: now() }));
      }),
      span("Page.observe", { mode: observeOptions.mode ?? "both" }),
      owned,
    );

  // One call, which the page answers once `find` matches the text or at the deadline. It follows the
  // action in flight, as a read does, but holds no later one back while it waits, and it waits on
  // in a document that replaces the one it began in.
  const waitForText = (text: string, timeout: Duration.Input = Duration.seconds(10)) => {
    const missing = () => failWith("waitForText", new NotFound({ target: JSON.stringify(text) }));

    const look = Effect.gen(function* () {
      const request: FindRequest = {
        role: null,
        name: null,
        text,
        near: null,
        at: null,
        scope: "document",
        firstRef: yield* Ref.get(nextRef),
      };

      // JSON has no infinity; the deadline here ends a wait without one in any case.
      const millis = Math.min(Duration.toMillis(timeout), Number.MAX_SAFE_INTEGER);

      const result = yield* evaluate(
        "waitForText",
        scriptCall("waitForText", request, millis),
      ).pipe(Effect.flatMap(decodeWith("waitForText", FindResults)));

      yield* counted(result.nextRef);
      if (result.found.length === 0) return yield* missing();
    });

    return lane
      .read("waitForText")(Effect.void)
      .pipe(
        Effect.andThen(Effect.retry(look, { while: contextGone })),
        Effect.timeoutOrElse({ duration: timeout, orElse: missing }),
        span("Page.waitForText"),
        owned,
      );
  };

  /** The viewport's text as it was last read, if after `since`, as a document began. */
  const viewedSince = (since: number) =>
    viewed !== undefined && viewed.at > since ? viewed : undefined;

  return { snapshot, find, text, observe, waitForText, viewedSince };
});

export type Reading = Effect.Success<ReturnType<typeof make>>;
