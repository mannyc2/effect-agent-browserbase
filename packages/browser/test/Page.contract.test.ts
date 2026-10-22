/** One contract, run against seeded data and both real Chromium transport paths. */
import { createServer } from "node:net";

import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Scheduler, Stream } from "effect";
import { chromium } from "playwright-core";

import { Browser, type Service } from "../src/Browser.ts";
import type { BrowserError } from "../src/BrowserError.ts";
import { Subject } from "../src/BrowserEvent.ts";
import { BrowserPaint, Frame } from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";
import * as Cdp from "../src/providers/Cdp.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestBrowser from "../src/testing/TestBrowser.ts";
import * as TestPage from "../src/testing/TestPage.ts";

const browserContract = (browser: Service) =>
  Effect.gen(function* () {
    for (const page of yield* browser.pages) yield* page.close;

    const initial = yield* Effect.all(
      Array.from({ length: 12 }, () => browser.firstPage),
      { concurrency: 12 },
    ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32));

    assert.strictEqual(new Set(initial.map((page) => page.id)).size, 1);
    assert.lengthOf(yield* browser.pages, 1);
    const first = initial[0];

    assert.isDefined(first);
    if (first === undefined) return;
    const second = yield* browser.newPage();
    const order = (yield* browser.pages).map((page) => page.id);

    assert.isBelow(order.indexOf(first.id), order.indexOf(second.id));
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* browser.suspend();
        assert.deepStrictEqual(yield* first.find(), []);
        const failure = yield* Effect.flip(first.press("Escape"));

        assert.deepStrictEqual([failure.reason._tag, failure.dispatched], ["Suspended", false]);
      }),
    );
    yield* first.press("Escape");
    yield* first.close;
    assert.isTrue(Option.isNone(yield* browser.page(first.id)));
    yield* second.close;
  });

it.effect("earns the supported Browser contract with seeded data", () =>
  Effect.gen(function* () {
    const test = yield* TestBrowser.make();

    yield* browserContract(test.browser);
  }),
);

const html =
  '<button>Save</button><button disabled>Blocked</button><label><input type="checkbox" checked>Choice</label>';

const contract = (page: Page, replace: Effect.Effect<void, BrowserError>) =>
  Effect.gen(function* () {
    const capture = yield* page.capture();

    const frame =
      capture.current ??
      Option.getOrThrow(yield* capture.stream.pipe(Stream.runHead, Effect.timeout("5 seconds")));

    assert.isTrue(capture.isCurrent(new Frame({ ...frame, data: new Uint8Array([0]) })));
    assert.isFalse(capture.isCurrent(new Frame({ ...frame, document: frame.document + 1 })));
    if (frame.capture !== undefined)
      assert.isFalse(
        capture.isCurrent(
          new Frame({
            ...frame,
            capture: { ...frame.capture, sequence: frame.capture.sequence + 1 },
          }),
        ),
      );

    const snapshot = yield* page.snapshot();

    assert.strictEqual(snapshot.controls.find((one) => one.name === "Choice")?.checked, true);
    const [save] = yield* page.find({ role: " BUTTON ", name: " save " });
    const [blocked] = yield* page.find({ name: "Blocked" });

    assert.isDefined(save);
    assert.isTrue(blocked?.state.disabled);
    const refusal = yield* Effect.flip(page.click(blocked?.ref ?? ""));

    assert.deepStrictEqual([refusal.reason._tag, refusal.dispatched], ["NotActionable", false]);
    assert.isFalse((yield* page.until({ name: "Blocked", state: "enabled" }, "some", 0)).met);
    const baseline = yield* page.until({ text: /save/i }, "some", 0);

    assert.isTrue(baseline.met);
    assert.match(baseline.mark, /^1:[a-f0-9]+$/);
    assert.isFalse((yield* page.until({ text: /save/i }, { other: baseline.mark }, 0)).met);
    const clicked = yield* page.click(save?.ref ?? "");

    assert.strictEqual(clicked.role, "button");
    assert.strictEqual(clicked.name, "Save");

    const actions = (yield* page.recentEvents).filter(
      (event) => event._tag === "Action" && event.ok,
    );

    const last = actions.at(-1);

    assert.strictEqual(last?._tag === "Action" ? last.value?._tag : undefined, "Click");
    yield* replace;
    assert.strictEqual((yield* Effect.flip(page.click(save?.ref ?? ""))).reason._tag, "StaleRef");
    yield* page.close;
    yield* page.close;
    assert.strictEqual((yield* Effect.flip(page.title)).reason._tag, "Closed");
  });

it.effect("earns the supported Page contract with seeded data", () =>
  Effect.gen(function* () {
    const seed = {
      frames: [
        new Frame({
          page: "test-page",
          session: "test-browser",
          connection: "test-connection",
          capture: { generation: 1, sequence: 1 },
          document: 0,
          url: "about:blank",
          data: new Uint8Array([1]),
          width: 10,
          height: 10,
          receivedAt: 0,
          timing: new BrowserPaint({ timestamp: 0, hostTime: 0, uncertaintyMillis: 0 }),
        }),
      ],
      elements: [
        {
          key: "choice",
          subject: new Subject({ role: "checkbox", name: "Choice", tag: "input", context: {} }),
          state: { checked: true },
          box: { x: 10, y: 40, width: 20, height: 20 },
        },
        {
          key: "save",
          subject: new Subject({ role: "button", name: "Save", tag: "button", context: {} }),
          box: { x: 10, y: 10, width: 50, height: 20 },
        },
        {
          key: "blocked",
          subject: new Subject({ role: "button", name: "Blocked", tag: "button", context: {} }),
          state: { disabled: true },
          box: { x: 70, y: 10, width: 50, height: 20 },
        },
      ],
    };

    const test = yield* TestPage.make(seed);

    yield* contract(test.page, test.document(seed));
  }),
);

const port = Effect.callback<number>((resume) => {
  const server = createServer();

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    server.close(() =>
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0)),
    );
  });
});

const attached = Layer.unwrap(
  Effect.gen(function* () {
    const available = yield* port;

    yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ args: [`--remote-debugging-port=${available}`] })),
      (browser) => Effect.promise(() => browser.close()),
    );

    return Cdp.layer({ endpoint: `http://127.0.0.1:${available}` });
  }),
);

for (const [provider, layer] of [
  ["Chromium", Chromium.layer()],
  ["CDP", attached],
] as const) {
  it.live(`earns the supported Page contract over ${provider}`, () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const page = yield* browser.newPage(`data:text/html,${html}`);

      yield* contract(page, page.goto(`data:text/html,${html}`));
      yield* browserContract(browser);
    }).pipe(Effect.provide(layer)),
  );
}
