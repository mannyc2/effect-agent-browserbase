/**
 * Reading a page's record of what changed, in one call to the page. The first read also registers
 * the recorder with the page's own session, in the same round trip, so that every later document
 * records from its start. The page's times map to the owner's clock through the browser's one
 * clock mapping, as frames' do, and a window can begin on the page's own clock where the previous
 * one ended, so consecutive reads neither miss nor repeat a change.
 */
import { Effect, Schema } from "effect";

import type { BrowserError } from "../../BrowserError.ts";
import { Subject } from "../../BrowserEvent.ts";
import { Change, Changes } from "../../Change.ts";
import type { Frame } from "../../Frame.ts";
import type { ChangesOptions } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, type PageContext } from "../page/context.ts";
import * as BrowserClock from "../pictures/clock.ts";
import { type ChangesRequest, ChangesResultSchema } from "./changes.inpage.ts";

const isChanges = Schema.is(Changes);

export const make =
  (
    page: PageContext,
    bridge: Bridge,
    estimate: Effect.Effect<BrowserClock.Estimate, BrowserError>,
  ) =>
  (options: ChangesOptions = {}) =>
    Effect.gen(function* () {
      const mapping = yield* estimate;
      const host = (epoch: number) => BrowserClock.toHostTime(mapping, epoch);

      // A frame's paint is on the page's clock already; a screenshot has only its host time.
      const onPage = (time: Frame | number) =>
        typeof time === "number"
          ? time + mapping.offsetMillis
          : (time.timestamp ?? time.hostTime + mapping.offsetMillis);

      const request: ChangesRequest = {
        since:
          options.since === undefined
            ? null
            : isChanges(options.since)
              ? options.since.cursor
              : onPage(options.since),
        until: options.until === undefined ? null : onPage(options.until),
        unmask: options.unmask ?? false,
      };

      const [, result] = yield* Effect.all(
        [
          bridge.registerRecorder("changes"),
          bridge
            .evaluate("changes", scriptCall("changes", request))
            .pipe(Effect.flatMap(decodeWith("changes", ChangesResultSchema))),
        ],
        { concurrency: "unbounded" },
      );

      yield* Effect.annotateCurrentSpan({
        changes: result.records.length,
        dropped: result.dropped,
      });

      return new Changes({
        document: bridge.frameTag().document,
        from: host(result.from),
        until: host(result.until),
        cursor: result.until,
        dropped: result.dropped,
        changes: result.records.map(
          (one) =>
            new Change({
              kind: one.kind,
              subject: new Subject({
                role: one.role,
                name: one.name,
                tag: one.tag,
                context: one.context,
              }),
              startedAt: host(one.startedAt),
              at: host(one.at),
              before: one.before ?? undefined,
              after: one.after ?? undefined,
              count: one.count,
              lowest: one.lowest ?? undefined,
              highest: one.highest ?? undefined,
              earlier: one.earlier === null ? undefined : host(one.earlier),
              cause: one.cause === null ? undefined : host(one.cause),
            }),
        ),
      });
    }).pipe(page.within("changes"), page.span("Page.changes"), page.owned);
