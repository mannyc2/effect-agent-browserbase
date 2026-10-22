// Provider viewport growth must not leave the shared native capture permanently scaled down.
import { assert, it } from "@effect/vitest";
import { Effect, Schedule, Stream } from "effect";

import * as Chromium from "../src/providers/Chromium.ts";
import * as TestCdp from "./support/TestCdp.ts";

it.live("an implicit capture follows viewport growth beyond its initial cap", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const browser = yield* Chromium.open({ viewport: { width: 400, height: 300 } });

      const page = yield* browser.newPage(
        "data:text/html,<body><script>setInterval(()=>document.body.style.background=`hsl(${Date.now()%360} 80%25 50%25)`,30)</script>",
      );

      const first = yield* page.capture();

      yield* first.stream.pipe(Stream.take(1), Stream.runDrain);
      yield* Effect.promise(() =>
        TestCdp.nativePage(page).setViewportSize({ width: 800, height: 600 }),
      );

      const grown = yield* page.recentFrames.pipe(
        Effect.map((frames) => frames.find((frame) => frame.width === 800 && frame.height === 600)),
        Effect.repeat({
          until: (value) => value !== undefined,
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("3 seconds"),
      );

      assert.isDefined(grown);
      const joining = yield* page.capture({ size: { width: 800, height: 600 } });

      assert.strictEqual(joining.current?.width, 800);
    }).pipe(Effect.scoped),
  ),
);
