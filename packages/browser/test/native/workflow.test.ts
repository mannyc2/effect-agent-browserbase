import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schedule, Stream } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as BrowserRuntime from "effect-browser/browser-runtime";
import * as Capture from "effect-browser/capture";
import { Chromium, type ChromiumCleanupResult } from "effect-browser/chromium";
import { BrowserError, Reasons } from "effect-browser/errors";
import type { Browser as PlaywrightBrowser, Dialog as PlaywrightDialog } from "playwright-core";

import { externalChromium, localSite } from "../fixtures/StandaloneBrowser.ts";

const policy = BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 });

const launch = {
  ...(process.env.BROWSERBASE_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
  chromiumSandbox: false,
  startupTimeoutMillis: 25000,
};

const keyboardFixture = Effect.fnUntraced(function* (
  automation: { readonly dialogPolicy?: "dismiss" | "pause" } = {},
  bootstrap?: (origin: string) => Bootstrap.Plan<never, never>,
) {
  const site = yield* localSite;
  const host = yield* externalChromium;
  let native: PlaywrightBrowser | undefined;

  const runtime = yield* BrowserRuntime.make({
    implementation: "native-keyboard-workflow",
    automation,
    binding: BrowserRuntime.playwright({
      onConnected: (connection) => {
        native = connection.native as PlaywrightBrowser;
      },
    }),
  }).pipe(Effect.provide(NodeCrypto.layer));

  const acquired = yield* runtime.acquire(
    policy,
    (cleanup) =>
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
    bootstrap === undefined ? undefined : { bootstrap: bootstrap(new URL(site.url).origin) },
  );

  const { session, operations } = yield* acquired.connect;

  if (native === undefined)
    throw new Error("The public runtime did not connect its native browser");
  const page = native.contexts().flatMap((context) => context.pages())[0];

  if (page === undefined) throw new Error("The native keyboard workflow has no page");

  return { session, operations, page, host, url: new URL("keyboard", site.url).href };
});

it.live.each(["inventory", "second-dismissal"] as const)(
  "resume retains each dialog's native acknowledgement before a %s failure",
  (failureAt) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, operations, page, host, url } = yield* keyboardFixture({
          dialogPolicy: "pause",
        });

        const initial = session.initialPage;

        yield* initial.navigate({ url });
        yield* session.createPage();

        const other = page
          .context()
          .pages()
          .find((candidate) => candidate !== page);

        if (other === undefined) throw new Error("The native dialog workflow has no second page");
        const dialogs = yield* Deferred.make<void>();
        const pendingDialogs: PlaywrightDialog[] = [];
        const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
        let submitted = 0;
        let acknowledged = 0;

        for (const native of [page, other])
          native.once("dialog", (dialog) => {
            const index = pendingDialogs.length;
            const dismiss = dialog.dismiss.bind(dialog);

            pendingDialogs.push(dialog);
            dialog.dismiss = () => {
              submitted++;

              const work =
                failureAt === "second-dismissal" && index === 1
                  ? cdp
                      .send("Runtime.addBinding", {
                        name: "resumeDismissalFailure",
                        executionContextId: -1,
                      })
                      .then(() => dismiss())
                  : dismiss();

              return work.then(() => {
                acknowledged++;
              });
            };
            if (pendingDialogs.length === 2) Deferred.doneUnsafe(dialogs, Effect.void);
          });

        const evaluations = [page, other].map((native) =>
          native.evaluate("alert('resume acknowledgement')").catch(() => {}),
        );

        yield* Deferred.await(dialogs);
        expect(yield* initial.status).toMatchObject({ phase: "paused" });
        const handoff = yield* operations.beginHandoff(Effect.succeed({ granted: true }));
        const title = page.title.bind(page);

        if (failureAt === "inventory")
          // Fail the following real native metadata read after both dialog dismissals settle.
          page.title = () =>
            cdp
              .send("Runtime.addBinding", {
                name: "resumeInventoryFailure",
                executionContextId: -1,
              })
              .then(() => title());
        const result = yield* operations.resume(handoff.token, true).pipe(Effect.flip);

        expect(submitted).toBe(2);
        expect(acknowledged).toBe(failureAt === "inventory" ? 2 : 1);
        expect(result).toMatchObject({
          operation: "resume",
          reason: { _tag: failureAt === "inventory" ? "Provider" : "Stale" },
          outcome: failureAt === "inventory" ? "performed" : "unknown",
          containment: { _tag: failureAt === "inventory" ? "NotRequired" : "SessionFenced" },
        });
        expect(yield* session.status).toMatchObject({
          phase: failureAt === "inventory" ? "paused" : "uncertain",
          unresolvedDispatch: failureAt !== "inventory",
        });

        if (failureAt === "inventory") {
          page.title = title;
          const inventory = yield* operations.resume(handoff.token, true);

          expect(inventory.pages).toHaveLength(2);
          expect(submitted).toBe(2);
          expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
          expect(yield* initial.status).toMatchObject({ phase: "stale" });

          const info = inventory.pages.find(
            (candidate) => candidate.pageId === initial.identity.pageId,
          );

          if (info === undefined) throw new Error("The resumed inventory lost the original page");
          const fresh = yield* session.page(info);

          yield* fresh.click({ selector: "#first" });
        }
        yield* session.closeChecked;
        yield* Effect.promise(() => Promise.all(evaluations));
        expect(host.running()).toBe(false);
      }),
    ),
);

