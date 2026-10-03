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
          const route = new URL(request.url ?? "/", "http://fixture");

          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          if (route.pathname === "/canvas")
            response.end(`<!doctype html><body style="margin:0"><canvas width="300" height="180"></canvas><p id="count">0</p><p id="events">[]</p><script>
const canvas = document.querySelector('canvas');
const seen = [];
let redirecting = false;
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu']) canvas.addEventListener(type, event => {
  seen.push({ type, trusted: event.isTrusted, x: event.clientX, y: event.clientY, button: event.button, detail: event.detail });
  events.textContent = JSON.stringify(seen);
  if (type === 'click') count.textContent = String(Number(count.textContent) + 1);
  if (type === 'contextmenu') event.preventDefault();
  if (${String(route.searchParams.has("redirect"))} && !redirecting && type === 'pointermove' && event.clientX !== 10) {
    redirecting = true;
    console.log('trusted-path:' + JSON.stringify({ x: event.clientX, y: event.clientY, trusted: event.isTrusted }));
    location.replace('/canvas');
  }
});
</script>`);
          else {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;

            response.end(
              `<!doctype html><body style="margin:0"><button id="parent" style="position:absolute;left:500px;top:30px" onclick="parentCount.textContent=String(Number(parentCount.textContent)+1)">Parent action</button><output id="parentCount">0</output><iframe style="position:absolute;left:80px;top:100px;width:360px;height:220px;border:0" src="http://localhost:${String(port)}/canvas"></iframe>`,
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

const instrumentedSession = Effect.fn(function* (
  onConnected: (browser: PlaywrightBrowser) => void,
) {
  const host = yield* externalChromium;

  const runtime = yield* BrowserRuntime.make({
    implementation: "native-pointer-outcome",
    binding: BrowserRuntime.playwright({
      onConnected: ({ native }) => onConnected(native as PlaywrightBrowser),
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
          reference: "native-pointer-outcome",
          connection: () => Effect.succeed(host.endpoint),
          release,
          cleanupResult: Effect.succeedNone,
          closeChecked: release,
        };
      }),
  );

  return (yield* acquired.connect).session;
});

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
          const ran = yield* page.run(
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
            target: page.identity,
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

for (const style of ["plain", "performed"] as const)
  it.live(
    `Frame coordinate clicks are unsupported before ${style} native input reaches any document`,
    () =>
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

          yield* page.screenshot({ fullPage: false });
          for (const at of [
            { x: 540, y: 45 },
            { x: 120, y: 150 },
          ]) {
            const failure = yield* child
              .run(
                { version: 1, steps: [{ id: "point", action: { _tag: "PointerClick", at } }] },
                style === "plain" ? {} : { style: { seed: 1, motion: DefaultMotionProfile } },
              )
              .pipe(Effect.result);

            expect((yield* page.readText({ selector: "#parentCount" })).text).toBe("0");
            expect(failure).toMatchObject({
              _tag: "Failure",
              failure: { error: { reason: { _tag: "Unsupported" }, outcome: "undispatched" } },
            });
          }
          expect(yield* child.pointerClick({ x: 540, y: 45 }).pipe(Effect.flip)).toMatchObject({
            reason: { _tag: "Unsupported" },
            outcome: "undispatched",
          });
          expect((yield* page.readText({ selector: "#parentCount" })).text).toBe("0");
          expect((yield* child.readText({ selector: "#count" })).text).toBe("0");
          expect((yield* child.readText({ selector: "#events" })).text).toBe("[]");
          expect(
            (yield* page.timeline.snapshot()).events.filter(
              (event) => event.event._tag === "Press" || event.event._tag === "Glide",
            ),
          ).toHaveLength(0);
          const observation = yield* page.observe();
          const parent = observation.controls.find((control) => control.label === "Parent action");

          expect(parent).toBeDefined();
          if (parent !== undefined)
            yield* page.clickElement({
              observationId: observation.observationId,
              elementId: parent.elementId,
            });
          expect((yield* page.readText({ selector: "#parentCount" })).text).toBe("1");
        }).pipe(Effect.provide(layer)),
      ),
  );

