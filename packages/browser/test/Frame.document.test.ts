// Document identity remains authoritative even when a transport's paint clock looks newer.
import type { EventEmitter } from "node:events";

import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Schedule, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { make as makeBrowser } from "../src/Browser.ts";
import type { BrowserError } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Frame, Image } from "../src/Frame.ts";
import { Site, SiteLayer } from "./fixtures.ts";

it.live("a cached frame from the prior document cannot win on its clock stamp", () =>
  Effect.gen(function* () {
    const host = yield* Chromium.open();
    const context = host.context;
    const create = context.newCDPSession.bind(context);
    let withhold = false;

    context.newCDPSession = async (target) => {
      const cdp = await create(target);
      const send = cdp.send.bind(cdp);

      const shifted: CDPSession["send"] = async (method, params) => {
        const result = await send(method, params);

        if (
          method === "Runtime.evaluate" &&
          (params as { expression?: string } | undefined)?.expression ===
            "performance.timeOrigin + performance.now()"
        ) {
          // Plant a clock-domain mismatch. Identity must refuse these actual old JPEG pixels
          // even when the calibrated time falsely places their paint after the next commit.
          const reply = result as { result: { value: unknown } };

          if (typeof reply.result.value === "number") reply.result.value -= 2000;
        }

        return result;
      };

      cdp.send = shifted;
      const events = cdp as unknown as EventEmitter;
      const emit = events.emit.bind(events);

      events.emit = (event, ...args) =>
        event === "Page.screencastFrame" && withhold ? true : emit(event, ...args);

      return cdp;
    };
    const browser = yield* makeBrowser(context, { id: "document-clock", provider: "test" });
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
    withhold = true;
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
        page.playwright.evaluate(
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
);
