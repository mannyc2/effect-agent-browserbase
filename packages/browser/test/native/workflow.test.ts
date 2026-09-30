import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as BrowserRuntime from "effect-browser/browser-runtime";
import * as Capture from "effect-browser/capture";
import { Chromium, type ChromiumCleanupResult } from "effect-browser/chromium";
import { BrowserError, Reasons } from "effect-browser/errors";
import type { Browser as PlaywrightBrowser } from "playwright-core";

import { externalChromium, localSite } from "../fixtures/StandaloneBrowser.ts";

const policy = BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 });

const launch = {
  ...(process.env.BROWSERBASE_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
  chromiumSandbox: false,
  startupTimeoutMillis: 25000,
};

const keyboardFixture = Effect.fnUntraced(function* () {
  const site = yield* localSite;
  const host = yield* externalChromium;
  let native: PlaywrightBrowser | undefined;

  const runtime = yield* BrowserRuntime.make({
    implementation: "native-keyboard-workflow",
    binding: BrowserRuntime.playwright({
      onConnected: (connection) => {
        native = connection.native as PlaywrightBrowser;
      },
    }),
  }).pipe(Effect.provide(NodeCrypto.layer));

  const acquired = yield* runtime.acquire(policy, (cleanup) =>
    Effect.gen(function* () {
      const release = yield* Effect.cached(
        cleanup.fence.pipe(
          Effect.andThen(cleanup.capture),
          Effect.andThen(cleanup.initialization),
          Effect.andThen(cleanup.disconnect),
          Effect.orDie,
          Effect.ensuring(Effect.promise(host.close)),
          Effect.asVoid,
        ),
      );

      yield* Effect.addFinalizer(() => release);

      return {
        reference: "native-keyboard-workflow",
        connection: () => Effect.succeed(host.endpoint),
        release,
        cleanupResult: Effect.succeedNone,
        closeChecked: release,
        controlRetired: Effect.sync(() => !host.running()),
      };
    }),
  );

  const { session } = yield* acquired.connect;

  if (native === undefined)
    throw new Error("The public runtime did not connect its native browser");
  const page = native.contexts().flatMap((context) => context.pages())[0];

  if (page === undefined) throw new Error("The native keyboard workflow has no page");

  return { session, page, host, url: new URL("keyboard", site.url).href };
});

// The owner requested this native seam before implementation for #94's bounded plain typing.
it.live(
  "plain typing preserves native key ordering, Unicode and modifier state as one action",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page, host, url } = yield* keyboardFixture();

        const text =
          Array.from({ length: 95 }, (_, index) => String.fromCodePoint(0x20 + index)).join("") +
          "aaaé e\u0301😀";

        yield* Browser.scoped(Effect.succeed(session), (browser) =>
          Effect.gen(function* () {
            yield* browser.navigate({ url });
            yield* browser.click({ selector: "#first" });
            yield* Effect.promise(() => page.keyboard.type(text));
            const expectedEvents = (yield* browser.readText({ selector: "#events" })).text;

            yield* browser.navigate({ url });
            yield* browser.click({ selector: "#first" });
            const before = (yield* browser.status).actions.used;
            const receipt = yield* browser.type({ text, into: "#first" });

            expect(receipt.kind).toBe("type");
            expect((yield* browser.status).actions.used).toBe(before + 1);
            const events = (yield* browser.readText({ selector: "#events" })).text;

            expect(events).toBe(expectedEvents);
            expect(
              (JSON.parse(events) as ReadonlyArray<ReadonlyArray<unknown>>).every(
                (event) => event[11] === true,
              ),
            ).toBe(true);
            expect((yield* browser.readText({ selector: "#values" })).text).toBe(
              JSON.stringify([text, ""]),
            );

            yield* browser.navigate({ url });
            yield* browser.click({ selector: "#first" });
            yield* browser.type({ text: "a", into: "#first" });
            yield* browser.press({ key: "A", modifiers: ["Shift"], into: "#first" });
            yield* browser.type({ text: "b", into: "#first" });
            expect((yield* browser.readText({ selector: "#values" })).text).toBe(
              JSON.stringify(["aAb", ""]),
            );

            const finalEvents = JSON.parse(
              (yield* browser.readText({ selector: "#events" })).text,
            ) as ReadonlyArray<ReadonlyArray<unknown>>;

            const finalKeyDown = finalEvents.filter(
              (event) => event[0] === "keydown" && event[2] === "b",
            );

            expect(finalKeyDown).toHaveLength(1);
            expect(finalKeyDown[0]?.[4]).toBe(false);
            expect(finalKeyDown[0]?.[5]).toBe(false);

            yield* browser.click({ selector: "#second" });
            const previousEvents = (yield* browser.readText({ selector: "#events" })).text;

            const notFocused = yield* browser
              .type({ text: "must not land", into: "#first" })
              .pipe(Effect.flip);

            expect(notFocused).toMatchObject({
              reason: { _tag: "NotFocused" },
              outcome: "undispatched",
            });
            expect((yield* browser.readText({ selector: "#events" })).text).toBe(previousEvents);
          }),
        );
        expect(host.running()).toBe(false);
      }),
    ),
);