it.live("real Chromium: a point press submits down/up before awaiting their acknowledgements", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* site;
      let releaseDown = () => {};

      const downReply = new Promise<void>((resolve) => {
        releaseDown = resolve;
      });

      const session = yield* instrumentedSession((browser) => {
        const page = browser.contexts()[0]?.pages()[0];

        if (page === undefined) throw new Error("No native initial page");
        const down = page.mouse.down.bind(page.mouse);
        const up = page.mouse.up.bind(page.mouse);

        // Real input lands in Chromium; only delivery of the down's reply is held.
        page.mouse.down = (options) => down(options).then(() => downReply);
        page.mouse.up = (options) => up(options).then(releaseDown);
      });

      const page = session.initialPage;

      yield* page.navigate({ url: `${fixture.url}canvas` });
      expect((yield* page.pointerClick({ x: 40, y: 50 })).position).toEqual({ x: 40, y: 50 });
      expect((yield* page.readText({ selector: "#count" })).text).toBe("1");
      expect((yield* page.readText({ selector: "#events" })).text).toContain('"type":"pointerup"');
    }),
  ),
);

it.live(
  "an unknown sendPath interrupted by page navigation is contained without a press or replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* site;
        let connections = 0;
        let moves = 0;
        let presses = 0;
        let trustedMove: string | undefined;

        const session = yield* instrumentedSession((browser) => {
          connections++;
          const page = browser.contexts()[0]?.pages()[0];

          if (page === undefined) throw new Error("No native initial page");
          const move = page.mouse.move.bind(page.mouse);
          const down = page.mouse.down.bind(page.mouse);

          page.mouse.move = (x, y, options) => {
            moves++;

            return move(x, y, options);
          };
          page.mouse.down = (options) => {
            presses++;

            return down(options);
          };
          page.on("console", (message) => {
            if (message.text().startsWith("trusted-path:"))
              trustedMove = message.text().slice("trusted-path:".length);
          });
        });

        const page = session.initialPage;
        const peer = yield* session.createPage();

        yield* peer.navigate({ url: `${fixture.url}canvas` });
        yield* page.navigate({ url: `${fixture.url}canvas?redirect` });
        yield* page.screenshot({ fullPage: false });
        yield* page.pointerMove({ to: { x: 10, y: 10 } });

        const failure = yield* page
          .run(
            {
              version: 1,
              steps: [{ id: "point", action: { _tag: "PointerClick", at: { x: 200, y: 150 } } }],
            },
            {
              style: {
                seed: 7,
                motion: {
                  ...DefaultMotionProfile,
                  sendPath: true,
                  pointer: {
                    ...DefaultMotionProfile.pointer,
                    duration: { minMillis: 800, maxMillis: 800 },
                  },
                },
              },
              within: "10 seconds",
            },
          )
          .pipe(Effect.flip);

        expect(trustedMove).toBeDefined();
        if (trustedMove !== undefined)
          expect(JSON.parse(trustedMove)).toMatchObject({ trusted: true });
        expect(moves).toBeGreaterThan(1);
        expect(presses).toBe(0);
        expect(failure).toMatchObject({
          error: {
            reason: { _tag: "Stale" },
            outcome: "unknown",
            containment: { _tag: "PageClosed", pageId: page.identity.pageId },
          },
          attempt: {
            outcome: "unknown",
            containment: { _tag: "PageClosed", pageId: page.identity.pageId },
          },
        });
        expect(yield* page.status).toMatchObject({
          phase: "closed",
          containment: { _tag: "PageClosed" },
        });
        expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
        const submitted = moves;

        expect(yield* page.pointerClick({ x: 40, y: 50 }).pipe(Effect.flip)).toMatchObject({
          outcome: "undispatched",
        });
        expect(moves).toBe(submitted);
        yield* peer.pointerClick({ x: 40, y: 50 });
        expect((yield* peer.readText({ selector: "#count" })).text).toBe("1");
        expect(connections).toBe(1);
      }),
    ),
);
