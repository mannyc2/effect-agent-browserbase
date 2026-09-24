import { createServer } from "node:http";

import { ScriptedModel, type ScriptedTurnInput } from "@effect-agent/testing/scripted-model";
import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Ref, Schedule } from "effect";
import * as InMemory from "effect-agent/in-memory";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import { Model } from "effect/unstable/ai";
import { chromium } from "playwright-core";

import { type AirEvent, livestream } from "../../examples/livestream/Livestream.ts";
import { Narrator } from "../../examples/livestream/Narrator.ts";
import { Stage } from "../../examples/livestream/Stage.ts";
import { inspectionReference } from "../fixtures/Inspection.ts";

// The example end to end on a local Chromium, with a scripted agent and a scripted narrator:
// viewers watch one second behind, and every caption airs over the step it describes.

const Delay = 1000;
const Millis = 1_000_000n;

const page = (title: string, body: string) =>
  `<!doctype html><title>${title}</title><style>body{font:18px sans-serif;margin:40px}
#spin{width:40px;height:40px;background:#39f;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style><div id=spin></div>${body}`;

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            request.url === "/pricing"
              ? page("Acme Pricing", "<h1>Plans</h1><p>Starter and Team.</p>")
              : page("Acme Home", '<h1>Acme</h1><a href="/pricing">Pricing</a>'),
          );
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;

          resolve({ origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() });
        });
      }),
  ),
  (server) => Effect.sync(server.close),
);

const usage = { inputTokens: {}, outputTokens: {} };

// A model takes its time: two seconds a turn keeps each step on screen long enough to read.
const thinking = Effect.sleep(2000);

const call = (id: string, name: string, params: unknown): ScriptedTurnInput => ({
  _tag: "Stream",
  parts: [
    { type: "tool-call", id, name, params },
    { type: "finish", reason: "tool-calls", usage },
  ],
  termination: { _tag: "Complete" },
  onStreamStart: thinking,
});

const answer = (text: string): ScriptedTurnInput => ({
  _tag: "Stream",
  parts: [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop", usage },
  ],
  termination: { _tag: "Complete" },
  onStreamStart: thinking,
});

const said = (text: string): ScriptedTurnInput => ({
  _tag: "Generate",
  parts: [
    { type: "text", text },
    { type: "finish", reason: "stop", usage },
  ],
});

// The second caption carries markup, as page text reaching a caption could.
const captions = [
  "Opening the Acme home page",
  "Reading <b>the</b> page",
  "Following the Pricing link",
];

const scripted = (turns: ReadonlyArray<ScriptedTurnInput>) =>
  Layer.mergeAll(
    ScriptedModel.layer(turns),
    Layer.succeed(Model.ProviderName, "scripted"),
    Layer.succeed(Model.ModelName, "livestream-fixture"),
  );