it.live(
  "a dialog opened by an exact click pauses that page for the operator instead of closing it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, operations, page, host, url } = yield* keyboardFixture({
          dialogPolicy: "pause",
        });

        const initial = session.initialPage;

        yield* initial.navigate({ url: new URL("confirm", url).href });
        const failure = yield* initial.click({ selector: "#ask" }).pipe(Effect.flip);

        // The click opened the dialog, so its effect is unknown; the page's quarantine contains it.
        expect(failure).toMatchObject({
          operation: "click",
          outcome: "unknown",
          containment: { _tag: "PagePaused", pageId: initial.identity.pageId },
        });
        expect(page.isClosed()).toBe(false);
        expect(yield* initial.status).toMatchObject({ phase: "paused" });
        expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
        expect(yield* initial.click({ selector: "#other" }).pipe(Effect.flip)).toMatchObject({
          outcome: "undispatched",
        });

        // The quarantined click does not hold up the handoff that lets an operator release it.
        const handoff = yield* operations.beginHandoff(Effect.succeed({ granted: true }));
        const inventory = yield* operations.resume(handoff.token, true);

        const info = inventory.pages.find(
          (candidate) => candidate.pageId === initial.identity.pageId,
        );

        if (info === undefined) throw new Error("The resumed inventory lost the paused page");
        // Releasing the dialog lets the paused click finish natively. Issuing the fresh Page does
        // not wait for the page; its first read does.
        const fresh = yield* session.page(info);

        expect(
          (yield* fresh.readText({ selector: "#answer" }, { admission: { queue: "5 seconds" } }))
            .text,
        ).toBe("false");
        yield* fresh.click({ selector: "#other" });
        expect((yield* fresh.readText({ selector: "#count" })).text).toBe("1");
        yield* session.closeChecked;
        expect(host.running()).toBe(false);
      }),
    ),
);

