import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schedule } from "effect";
import { BrowserPolicy, ObservedElement } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// A srcdoc document has no http(s) address of its own: its URL is about:srcdoc. On /remove, the
// frame's only button removes the frame itself. On /long, the parent can lengthen its child's own
// http(s) address past what an action may report, and the child counts clicks in the parent.
const pages: Record<string, string> = {
  "/remove": `<!doctype html><p id=gone>no</p><iframe srcdoc="<button onclick=&quot;parent.document.getElementById('gone').textContent='yes';frameElement.remove()&quot;>Dismiss</button>"></iframe>`,
  "/long": `<!doctype html><p id=count>0</p>
<button id=lengthen onclick="frames[0].history.replaceState(null, '', '/long-child?pad=' + 'a'.repeat(9000))">Lengthen</button>
<iframe src="/long-child"></iframe>`,
  "/long-child": `<!doctype html><button id=increment onclick="const count = parent.document.getElementById('count'); count.textContent = String(Number(count.textContent) + 1)">Increment</button>`,
};

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            pages[new URL(request.url ?? "/", "http://site").pathname] ??
              `<!doctype html><iframe srcdoc="<p id=count>0</p>
<button onclick=&quot;count.textContent=Number(count.textContent)+1&quot;>Increment</button>">
</iframe>`,
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

it.live("real CDP: an action in a srcdoc frame reports its parent's address once performed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { origin } = yield* site;
      const host = yield* externalChromium;

      const session = yield* Chromium.attach(host.endpoint, {
        policy: BrowserPolicy.unrestricted({ maxActions: 100, maxElapsedMillis: 60_000 }),
      });

      const page = session.initialPage;

      yield* page.navigate({ url: `${origin}/` });

      const child = yield* page.listFrames().pipe(
        Effect.map((frames) => frames.find((frame) => frame.url === "about:srcdoc")),
        Effect.repeat({ until: (frame) => frame !== undefined, schedule: Schedule.spaced(50) }),
        Effect.timeout("5 seconds"),
      );

      if (child === undefined) return yield* Effect.die("the srcdoc frame never attached");
      const frame = yield* page.frame(child);
      const observed = yield* frame.observe();
      const button = observed.controls.find((control) => control.label === "Increment");

      expect(button).toBeDefined();

      const result = yield* frame.clickElement(
        ObservedElement.make({
          observationId: observed.observationId,
          elementId: button?.elementId ?? "",
        }),
      );

      expect(result.url).toBe(`${origin}/`);
      expect((yield* frame.readText({ selector: "#count" })).text).toBe("1");
    }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
  ),
);

it.live(
  "real CDP: an action that removes its own frame keeps the address read before dispatch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* site;
        const host = yield* externalChromium;

        const session = yield* Chromium.attach(host.endpoint, {
          policy: BrowserPolicy.unrestricted({ maxActions: 100, maxElapsedMillis: 60_000 }),
        });

        const page = session.initialPage;

        yield* page.navigate({ url: `${origin}/remove` });

        const child = yield* page.listFrames().pipe(
          Effect.map((frames) => frames.find((frame) => frame.url === "about:srcdoc")),
          Effect.repeat({ until: (frame) => frame !== undefined, schedule: Schedule.spaced(50) }),
          Effect.timeout("5 seconds"),
        );

        if (child === undefined) return yield* Effect.die("the srcdoc frame never attached");
        const frame = yield* page.frame(child);
        const observed = yield* frame.observe();
        const button = observed.controls.find((control) => control.label === "Dismiss");

        expect(button).toBeDefined();

        const result = yield* frame.clickElement(
          ObservedElement.make({
            observationId: observed.observationId,
            elementId: button?.elementId ?? "",
          }),
        );

        expect(result.url).toBe(`${origin}/remove`);
        expect((yield* page.readText({ selector: "#gone" })).text).toBe("yes");
      }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
    ),
);

it.live(
  "real CDP: an action in a frame whose own address cannot be reported is refused unsent",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* site;
        const host = yield* externalChromium;

        const session = yield* Chromium.attach(host.endpoint, {
          policy: BrowserPolicy.unrestricted({ maxActions: 100, maxElapsedMillis: 60_000 }),
        });

        const page = session.initialPage;

        yield* page.navigate({ url: `${origin}/long` });

        const child = yield* page.listFrames().pipe(
          Effect.map((frames) => frames.find((frame) => frame.url === `${origin}/long-child`)),
          Effect.repeat({ until: (frame) => frame !== undefined, schedule: Schedule.spaced(50) }),
          Effect.timeout("5 seconds"),
        );

        if (child === undefined) return yield* Effect.die("the child frame never attached");
        const frame = yield* page.frame(child);

        // The child's own http(s) address grows past 8,192 characters, in the same document.
        yield* page.click({ selector: "#lengthen" });

        // Its parent's address must not stand in for a different document's: nothing is sent.
        expect(yield* frame.click({ selector: "#increment" }).pipe(Effect.flip)).toMatchObject({
          reason: { _tag: "Unsupported" },
          outcome: "undispatched",
        });
        expect((yield* page.readText({ selector: "#count" })).text).toBe("0");
      }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
    ),
);
