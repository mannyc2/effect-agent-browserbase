import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { ReadTextRequest } from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import { chromium } from "playwright-core";

import { Broadcast } from "../../examples/realistic-footage/Broadcast.ts";
import { Director } from "../../examples/realistic-footage/Director.ts";
import * as Footage from "../../examples/realistic-footage/Footage.ts";
import * as Stagehand from "../../examples/realistic-footage/Stagehand.ts";
import { StageSite } from "../../examples/realistic-footage/StageSite.ts";
import { Telemetry } from "../../examples/realistic-footage/Telemetry.ts";
import { localBrowser, localLaunch, policy, withProvider } from "../fixtures/LocalBrowser.ts";

// Set to a directory to keep the film and its metrics; otherwise both are deleted with the scope.
const keepIn = process.env.REALISTIC_FOOTAGE_DIR;
// Set to a port to watch the session live: the film waits for a viewer at http://127.0.0.1:<port>/.
const livePort = process.env.REALISTIC_FOOTAGE_LIVE_PORT;

/** A scripted viewer: counts the frames the live endpoint sends, as they are sent. */
const watch = (url: string, seen: Ref.Ref<number>) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(`${url}/live.mjpeg`, { signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder("latin1");
    const header = /Content-Type: image\/jpeg\r\n/g;
    let tail = "";

    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) return;
      // A header can straddle two chunks, so the end of each one is searched again with the next.
      // Each part's headers follow the frame before it, so every header after the first is a frame.
      const text = tail + decoder.decode(chunk.value);
      const parts = text.match(header)?.length ?? 0;

      tail = text.slice(-32).replace(header, "");
      if (parts > 0) Effect.runSync(Ref.update(seen, (count) => count + parts));
    }
  }).pipe(Effect.ignore);

/** The viewer's own page, in another browser: its script must render the live numbers. */
const view = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(() => chromium.launch()),
    (browser) => Effect.promise(() => browser.close()),
  ).pipe(
    Effect.flatMap((browser) =>
      Effect.promise(async () => {
        const page = await browser.newPage();
        const errors: Array<string> = [];

        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url, { waitUntil: "commit" });
        await page.waitForFunction(
          () => document.querySelectorAll("#numbers dt").length >= 10,
          undefined,
          {
            timeout: 30_000,
          },
        );

        return {
          errors,
          rows: await page.evaluate(() =>
            [...document.querySelectorAll("#numbers dt")].map((row) => row.textContent ?? ""),
          ),
        };
      }),
    ),
  );