it.live(
  "real AgentRuntime: viewers watch a second behind, and each caption airs over its own step",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* site;
        const pricing = { elementId: "unobserved" };

        const agentModel = scripted([
          call("navigate", "browser_navigate", { url: `${origin}/` }),
          call("inspect", "browser_inspect", {}),
          {
            ...call("click", "browser_click", pricing),
            assertRequest: (request) => {
              Object.assign(pricing, inspectionReference(request, "Pricing"));
            },
          },
          answer('{"summary":"Opened the pricing page"}'),
        ]);

        const aired: Array<AirEvent> = [];

        const seen = yield* Ref.make<
          ReadonlyArray<{ caption: string; markup: boolean; address: string; title: string }>
        >([]);

        const result = yield* Effect.gen(function* () {
          const stage = yield* Stage;

          // A viewer is another browser, polling what its page shows.
          const audience = yield* Effect.acquireRelease(
            Effect.promise(() => chromium.launch()),
            (browser) => Effect.promise(() => browser.close()),
          );

          const viewer = yield* Effect.promise(() => audience.newPage());

          yield* Effect.promise(() => viewer.goto(stage.url, { waitUntil: "commit" }));

          const watching = yield* Effect.promise(() =>
            viewer.evaluate(() => ({
              caption: document.getElementById("caption")?.textContent ?? "",
              markup: document.querySelector("#caption *") !== null,
              address: document.getElementById("address")?.textContent ?? "",
              title: document.getElementById("title")?.textContent ?? "",
            })),
          ).pipe(
            Effect.flatMap((view) => Ref.update(seen, (all) => [...all, view])),
            Effect.repeat(Schedule.spaced("100 millis")),
            Effect.forkScoped,
          );

          const run = yield* Browser.scoped(
            Chromium.launch(
              BrowserPolicy.unrestricted({ maxActions: 40, maxElapsedMillis: 120_000 }),
            ),
            (session) =>
              Effect.gen(function* () {
                const outcome = yield* livestream(session, "Open the pricing page.", {
                  delayMillis: Delay,
                  size: { width: 640, height: 480 },
                  onAir: (event) =>
                    Effect.sync(() => {
                      aired.push(event);
                    }),
                });

                const text = (yield* session.observe({ scope: "document" })).text;

                return { ...outcome, text };
              }),
          );

          yield* Fiber.interrupt(watching);

          // Everything the agent's model was sent: observations, tool results, the task.
          const requests = JSON.stringify(yield* (yield* ScriptedModel).requests, (_key, value) =>
            typeof value === "bigint" ? String(value) : value,
          );

          return { ...run, requests };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Stage.layer({ port: 0 }),
              Narrator.layer.pipe(Layer.provide(scripted(captions.map(said)))),
              InMemory.layer,
              Chromium.layer({
                launch: {
                  ...(process.env.BROWSERBASE_CHROMIUM === undefined
                    ? {}
                    : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
                  chromiumSandbox: false,
                  startupTimeoutMillis: 25000,
                },
                viewport: { width: 640, height: 480 },
              }).pipe(Layer.provide(NodeCrypto.layer)),
              NodeCrypto.layer,
              agentModel,
            ),
          ),
        );

        expect(result.outcome._tag).toBe("Success");
        expect(result.summary).toEqual({ summary: "Opened the pricing page" });

        const events = aired;
        const frames = events.flatMap((event) => (event._tag === "Frame" ? [event] : []));
        const shown = events.flatMap((event) => (event._tag === "Caption" ? [event] : []));
        const cleared = events.flatMap((event) => (event._tag === "Clear" ? [event] : []));

        // Every picture airs a second after it was received, give or take the timer.
        expect(frames.length).toBeGreaterThan(30);
        for (const { frame, airedNanos } of frames) {
          expect(airedNanos - frame.receivedMonotonicNanos).toBeGreaterThanOrEqual(
            BigInt(Delay - 2) * Millis,
          );
          expect(airedNanos - frame.receivedMonotonicNanos).toBeLessThan(
            BigInt(Delay + 1000) * Millis,
          );
        }

        // Every caption airs in its own step's window, and every picture shown under it was
        // received during that step: a caption never covers footage it does not describe.
        expect(shown.map((caption) => caption.text)).toEqual(captions);
        for (const caption of shown) {
          const { startedNanos, nextNanos } = caption.step;

          const until = cleared.find(
            (clear) => clear.step.toolCallId === caption.step.toolCallId,
          )?.airedNanos;

          expect(caption.airedNanos).toBeGreaterThanOrEqual(
            startedNanos + BigInt(Delay - 2) * Millis,
          );
          expect(until).toBeDefined();
          for (const { frame, airedNanos } of frames)
            if (airedNanos > caption.airedNanos && until !== undefined && airedNanos < until) {
              expect(frame.receivedMonotonicNanos).toBeGreaterThanOrEqual(startedNanos);
              if (nextNanos !== null)
                expect(frame.receivedMonotonicNanos).toBeLessThan(nextNanos + 5n * Millis);
            }
        }

        // The address bar changes when the first picture of the new document airs.
        const pricingAddress = events
          .flatMap((event) => (event._tag === "Address" ? [event] : []))
          .find((event) => event.address === `${origin}/pricing`);

        const boundary = result.capture.documentBoundaries.find(
          (known) => known.url === `${origin}/pricing`,
        );

        expect(pricingAddress).toBeDefined();
        expect(boundary).toBeDefined();
        if (pricingAddress !== undefined && boundary !== undefined)
          expect(pricingAddress.airedNanos).toBeGreaterThanOrEqual(
            boundary.observedMonotonicNanos + BigInt(Delay - 2) * Millis,
          );
        expect(
          events.some((event) => event._tag === "Title" && event.title === "Acme Pricing"),
        ).toBe(true);

        // Viewers see text, never markup, and the drawn window follows the navigation.
        const views = yield* Ref.get(seen);

        expect(views.some((view) => view.caption === "Reading <b>the</b> page")).toBe(true);
        expect(views.some((view) => view.markup)).toBe(false);
        expect(
          views.some(
            (view) => view.address === `${origin}/pricing` && view.title === "Acme Pricing",
          ),
        ).toBe(true);

        // Captions are drawn over the footage, never into the page, so the agent never reads them.
        for (const text of captions) {
          expect(result.requests).not.toContain(text);
          expect(result.text).not.toContain(text);
        }

        // Capture accounting: nothing this package discarded beyond frames Chromium sent late.
        expect(result.capture.discarded - result.capture.late).toBe(0);
      }),
    ),
  { timeout: 90_000 },
);
