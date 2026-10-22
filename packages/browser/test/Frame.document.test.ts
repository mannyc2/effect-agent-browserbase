import { assert, it } from "@effect/vitest";
// Document identity remains authoritative even when a transport's paint clock looks newer.
import { Effect, Fiber, Schedule, Stream } from "effect";

import { make as makeBrowser } from "../src/Browser.ts";
import type { BrowserError } from "../src/BrowserError.ts";
import type { Frame, Image } from "../src/Frame.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import { Site, SiteLayer } from "./fixtures.ts";
import * as TestCdp from "./support/TestCdp.ts";

it.live("a cached frame from the prior document cannot win on its clock stamp", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const host = yield* Chromium.open();
      const context = TestCdp.nativeContext(host);
      const faults = yield* TestCdp.make();

      faults.rule(
        { method: "Runtime.evaluate", operation: "calibrate" },
        {
          _tag: "Transform",
          reply: (value) => {
            const reply = value as { result: { value: number } };

            return { ...reply, result: { ...reply.result, value: reply.result.value - 2000 } };
          },
        },
        { phase: "after" },
      );

      const browser = yield* faults.provide(
        makeBrowser(context, { id: "document-clock", provider: "test" }),
      );

      const site = yield* Site;
      const page = yield* browser.newPage(site.url("/spinning"));
      const frames: Array<Frame> = [];

      const capture = yield* page.screencast().pipe(
        Stream.runForEach((frame) => Effect.sync(() => void frames.push(frame))),
        Effect.forkScoped,
      );

      yield* Effect.sync(() => frames.length).pipe(
        Effect.repeat({ until: (count) => count > 0, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout("5 seconds"),
      );
      faults.rule(
        { method: "Page.screencastFrame" },
        { _tag: "Drop", acknowledge: true },
        { phase: "event" },
      );
      const old = frames.at(-1)!;

      yield* page.goto(site.url("/late"));
      const state = yield* page.state;

      assert.isBelow(old.document, state.document);
      assert.isAbove(old.hostTime - old.timing.uncertaintyMillis, state.committedAt ?? 0);

      const reads: ReadonlyArray<Effect.Effect<Image, BrowserError>> = [
        page.screenshot(),
        Effect.map(page.frame(), (frame) => frame.image),
      ];

      for (const read of reads) {
        const picture = yield* read;

        const [red, blue] = yield* Effect.promise(() =>
          TestCdp.nativePage(page).evaluate(
            async (source) => {
              const image = new window.Image();

              image.src = source;
              await image.decode();
              const canvas = document.createElement("canvas");
              const context = canvas.getContext("2d")!;

              context.drawImage(image, 0, 0);
              const pixel = context.getImageData(20, 20, 1, 1).data;

              return [pixel[0]!, pixel[2]!] as const;
            },
            `data:image/jpeg;base64,${Buffer.from(picture.data).toString("base64")}`,
          ),
        );

        assert.isTrue(red < 80 && blue > 180, `the image was ${red}, _, ${blue}`);
      }
      yield* Fiber.interrupt(capture);
    }).pipe(Effect.provide(SiteLayer)),
  ),
);
