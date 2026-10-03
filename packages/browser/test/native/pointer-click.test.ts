import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Schedule } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as BrowserRuntime from "effect-browser/browser-runtime";
import { Chromium } from "effect-browser/chromium";
import * as Plan from "effect-browser/plan";
import { DefaultMotionProfile } from "effect-browser/plan-data";
import type { Browser as PlaywrightBrowser } from "playwright-core";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly url: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          if (request.url === "/canvas")
            response.end(`<!doctype html><body style="margin:0"><canvas width="300" height="180"></canvas><p id="count">0</p><p id="events">[]</p><script>
const canvas = document.querySelector('canvas');
const seen = [];
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu']) canvas.addEventListener(type, event => {
  seen.push({ type, trusted: event.isTrusted, x: event.clientX, y: event.clientY, button: event.button, detail: event.detail });
  events.textContent = JSON.stringify(seen);
  if (type === 'click') count.textContent = String(Number(count.textContent) + 1);
  if (type === 'contextmenu') event.preventDefault();
});
</script>`);
          else {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;

            response.end(
              `<!doctype html><body style="margin:0"><iframe style="position:absolute;left:80px;top:100px;width:360px;height:220px;border:0" src="http://localhost:${String(port)}/canvas"></iframe>`,
            );
          }
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;

          resolve({ url: `http://127.0.0.1:${String(port)}/`, close: () => server.close() });
        });
      }),
  ),
  (site) => Effect.sync(site.close),
);

const layer = Chromium.layer({
  launch: {
    chromiumSandbox: false,
    ...(process.env.BROWSERBASE_CHROMIUM === undefined
      ? {}
      : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
  },
  viewport: { width: 640, height: 480 },
}).pipe(Layer.provide(NodeCrypto.layer));

for (const style of ["plain", "performed"] as const)
  it.live(`real Chromium: ten ${style} point clicks reach a canvas in a cross-site Frame`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* site;

        const browser = yield* Chromium.launch(
          BrowserPolicy.unrestricted({ maxActions: 1000, maxElapsedMillis: 60000 }),
        );

        const page = browser.initialPage;

        yield* page.navigate({ url: fixture.url });

        const info = yield* page.listFrames().pipe(
          Effect.map((frames) => frames.find((frame) => frame.url.endsWith("/canvas"))),
          Effect.filterOrFail(Predicate.isNotUndefined, () => "canvas frame not loaded yet"),
          Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
        );

        const child = yield* page.frame(info);

        expect((yield* child.readText({ selector: "#count" })).text).toBe("0");
        const at = { x: 120, y: 150 };

        yield* page.pointerMove({ to: { x: 10, y: 10 } });
        for (let spin = 0; spin < 10; spin++) {
          const ran = yield* child.run(
            { version: 1, steps: [{ id: "spin", action: { _tag: "PointerClick", at } }] },
            style === "plain"
              ? {}
              : {
                  style: {
                    seed: spin,
                    motion: {
                      ...DefaultMotionProfile,

                      pointer: {
                        ...DefaultMotionProfile.pointer,
                        duration: { minMillis: 80, maxMillis: 80 },
                      },
                    },
                  },
                },
          );

          expect(ran.steps[0]?.receipt).toMatchObject({
            kind: "click",
            position: at,
            target: child.identity,
            hitTest: { backendNodeId: expect.any(Number), frameId: expect.any(String) },
          });
          expect((yield* Plan.recorded(ran)).steps[0]?.action).toEqual({
            _tag: "PointerClick",
            at,
          });
        }
        expect((yield* child.readText({ selector: "#count" })).text).toBe("10");

        const events: ReadonlyArray<{
          readonly type: string;
          readonly trusted: boolean;
          readonly x: number;
          readonly y: number;
        }> = JSON.parse((yield* child.readText({ selector: "#events" })).text);

        expect(events.filter((event) => event.type === "click")).toHaveLength(10);
        expect(events.every((event) => event.trusted)).toBe(true);
        expect(
          events
            .filter((event) => event.type === "click")
            .every((event) => event.x === 40 && event.y === 50),
        ).toBe(true);
        const timeline = (yield* page.timeline.snapshot()).events;

        expect(timeline.filter((event) => event.event._tag === "Press")).toHaveLength(10);
        if (style === "performed") {
          expect(timeline.some((event) => event.event._tag === "Glide")).toBe(true);
          expect(events.filter((event) => event.type === "pointermove").length).toBeGreaterThan(1);
        }
        yield* page.pointerClick({ ...at, button: "right" });
        yield* page.pointerClick({ ...at, clickCount: 2 });
        expect((yield* child.readText({ selector: "#count" })).text).toBe("12");
        expect((yield* child.readText({ selector: "#events" })).text).toContain(
          '"type":"dblclick"',
        );
        expect((yield* child.readText({ selector: "#events" })).text).toContain(
          '"type":"contextmenu"',
        );
      }).pipe(Effect.provide(layer)),
    ),
  );

it.live("real Chromium: a point press submits down/up before awaiting their acknowledgements", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* site;
      const host = yield* externalChromium;
      let releaseDown = () => {};

      const downReply = new Promise<void>((resolve) => {
        releaseDown = resolve;
      });

      const runtime = yield* BrowserRuntime.make({
        implementation: "point-press-acknowledgements",
        binding: BrowserRuntime.playwright({
          onConnected: ({ native }) => {
            const page = (native as PlaywrightBrowser).contexts()[0]?.pages()[0];

            if (page === undefined) throw new Error("No native initial page");
            const down = page.mouse.down.bind(page.mouse);
            const up = page.mouse.up.bind(page.mouse);

            // Real input lands in Chromium; only delivery of the down's reply is held.
            page.mouse.down = (options) => down(options).then(() => downReply);
            page.mouse.up = (options) => up(options).then(releaseDown);
          },
        }),
      }).pipe(Effect.provide(NodeCrypto.layer));

      const acquired = yield* runtime.acquire(
        BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        (cleanup) =>
          Effect.gen(function* () {
            const release = yield* Effect.cached(
              cleanup.fence.pipe(
                Effect.andThen(cleanup.capture),
                Effect.andThen(cleanup.initialization),
                Effect.andThen(cleanup.disconnect),
                Effect.orDie,
                Effect.asVoid,
              ),
            );

            yield* Effect.addFinalizer(() => release);

            return {
              reference: "point-press-acknowledgements",
              connection: () => Effect.succeed(host.endpoint),
              release,
              cleanupResult: Effect.succeedNone,
              closeChecked: release,
            };
          }),
      );

      const { session } = yield* acquired.connect;
      const page = session.initialPage;

      yield* page.navigate({ url: `${fixture.url}canvas` });
      expect((yield* page.pointerClick({ x: 40, y: 50 })).position).toEqual({ x: 40, y: 50 });
      expect((yield* page.readText({ selector: "#count" })).text).toBe("1");
      expect((yield* page.readText({ selector: "#events" })).text).toContain('"type":"pointerup"');
    }),
  ),
);
