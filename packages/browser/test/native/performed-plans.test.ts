import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import * as Plan from "effect-browser/plan";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// Every input event is mirrored, so any key that reached the field is visible afterwards.
// `/moved` redirects to that page and counts each request for it.
const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly origin: string;
        readonly moved: () => number;
        readonly close: () => void;
      }>((resolve) => {
        let moved = 0;

        const server = createServer((request, response) => {
          if (request.url === "/moved") {
            moved++;
            response.writeHead(302, { location: "/" }).end();

            return;
          }
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<!doctype html><input aria-label="Name" id="field"><output id="mirror"></output>
<script>field.addEventListener("input", () => { mirror.textContent = field.value; });</script>`);
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;

          resolve({
            origin: `http://127.0.0.1:${String(port)}`,
            moved: () => moved,
            close: () => server.close(),
          });
        });
      }),
  ),
  (server) => Effect.sync(server.close),
);

const fill = (value: string) =>
  ({
    version: 1,
    steps: [
      {
        id: "name",
        action: {
          _tag: "Fill",
          target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Name" } },
          value: { _tag: "Literal", value },
        },
      },
    ],
  }) as const;

const layer = Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer));

const open = Effect.fnUntraced(function* () {
  const { origin } = yield* site;
  const host = yield* externalChromium;

  const session = yield* Chromium.attach(host.endpoint, {
    policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60_000 }),
  });

  yield* session.initialPage.navigate({ url: `${origin}/` });

  return session.initialPage;
});

it.live("real CDP: a performed fill that cannot finish within its budget sends no input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const page = yield* open();

      const failure = yield* page
        .run(fill("a".repeat(200)), { style: { seed: 7 }, within: "1 second" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        error: { reason: { _tag: "TimingBudgetExceeded" }, outcome: "undispatched" },
      });
      expect((yield* page.readText({ selector: "#mirror" })).text).toBe("");
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: the timeline says which performed acknowledgements were preparatory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const page = yield* open();

      yield* page.run(fill("ab"), { style: { seed: 7 }, within: "20 seconds" });

      const acknowledged = (yield* page.timeline.snapshot()).events.flatMap((event) =>
        event.event._tag === "Acknowledged" ? [event.event] : [],
      );

      expect(acknowledged).toContainEqual(
        expect.objectContaining({
          acknowledgement: { subphase: "focus", logicalComplete: false },
        }),
      );
      expect((yield* page.readText({ selector: "#mirror" })).text).toBe("ab");
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: a recorded navigation asks for the same address again on a fresh Page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { origin, moved } = yield* site;
      const host = yield* externalChromium;

      const session = yield* Chromium.attach(host.endpoint, {
        policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60_000 }),
      });

      const operation = yield* session.initialPage.startNavigation({ url: `${origin}/moved` });

      expect((yield* operation.completed).url).toBe(`${origin}/`);

      const recorded = yield* Plan.decode(
        yield* Plan.encode(yield* Plan.recordedNavigation(operation)),
      );

      expect(recorded.steps).toEqual([
        {
          id: "navigate",
          action: { _tag: "Navigate", url: `${origin}/moved` },
          resolution: { _tag: "Strict" },
        },
      ]);

      const fresh = yield* session.createPage();
      const ran = yield* fresh.run(recorded);

      expect(ran.steps[0]?.receipt).toEqual({ url: `${origin}/` });
      expect((yield* fresh.describe()).url).toBe(`${origin}/`);
      expect(moved()).toBe(2);
    }).pipe(Effect.provide(layer)),
  ),
);