it.live(
  "a quarantined page's pending bootstrap readiness holds up neither its handoff nor its release",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, operations, page, url } = yield* keyboardFixture(
          { dialogPolicy: "pause" },
          (origin) =>
            Bootstrap.init({
              id: "never-ready",
              origins: [origin],
              content: "globalThis.__neverReady = true;",
              readiness: {
                expression: "new Promise(() => {})",
                timeoutMillis: 30000,
                existingDocuments: "RequireFreshNavigation",
              },
            }),
        );

        const initial = session.initialPage;
        const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));

        yield* Effect.promise(() => cdp.send("Page.enable"));
        yield* initial.navigate({ url: new URL("confirm-later", url).href });
        // A read waits on readiness that never comes; its caller gives up and the native
        // evaluation stays pending.
        yield* initial.readText({ selector: "title" }, { timeoutMillis: 200 }).pipe(Effect.flip);
        // The page's own dialog quarantines it for an operator.
        yield* initial.status.pipe(
          Effect.repeat({
            until: (status) => status.phase === "paused",
            schedule: Schedule.spaced(50),
          }),
          Effect.timeout("10 seconds"),
        );

        // If the handoff fails, answer the dialog so the fixture's teardown is not left behind it.
        const answered = Effect.promise(() =>
          cdp.send("Page.handleJavaScriptDialog", { accept: false }),
        ).pipe(Effect.ignore);

        const handoff = yield* operations
          .beginHandoff(Effect.succeed({ granted: true }))
          .pipe(Effect.onError(() => answered));

        expect(handoff.view).toEqual({ granted: true });
        // Release answers the dialog; restoring the page cannot require the readiness work the
        // handoff left running.
        yield* operations.resume(handoff.token, true);
        yield* session.closeChecked;
      }),
    ),
);

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
            yield* browser.initialPage.navigate({ url });
            yield* browser.initialPage.click({ selector: "#first" });
            yield* Effect.promise(() => page.keyboard.type(text));

            const expectedEvents = (yield* browser.initialPage.readText({ selector: "#events" }))
              .text;

            yield* browser.initialPage.navigate({ url });
            yield* browser.initialPage.click({ selector: "#first" });
            const before = (yield* browser.status).actions.used;
            const receipt = yield* browser.initialPage.type({ text, into: "#first" });

            expect(receipt.kind).toBe("type");
            expect((yield* browser.status).actions.used).toBe(before + 1);
            const events = (yield* browser.initialPage.readText({ selector: "#events" })).text;

            expect(events).toBe(expectedEvents);
            expect(
              (JSON.parse(events) as ReadonlyArray<ReadonlyArray<unknown>>).every(
                (event) => event[11] === true,
              ),
            ).toBe(true);
            expect((yield* browser.initialPage.readText({ selector: "#values" })).text).toBe(
              JSON.stringify([text, ""]),
            );

            yield* browser.initialPage.navigate({ url });
            yield* browser.initialPage.click({ selector: "#first" });
            yield* browser.initialPage.type({ text: "a", into: "#first" });
            yield* browser.initialPage.press({ key: "A", modifiers: ["Shift"], into: "#first" });
            yield* browser.initialPage.type({ text: "b", into: "#first" });
            expect((yield* browser.initialPage.readText({ selector: "#values" })).text).toBe(
              JSON.stringify(["aAb", ""]),
            );

            const finalEvents = JSON.parse(
              (yield* browser.initialPage.readText({ selector: "#events" })).text,
            ) as ReadonlyArray<ReadonlyArray<unknown>>;

            const finalKeyDown = finalEvents.filter(
              (event) => event[0] === "keydown" && event[2] === "b",
            );

            expect(finalKeyDown).toHaveLength(1);
            expect(finalKeyDown[0]?.[4]).toBe(false);
            expect(finalKeyDown[0]?.[5]).toBe(false);

            yield* browser.initialPage.click({ selector: "#second" });

            const previousEvents = (yield* browser.initialPage.readText({ selector: "#events" }))
              .text;

            const notFocused = yield* browser.initialPage
              .type({ text: "must not land", into: "#first" })
              .pipe(Effect.flip);

            expect(notFocused).toMatchObject({
              reason: { _tag: "NotFocused" },
              outcome: "undispatched",
            });
            expect((yield* browser.initialPage.readText({ selector: "#events" })).text).toBe(
              previousEvents,
            );
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
      const context = page.context();
      const connect = context.newCDPSession.bind(context);
      const input = { submitted: 0, acknowledged: 0 };

      context.newCDPSession = async (target) => {
        const port = await connect(target);

        if (target === page) {
          const send = port.send.bind(port);

          port.send = (method, params) => {
            if (method !== "Input.dispatchKeyEvent" && method !== "Input.insertText")
              return send(method, params);
            input.submitted++;

            return send(method, params).then((result) => {
              input.acknowledged++;

              return result;
            });
          };
        }

        return port;
      };

      yield* Browser.scoped(Effect.succeed(session), (browser) =>
        Effect.gen(function* () {
          yield* browser.initialPage.navigate({ url: `${url}?moveAfter=1` });
          yield* browser.initialPage.click({ selector: "#first" });
          const before = (yield* browser.status).actions.used;

          const result = yield* browser.initialPage
            .type({ text: "a".repeat(80), into: "#first" })
            .pipe(Effect.exit);

          const values = yield* Effect.promise(() => page.locator("#values").textContent());

          expect(values).not.toBeNull();
          const [first, second] = JSON.parse(values ?? "[]") as [string, string];

          expect(first).toBe("a");
          expect(second.length).toBeLessThanOrEqual(15);
          expect(first.length + second.length).toBe(16);
          // The acknowledged window drained completely; revalidation submits no later window.
          expect(input).toEqual({ submitted: 32, acknowledged: 32 });

          const errors = Exit.isFailure(result)
            ? result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
            : [];

          expect(errors).toContainEqual(
            expect.objectContaining({
              reason: expect.objectContaining({ _tag: "NotFocused" }),
              outcome: "performed",
              containment: expect.objectContaining({ _tag: "NotRequired" }),
            }),
          );
          expect((yield* browser.status).actions.used).toBe(before + 1);
          expect(yield* browser.status).toMatchObject({
            phase: "open",
            unresolvedDispatch: false,
          });
        }),
      );
      expect(input).toEqual({ submitted: 32, acknowledged: 32 });
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
          yield* browser.initialPage.navigate({ url: site.url });
          yield* Effect.addFinalizer(() =>
            browser.initialPage.readText({ selector: "#count" }).pipe(
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
            yield* browser.initialPage.navigate({ url: site.url });

            const frames = Capture.stream(browser.initialPage, {
              lifetime: "page",
              maxDurationMillis: 10000,
            });

            // Constructing a stream must not reserve the page. A separate explicit interval can start.
            yield* Effect.scoped(
              Capture.start(browser.initialPage).pipe(Effect.flatMap((interval) => interval.stop)),
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
            yield* browser.initialPage.click({ selector: "#increment" });
            expect((yield* browser.initialPage.readText({ selector: "#count" })).text).toBe("1");
          }),
        ).pipe(Effect.provide(Chromium.layer({ launch }).pipe(Layer.provide(NodeCrypto.layer))));
      }),
    ),
);
