/**
 * Reading a page: its outline with refs, the elements a query finds and the text it shows. Each
 * read takes its turn on the page and shares its work with identical reads, as `lane.ts`
 * describes. The viewport's text as it was last read is kept, for `Page.state`.
 */
import { Duration, Effect, Schedule, Schema } from "effect";

import { StaleRef } from "../../BrowserError.ts";
import { request as askedOf, type FindRequest } from "../../Matching.ts";
import { type FindQuery, Found, Text, type TextOptions } from "../../Page.ts";
import { Snapshot, type SnapshotOptions } from "../../Snapshot.ts";
import * as Url from "../../Url.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { contextGone, decodeWith, failWith, type PageContext, refuse } from "../page/context.ts";
import type { Want } from "./expect.inpage.ts";
import { type SnapshotRequest, SnapshotResultSchema } from "./outline.inpage.ts";
import { type TextRequest, TextResultSchema } from "./text.inpage.ts";

// What `find` reads back. The bridge envelope owns ref allocation across documents.
const FindResults = Schema.Union([
  Schema.Struct({ found: Schema.Array(Found) }),
  Schema.Struct({ invalid: Schema.String }),
]);

const UntilResult = Schema.Union([
  Schema.Struct({ met: Schema.Boolean, mark: Schema.String }),
  Schema.Struct({ invalid: Schema.String }),
]);

export const make = (page: PageContext, bridge: Bridge) =>
  Effect.sync(() => {
    const { now, span, owned, within, lane } = page;
    const { evaluate } = bridge;
    const snapshots = lane.shared<Snapshot>("snapshot", true);
    const finds = lane.shared<ReadonlyArray<Found>>("find", true);
    const texts = lane.shared<Text>("text", true);
    let viewed: Text | undefined;

    const snapshot = (snapshotOptions: SnapshotOptions = {}) => {
      const asked = {
        full: snapshotOptions.full ?? false,
        query: snapshotOptions.query ?? null,
        within: snapshotOptions.within ?? null,
        maxChars: snapshotOptions.maxChars ?? 12_000,
        boxes: snapshotOptions.boxes ?? false,
      };

      return snapshots(
        JSON.stringify(asked),
        Effect.gen(function* () {
          const request: SnapshotRequest = asked;

          const result = yield* evaluate("snapshot", scriptCall("snapshot", request)).pipe(
            Effect.flatMap(decodeWith("snapshot", SnapshotResultSchema)),
          );

          if ("invalid" in result) return yield* refuse("snapshot", result.invalid);
          const { text, truncated, url } = result.snapshot;

          yield* Effect.annotateCurrentSpan({ chars: text.length, truncated });

          return new Snapshot({ ...result.snapshot, url: Url.redact(url) });
        }).pipe(within("snapshot")),
      ).pipe(span("Page.snapshot", { full: asked.full }), owned);
    };

    const find = (query: FindQuery = {}) => {
      const asked = askedOf(query, "viewport");

      return finds(
        JSON.stringify(asked),
        Effect.gen(function* () {
          const request: FindRequest = asked;

          const result = yield* evaluate("find", scriptCall("find", request)).pipe(
            Effect.flatMap(decodeWith("find", FindResults)),
          );

          if ("invalid" in result) return yield* refuse("find", result.invalid);

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
          ? refuse("text", `${scope} is neither "viewport" nor a ref such as e12`)
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

    // One call, which the page answers once `want` holds of what `query` matches, the whole document
    // unless it says otherwise, or at the deadline, with the mark of what matched then. It follows
    // the action in flight, and the page has the action timeout past the deadline
    // to answer.
    const until = (query: FindQuery, want: Want, millis: number) => {
      if (!Number.isFinite(millis) || millis < 0)
        return refuse("until", "the wait duration must be finite and nonnegative");

      const look = Effect.gen(function* () {
        const deadline = now() + millis;
        const request: FindRequest = askedOf(query, "document");

        return yield* Effect.suspend(() =>
          evaluate("expect", scriptCall("until", request, want, Math.max(0, deadline - now()))),
        ).pipe(
          Effect.flatMap(decodeWith("expect", UntilResult)),
          Effect.filterOrElse(
            (result) => "met" in result,
            (result) => refuse("expect", result.invalid),
          ),
          Effect.retry({
            while: (error) => contextGone(error) && now() < deadline,
            schedule: Schedule.spaced("10 millis"),
          }),
          // No stable document answered by this deadline. An unmet verdict carries no sampled
          // mark; a zero-window baseline still fails rather than inventing comparison evidence.
          Effect.catchIf(
            (error) => millis > 0 && contextGone(error) && now() >= deadline,
            () => Effect.succeed({ met: false, mark: "" }),
          ),
        );
      });

      return lane
        .read("expect")(Effect.void)
        .pipe(
          Effect.andThen(look),
          within("expect", Duration.sum(Duration.millis(millis), page.settings.actionTimeout)),
          span("Page.expect", { want: typeof want === "string" ? want : "other" }),
          owned,
        );
    };

    /** The viewport's text as it was last read, if after `since`, as a document began. */
    const viewedSince = (since: number) =>
      viewed !== undefined && viewed.at > since ? viewed : undefined;

    return { snapshot, find, text, until, viewedSince };
  });

export type Reading = Effect.Success<ReturnType<typeof make>>;