it.live("guarded plain typing stops future windows when the original input loses focus", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, page, host, url } = yield* keyboardFixture();

      yield* Browser.scoped(Effect.succeed(session), (browser) =>
        Effect.gen(function* () {
          yield* browser.navigate({ url: `${url}?moveAfter=1` });
          yield* browser.click({ selector: "#first" });
          const before = (yield* browser.status).actions.used;

          const result = yield* browser
            .type({ text: "a".repeat(80), into: "#first" })
            .pipe(Effect.exit);

          const values = yield* Effect.promise(() => page.locator("#values").textContent());

          expect(values).not.toBeNull();
          const [first, second] = JSON.parse(values ?? "[]") as [string, string];

          expect(first).toBe("a");
          expect(second.length).toBeLessThanOrEqual(15);

          const errors = Exit.isFailure(result)
            ? result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
            : [];

          expect(errors).toContainEqual(
            expect.objectContaining({
              reason: expect.objectContaining({ _tag: "NotFocused" }),
              outcome: "unknown",
            }),
          );
          expect((yield* browser.status).actions.used).toBe(before + 1);
          expect(yield* browser.status).toMatchObject({
            phase: "uncertain",
            unresolvedDispatch: true,
          });
        }),
      );
      expect(host.running()).toBe(false);
    }),
  ),
);

it.live("Browser.scoped joins callback resources before checked owned cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;
      const events: string[] = [];
      const reports: ChromiumCleanupResult[] = [];
      let checked: Effect.Effect<ChromiumCleanupResult, BrowserError> | undefined;

      const result = yield* Browser.scoped(Chromium.launch(policy), (browser) =>
        Effect.gen(function* () {
          checked = browser.closeChecked;
          yield* browser.navigate({ url: site.url });
          yield* Effect.addFinalizer(() =>
            browser.readText({ selector: "#count" }).pipe(
              Effect.tap((value) => Effect.sync(() => events.push(`callback:${value.text}`))),
              Effect.orDie,
            ),
          );

          return browser.reference.provider;
        }),
      ).pipe(
        Effect.provide(
          Chromium.layer({
            launch,
            onCleanup: (receipt) =>
              Effect.sync(() => {
                reports.push(receipt);
                events.push("browser cleanup");
              }),
          }).pipe(Layer.provide(NodeCrypto.layer)),
        ),
      );

      expect(result).toBe("chromium");
      expect(events).toEqual(["callback:0", "browser cleanup"]);
      if (checked === undefined) throw new Error("The workflow did not acquire its owner");
      const receipt = yield* checked;

      expect(yield* checked).toBe(receipt);
      expect(receipt).toBe(reports[0]);
      expect(receipt.ownership).toBe("owned");
      expect(receipt.connection).toBe("closed");
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.process).toBe("terminated");
      expect(reports[0]?.issues).toEqual([]);
    }),
  ),
);

