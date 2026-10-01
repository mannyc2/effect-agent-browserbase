import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Testing from "../src/Testing.ts";

const origin = "https://journal.test";
// A host address long enough that its Navigated event exceeds the smallest per-event budget.
const long = `${origin}/${"a".repeat(3000)}`;

const script: Testing.Script = {
  documents: [
    { url: `${origin}/`, title: "Journal", text: "Evidence." },
    { url: long, title: "Long", text: "A long address." },
  ],
};

it.effect("a refused event leaves an attributed omission in its Page's view", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script, {
        automation: {
          timelineLimits: {
            maxDurationMillis: 60_000,
            maxEvents: 4096,
            maxBytes: 4 * 1024 * 1024,
            maxSubscribers: 32,
            maxEventBytes: 2048,
          },
        },
      });

      const page = browser.initialPage;

      yield* page.navigate({ url: long });

      const omitted = (yield* page.timeline.snapshot()).events.filter(
        (event) => event.event._tag === "MetadataOmitted",
      );

      expect(omitted).toMatchObject([
        {
          target: { pageId: page.identity.pageId, generation: page.identity.generation },
          event: { _tag: "MetadataOmitted", reason: "Oversized", originalTag: "Navigated" },
        },
      ]);
    }),
  ),
);
