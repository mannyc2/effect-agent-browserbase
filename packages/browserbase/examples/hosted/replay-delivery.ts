import { Effect, Stream } from "effect";
// H7, narrowed: does a recorded session's replay arrive through the artifactOrigins check, and
// how is its recording delivered? The playlist is validated and one media segment is fetched.
// Whatever delivery the provider reports is recorded as observed, so a BYOS project reads as
// BYOS rather than as a failed download. Logging, retention and expiry stay open.
import { NavigateRequest } from "effect-browserbase/browser-data";
import { recipe } from "effect-browserbase/launch";
import { BrowserbaseRecordings } from "effect-browserbase/recordings";
import { BrowserbaseReplays } from "effect-browserbase/replays";
import { RecordingPageReference } from "effect-browserbase/transfers";

import { hostedCase } from "./harness.ts";

const h = hostedCase("replay-delivery");

const recorded = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* h.open();

    yield* session.bind().navigate(NavigateRequest.make({ url: "https://example.com/" }));
    yield* session.bind().scroll({ deltaX: 0, deltaY: 400 });
    const cleanup = yield* session.close;

    return { reference: session.reference, cleanup };
  }).pipe(
    Effect.provide(
      h.browser({ launch: recipe({ provider: { browserSettings: { recordSession: true } } }) }),
    ),
  ),
);

await h.run(
  Effect.gen(function* () {
    const { reference, cleanup } = yield* recorded;
    const recordings = yield* BrowserbaseRecordings;
    const replays = yield* BrowserbaseReplays;

    yield* recordings.request(reference);

    const completed = yield* recordings.wait(reference, {
      timeoutMillis: 120_000,
      intervalMillis: 3_000,
    });

    const pages = yield* replays.metadata(reference);
    const first = pages[0];
    let replay: { pageId: string; mediaCount: number; firstSegmentBytes: number } | null = null;

    if (first !== undefined) {
      const access = yield* replays.openPage(
        RecordingPageReference.make({ session: reference, pageId: first.pageId }),
      );

      const segment = yield* access
        .media(0, { maxBytes: h.budget.transferBytes, timeoutMillis: 60_000 })
        .pipe(Stream.runCollect);

      replay = {
        pageId: first.pageId,
        mediaCount: access.mediaCount,
        firstSegmentBytes: Array.from(segment).reduce(
          (total, chunk) => total + chunk.byteLength,
          0,
        ),
      };
    }

    yield* h.established({
      replay: replay !== null && replay.firstSegmentBytes > 0,
    });

    return {
      reference,
      cleanup,
      recording: {
        timedOut: completed.timedOut,
        delivery: completed.pages.map((page) => ({
          pageId: page.pageId,
          status: page.status,
          delivery: page.delivery,
        })),
      },
      replayPages: pages.length,
      replay,
    };
  }),
);