it.live("Browser.scoped retains both a callback failure and checked cleanup failure", () =>
  Effect.gen(function* () {
    const callbackError = { _tag: "ConsumerFailure", privateDetail: "retained on the host" };

    const cleanupError = BrowserError.make({
      operation: "close",
      reason: Reasons.Failed.make({}),
      outcome: "unknown",
    });

    let checks = 0;

    const acquired = Chromium.launch(policy).pipe(
      Effect.map((browser) => {
        const close = browser.closeChecked;

        // An owner reporting uncertain cleanup must remain a typed failure alongside the body failure.
        return Object.assign(browser, {
          closeChecked: close.pipe(
            Effect.tap(() => Effect.sync(() => checks++)),
            Effect.andThen(Effect.fail(cleanupError)),
          ),
        });
      }),
    );

    const exit = yield* Browser.scoped(acquired, () => Effect.fail(callbackError)).pipe(
      Effect.provide(Chromium.layer({ launch }).pipe(Layer.provide(NodeCrypto.layer))),
      Effect.exit,
    );

    expect(checks).toBe(1);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);

      expect(errors).toContain(callbackError);
      expect(errors).toContain(cleanupError);
    }
  }),
);

it.live("Browser.scoped cancellation joins child work and terminates its owned process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const events: string[] = [];
      const reports: ChromiumCleanupResult[] = [];

      const fiber = yield* Browser.scoped(Chromium.launch(policy), () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => events.push("callback")));
          yield* Deferred.succeed(started, undefined);

          return yield* Effect.never;
        }),
      ).pipe(
        Effect.provide(
          Chromium.layer({
            launch,
            onCleanup: (receipt) =>
              Effect.sync(() => {
                reports.push(receipt);
                events.push("browser");
              }),
          }).pipe(Layer.provide(NodeCrypto.layer)),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(events).toEqual(["callback", "browser"]);
      expect(reports[0]?.process).toBe("terminated");
      expect(reports[0]?.issues).toEqual([]);
    }),
  ),
);

it.live(
  "Capture.stream is lazy and releases each subscription after take, failure and interruption",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* localSite;

        yield* Browser.scoped(Chromium.launch(policy), (browser) =>
          Effect.gen(function* () {
            yield* browser.navigate({ url: site.url });
            const frames = Capture.stream(browser, { lifetime: "page", maxDurationMillis: 10000 });

            // Constructing a stream must not reserve the page. A separate explicit interval can start.
            yield* Effect.scoped(
              Capture.start(browser).pipe(Effect.flatMap((interval) => interval.stop)),
            );

            const first = yield* frames.pipe(Stream.take(1), Stream.runCollect);

            expect(first).toHaveLength(1);
            const consumerFailure = { _tag: "EncoderFailure" };

            const failed = yield* frames.pipe(
              Stream.mapEffect(() => Effect.fail(consumerFailure)),
              Stream.runDrain,
              Effect.flip,
            );

            expect(failed).toBe(consumerFailure);

            const received = yield* Deferred.make<void>();

            const consumer = yield* frames.pipe(
              Stream.tap(() => Deferred.succeed(received, undefined)),
              Stream.runDrain,
              Effect.forkScoped,
            );

            yield* Deferred.await(received);
            yield* Fiber.interrupt(consumer);

            const restarted = yield* frames.pipe(Stream.take(1), Stream.runCollect);

            expect(restarted).toHaveLength(1);
            yield* browser.click({ selector: "#increment" });
            expect((yield* browser.readText({ selector: "#count" })).text).toBe("1");
          }),
        ).pipe(Effect.provide(Chromium.layer({ launch }).pipe(Layer.provide(NodeCrypto.layer))));
      }),
    ),
);