it.live(
  "real CDP: the demo storyboard is filmed across a navigation, watched live, and accounted for",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const site = yield* StageSite;
        const broadcast = yield* Broadcast;
        const liveUrl = broadcast.url!;

        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "browserbase-footage-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );

        const outputPath = join(directory, "realistic-footage.mp4");

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const browser = yield* BrowserbaseBrowser;

            const session = yield* browser.open(policy, {
              bootstrap: Stagehand.plan([site.origin]),
            });

            const seen = yield* Ref.make(0);

            const viewed =
              livePort === undefined ? yield* Effect.forkScoped(view(liveUrl)) : undefined;

            if (livePort === undefined) yield* Effect.forkScoped(watch(liveUrl, seen));
            else {
              console.error(`Watch live at ${liveUrl}/ (waiting up to two minutes for a viewer)`);
              yield* broadcast.viewers.pipe(
                Effect.repeat({
                  until: (viewers) => viewers > 0,
                  schedule: Schedule.spaced("250 millis"),
                }),
                Effect.timeout("2 minutes"),
              );
            }

            const footage = yield* Footage.record(session, {
              url: `${site.origin}/`,
              storyboard: Footage.demo,
              outputPath,
              seed: "night-rail-atlas",
            });

            const { metrics } = footage;

            // Live means during: these frames reached the viewer before the film was finished.
            if (viewed !== undefined) {
              expect(yield* Ref.get(seen)).toBeGreaterThan(metrics.capture.frames / 2);
              // The viewer's script read the metrics it was served and rendered every row.
              const page = yield* Fiber.join(viewed);

              expect(page.errors).toEqual([]);
              expect(page.rows).toContain("documents");
              expect(page.rows).toContain("discarded here");
            }

            // The storyboard's own actions landed: the page says the berth is held.
            const held = yield* session.readText(ReadTextRequest.make({ selector: "#held" }));

            expect(held.text).toContain("Held for twenty minutes");
            expect((yield* session.observe()).url).toBe(`${site.origin}/routes/vienna-venice`);

            // One interval filmed both documents. The link's navigation did not end it, so the
            // loading is on film, and the library says what each document was and when the
            // second one committed. How long the picture held across it is this layer's number.
            const interval = metrics.capture.interval!;

            expect(interval).toMatchObject({ reason: "stopped", nativeStop: "confirmed" });
            // Nothing was dropped for want of buffer or bytes. A frame that arrives behind a
            // newer one is discarded and counted as late; Chromium's concurrent encoding makes
            // that a matter of the host's scheduling, so it is reported rather than forbidden.
            expect(interval.discarded - interval.late).toBe(0);
            expect(interval.duplicates).toBe(0);
            expect(metrics.capture.timeToFirstFrameMillis).not.toBeNull();
            expect(metrics.documents.map((document) => document.url)).toEqual([
              `${site.origin}/`,
              `${site.origin}/routes/vienna-venice`,
            ]);
            expect(metrics.documents[0]?.committedAtMillis).toBeNull();
            expect(metrics.documents[1]?.committedAtMillis).not.toBeNull();
            expect(metrics.documents[1]?.heldMillis).toBeGreaterThan(0);

            // The page and the host compared clocks, so capture latency is a measurement. Here
            // both are one machine: the offset is near zero and no frame predates its picture
            // by more than the comparison's own error.
            const clock = metrics.capture.clock!;
            const latency = metrics.capture.latencyMillis!;

            expect(clock.samples).toBeGreaterThan(3);
            expect(Math.abs(clock.offsetMillis)).toBeLessThan(50);
            expect(latency.p50).toBeGreaterThan(-clock.uncertaintyMillis - 5);
            expect(latency.p50).toBeLessThan(500);

            // Everything the storyboard dispatched was timed. Three clicks and one link are timed
            // around the call. Six real keys, and one native pointer move for each of the four
            // glides before them, are timed by the receipt the library returned for each.
            expect(metrics.control.actionMillis.click?.count).toBe(3);
            expect(metrics.control.actionMillis.clickAndWait?.count).toBe(1);
            expect(metrics.control.actionMillis.fill).toBeUndefined();
            expect(metrics.control.inputMillis.key?.count).toBe(6);
            expect(metrics.control.inputMillis.pointerMove?.count).toBe(4);
            expect(metrics.control.clickToFrameMillis?.count).toBe(3);
            expect(metrics.control.cueRoundTripMillis?.count).toBeGreaterThan(5);

            // Constant rate: the decoded frame count is the duration at thirty per second, and
            // what the encoder was sent is what the file holds.
            expect(footage.width).toBe(1280);
            expect(footage.height).toBe(720);
            expect(footage.seconds).toBeGreaterThan(15);
            expect(Math.abs(footage.frames - footage.seconds * 30)).toBeLessThanOrEqual(1);
            expect(metrics.output.frames).toBe(footage.frames);
            expect(metrics.output.heldFrames).toBeGreaterThan(0);
            expect(metrics.output.heldFrames).toBeLessThan(metrics.output.frames);

            if (keepIn !== undefined) {
              yield* Effect.promise(async () => {
                await mkdir(keepIn, { recursive: true });
                await copyFile(outputPath, join(keepIn, "realistic-footage.mp4"));
                await writeFile(
                  join(keepIn, "realistic-footage.metrics.json"),
                  JSON.stringify(metrics, null, 2) + "\n",
                );
              });
            }

            expect((yield* session.close).remote).toBe("confirmed");
          }),
          { launch: { ...localLaunch, viewport: { _tag: "Fixed", width: 1280, height: 720 } } },
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          StageSite.layer,
          Director.layer,
          Broadcast.layer({ port: livePort === undefined ? 0 : Number(livePort) }),
          NodeServices.layer,
        ).pipe(Layer.provideMerge(Telemetry.layer)),
      ),
    ),
  240_000,
);
