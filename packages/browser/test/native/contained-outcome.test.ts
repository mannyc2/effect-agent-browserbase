import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import type { Page } from "effect-browser/browser";
import {
  BrowserPolicy,
  ClickRequest,
  NavigateRequest,
  type Observation,
  ObservedElement,
  ReadTextRequest,
} from "effect-browser/browser-data";
import * as BrowserRuntime from "effect-browser/browser-runtime";
import * as Capture from "effect-browser/capture";
import { Chromium } from "effect-browser/chromium";
import type { BrowserError } from "effect-browser/errors";
import type { Browser as PlaywrightBrowser, Page as PlaywrightPage } from "playwright-core";

import { externalChromium, localSite } from "../fixtures/StandaloneBrowser.ts";

const launch = {
  ...(process.env.BROWSERBASE_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
  chromiumSandbox: false,
  startupTimeoutMillis: 25000,
};

const reference = (observation: Observation, label: string) => {
  const control = observation.controls.find((control) => control.label === label);

  if (control === undefined) throw new Error(`The native fixture has no ${label} control`);

  return ObservedElement.make({
    observationId: observation.observationId,
    elementId: control.elementId,
  });
};

// #94 page containment must retire setup callbacks as well as already admitted consumers.
it.live("retired native page initialization cannot publish readiness or fault a healthy page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;
      const host = yield* externalChromium;
      const entered = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();

      const readinessGates = yield* Effect.forEach([0, 1], () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          let release = () => {};

          const held = new Promise<void>((resolve) => {
            release = resolve;
          });

          return { entered, held, release, calls: 0 };
        }),
      );

      const nativePages = new Map<PlaywrightPage, (typeof readinessGates)[number]>();
      let setupRejected = false;
      let release = () => {};

      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const runtime = yield* BrowserRuntime.make({
        implementation: "native-contained-binding-setup",
        automation: { actionTimeoutMillis: 2000 },
        binding: BrowserRuntime.playwright({
          onConnected: ({ native }) => {
            const browser = native as PlaywrightBrowser;
            const context = browser.contexts()[0];
            const first = context?.pages()[0];

            if (context === undefined || first === undefined)
              throw new Error("The native fixture has no initial page");
            const connect = context.newCDPSession.bind(context);

            context.newCDPSession = async (subject) => {
              const cdp = await connect(subject);

              if (subject !== first && "mainFrame" in subject) {
                if (!nativePages.has(subject)) {
                  const gate = readinessGates[nativePages.size];

                  if (gate === undefined) throw new Error("Unexpected native readiness page");
                  nativePages.set(subject, gate);
                  const frame = subject.mainFrame();

                  frame.evaluate = new Proxy(frame.evaluate.bind(frame), {
                    apply: (evaluate, receiver: unknown, args: ReadonlyArray<unknown>) => {
                      const result: unknown = Reflect.apply(evaluate, receiver, args);

                      if (args[0] !== "globalThis.__pageReady") return result;
                      if (!(result instanceof Promise))
                        throw new Error("Native readiness evaluation returned no Promise");
                      const pending: Promise<unknown> = result;

                      gate.calls++;

                      return pending.then((value) => {
                        expect(value).toBe(true);
                        Deferred.doneUnsafe(gate.entered, Effect.void);

                        return gate.held.then(() => value);
                      });
                    },
                  });
                }
                const send = cdp.send.bind(cdp);

                cdp.send = (method, params) => {
                  if (method !== "Runtime.enable") return send(method, params);
                  Deferred.doneUnsafe(entered, Effect.void);

                  // Forward the genuine command after closure; no native reply is manufactured.
                  return held
                    .then(() => send(method, params))
                    .catch((cause: unknown) => {
                      setupRejected = true;
                      throw cause;
                    })
                    .finally(() => Deferred.doneUnsafe(finished, Effect.void));
                };
              }

              return cdp;
            };
          },
        }),
      }).pipe(Effect.provide(NodeCrypto.layer));

      const bootstrap = Bootstrap.combine(
        Bootstrap.binding({
          name: "pageSetup",
          origins: [new URL(site.url).origin],
          input: Schema.String,
          output: Schema.String,
          handle: Effect.succeed,
        }),
        Bootstrap.init({
          id: "ready-page",
          origins: [new URL(site.url).origin],
          content: "globalThis.__pageReady = true;",
          readiness: {
            expression: "globalThis.__pageReady",
            timeoutMillis: 5000,
            existingDocuments: "RequireFreshNavigation",
          },
        }),
      );

      const acquired = yield* runtime.acquire(
        BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        (cleanup) =>
          Effect.gen(function* () {
            const close = yield* Effect.cached(
              cleanup.fence.pipe(
                Effect.andThen(cleanup.capture),
                Effect.andThen(cleanup.initialization),
                Effect.andThen(cleanup.disconnect),
                Effect.orDie,
                Effect.ensuring(Effect.promise(host.close)),
                Effect.asVoid,
              ),
            );

            yield* Effect.addFinalizer(() => close);

            return {
              reference: "native-contained-binding-setup",
              connection: () => Effect.succeed(host.endpoint),
              release: close,
              cleanupResult: Effect.succeedNone,
              closeChecked: close,
              controlRetired: Effect.sync(() => !host.running()),
            };
          }),
        { bootstrap },
      );

      const { session } = yield* acquired.connect;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          release();
          for (const gate of readinessGates) gate.release();
        }),
      );
      const healthy = session.initialPage;

      yield* healthy.navigate({ url: new URL("/pinned?name=healthy", site.url).href });
      const retired = yield* session.createPage();

      yield* retired.navigate({ url: new URL("/pinned?name=retired", site.url).href });
      const firstGate = readinessGates[0];
      const secondGate = readinessGates[1];

      if (firstGate === undefined || secondGate === undefined)
        throw new Error("The native readiness fixture has no reply gates");
      const waiting = yield* retired.ready().pipe(Effect.result, Effect.forkChild);

      yield* Deferred.await(firstGate.entered);
      const firstNative = [...nativePages.keys()][0];

      if (firstNative === undefined) throw new Error("The native readiness fixture has no page");
      yield* Effect.promise(() => firstNative.close({ runBeforeUnload: false }));
      yield* Effect.sync(firstGate.release);
      const retiredResult = yield* Fiber.join(waiting);
      const pending = yield* session.createPage();

      yield* pending.navigate({ url: new URL("/pinned?name=pending", site.url).href });
      const timedOut = yield* pending.ready({ timeoutMillis: 100 }).pipe(Effect.result);
      const repeated = yield* pending.ready({ timeoutMillis: 100 }).pipe(Effect.result);
      const rawCalls = secondGate.calls;

      yield* pending.close();
      yield* Effect.sync(secondGate.release);
      const afterClose = yield* pending.ready().pipe(Effect.result);

      yield* Effect.sync(release);
      yield* Deferred.await(finished);
      expect(setupRejected).toBe(true);
      expect({ retiredResult, repeated, rawCalls }).toMatchObject({
        retiredResult: { _tag: "Failure" },
        repeated: { _tag: "Failure", failure: { reason: "busy" } },
        rawCalls: 1,
      });
      if (retiredResult._tag === "Failure")
        expect(["closed", "stale"]).toContain(retiredResult.failure.reason);
      expect(timedOut).toMatchObject({ _tag: "Failure", failure: { reason: "timeout" } });
      expect(repeated).toMatchObject({ _tag: "Failure", failure: { reason: "busy" } });
      expect(rawCalls).toBe(1);
      expect(afterClose._tag).toBe("Failure");
      expect(secondGate.calls).toBe(rawCalls);
      expect((yield* session.bindingDiagnostics).faulted).toBe(false);
      // A following owner operation runs after the observed genuine setup rejection settles.
      yield* healthy.click({ selector: "#increment" });
      expect((yield* healthy.readText({ selector: "#count" })).text).toBe("1");
      expect((yield* session.bindingDiagnostics).faulted).toBe(false);
      expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
      yield* session.closeChecked;
      expect(host.running()).toBe(false);
    }),
  ),
);

// #94 names independent Page/Frame observations and selection-independent exact authority.
it.live(
  "one page's inspection and input leave another page's main and child references usable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* localSite;

        const session = yield* (yield* Chromium).launch(
          BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        );

        const stage = session.initialPage;

        yield* stage.navigate({ url: new URL("/pinned?name=stage", site.url).href });
        expect(yield* session.page(yield* stage.describe())).toBe(stage);
        const main = reference(yield* stage.observe(), "Increment");
        const child = (yield* stage.listFrames()).find((frame) => frame.parentFrameId !== null);

        if (child === undefined) throw new Error("The native fixture has no child frame");
        const nestedFrame = yield* stage.frame(child);
        const nested = reference(yield* nestedFrame.observe(), "Increment frame");
        const scout = yield* session.createPage();

        yield* scout.navigate({ url: new URL("/pinned?name=scout", site.url).href });
        yield* session.selectPage(scout);
        expect(yield* scout.clickElement(main).pipe(Effect.flip)).toMatchObject({
          outcome: "undispatched",
        });
        expect((yield* scout.readText({ selector: "#count" })).text).toBe("0");
        const scouting = reference(yield* scout.observe(), "Increment");

        yield* scout.clickElement(scouting);
        expect((yield* scout.screenshot({ fullPage: false })).bytes.length).toBeGreaterThan(0);
        expect((yield* scout.readText({ selector: "#count" })).text).toBe("1");

        // B remains selected for display while A and its child retain their own authority.
        expect((yield* stage.controlFacts(main)).label).toBe("Increment");
        expect((yield* nestedFrame.controlFacts(nested)).label).toBe("Increment frame");
        yield* stage.clickElement(main);
        expect((yield* stage.readText({ selector: "#count" })).text).toBe("1");
        expect((yield* scout.readText({ selector: "#count" })).text).toBe("1");
        expect((yield* scout.describe()).selected).toBe(true);
        expect((yield* stage.describe()).selected).toBe(false);
      }),
    ).pipe(Effect.provide(Chromium.layer({ launch }).pipe(Layer.provide(NodeCrypto.layer)))),
);

it.live(
  "an unknown selected-page click closes that page and its capture while the other page keeps working",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* localSite;

        const session = yield* (yield* Chromium).launch(
          BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        );

        const selected = session.initialPage;

        yield* selected.navigate({ url: site.url });
        const healthy = yield* session.createPage();

        yield* healthy.navigate({ url: new URL("/pinned?name=healthy", site.url).href });
        expect((yield* selected.describe()).selected).toBe(true);

        const doomedCapture = yield* Capture.start(selected, {
          lifetime: "page",
          maxFrames: 2,
          maxBufferedBytes: 1024 * 1024,
          maxFrameBytes: 1024 * 1024,
          maxDurationMillis: 10000,
        });

        const survivingCapture = yield* Capture.start(healthy, {
          lifetime: "page",
          maxFrames: 2,
          maxBufferedBytes: 1024 * 1024,
          maxFrameBytes: 1024 * 1024,
          maxDurationMillis: 10000,
        });

        expect(yield* selected.click({ selector: "#motion" }).pipe(Effect.flip)).toMatchObject({
          operation: "click",
          outcome: "unknown",
        });
        expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
        expect(yield* selected.describe().pipe(Effect.flip)).toMatchObject({
          outcome: "undispatched",
        });
        expect((yield* doomedCapture.completed).reason).toBe("target-changed");
        expect(yield* doomedCapture.completed).toMatchObject({
          qualification: {
            authority: "closed",
            containment: { _tag: "PageClosed", pageId: selected.identity.pageId },
            ownerPhase: "open",
          },
          error: { containment: { _tag: "PageClosed", pageId: selected.identity.pageId } },
        });
        expect(yield* Capture.start(selected).pipe(Effect.flip)).toMatchObject({
          outcome: "undispatched",
        });
        expect((yield* survivingCapture.snapshot).phase).toBe("capturing");
        expect(yield* selected.status).toMatchObject({
          phase: "closed",
          containment: { _tag: "PageClosed", pageId: selected.identity.pageId },
        });
        yield* healthy.click({ selector: "#increment" });
        expect((yield* healthy.readText({ selector: "#count" })).text).toBe("1");
        const frames = yield* survivingCapture.frames.pipe(Stream.take(1), Stream.runCollect);

        expect(frames.length).toBe(1);
        expect(frames[0]?.target.pageId).toBe(healthy.identity.pageId);
        expect(yield* session.listPages()).toHaveLength(1);
      }),
    ).pipe(
      Effect.provide(
        Chromium.layer({ launch, actionTimeoutMillis: 2000 }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    ),
);

it.live(
  "leaving an unresolved navigation scope closes only its page and retains the unknown outcome",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* localSite;

        const session = yield* (yield* Chromium).launch(
          BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        );

        const abandoned = session.initialPage;

        yield* abandoned.navigate({ url: new URL("/pinned?name=abandoned", site.url).href });
        const healthy = yield* session.createPage();

        yield* healthy.navigate({ url: new URL("/pinned?name=healthy", site.url).href });

        const operation = yield* Effect.scoped(
          abandoned.startNavigation({ url: new URL("/pinned-slow", site.url).href }),
        );

        expect(yield* operation.completed.pipe(Effect.flip)).toMatchObject({
          operation: "navigate",
          outcome: "unknown",
        });
        expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
        expect(yield* abandoned.describe().pipe(Effect.flip)).toMatchObject({
          outcome: "undispatched",
        });
        expect(yield* abandoned.status).toMatchObject({
          phase: "closed",
          containment: { _tag: "PageClosed", pageId: abandoned.identity.pageId },
        });
        yield* healthy.click({ selector: "#increment" });
        expect((yield* healthy.readText({ selector: "#count" })).text).toBe("1");
        expect(yield* session.listPages()).toHaveLength(1);
      }),
    ).pipe(
      Effect.provide(
        Chromium.layer({ launch, actionTimeoutMillis: 2000 }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    ),
);

// In Bando a planner's click on a background page timed out and fenced the whole session,
// taking the page on air down with it.
it.live("a click that never lands on a background page closes only that page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;

      const entered = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<BrowserError>();
      let plannerAuthority: Page | undefined;

      const bootstrap = Bootstrap.combine(
        Bootstrap.binding({
          name: "pageWork",
          origins: [new URL(site.url).origin],
          input: Schema.String,
          output: Schema.String,
          maxConcurrent: 2,
          timeoutMillis: 30000,
          failureMode: "fail-session",
          handle: (input) =>
            input === "healthy"
              ? Effect.succeed("healthy")
              : Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      if (plannerAuthority === undefined)
                        throw new Error("The native fixture has no planner authority");

                      const result = yield* plannerAuthority
                        .click({ selector: "#increment" })
                        .pipe(Effect.result);

                      if (result._tag === "Success")
                        throw new Error("A contained page accepted finalizer input");
                      yield* Deferred.succeed(finalized, result.failure);
                    }),
                  );
                  yield* Deferred.succeed(entered, undefined);

                  return yield* Effect.never;
                }),
        }),
        Bootstrap.init({
          id: "page-work",
          origins: [new URL(site.url).origin],
          content: `
            if (window === window.top) {
              document.addEventListener("DOMContentLoaded", () => {
                pageWork(location.pathname === "/" ? "held" : "healthy").then((reply) => {
                  const marker = document.createElement("output");
                  marker.id = "binding-result";
                  marker.textContent = reply;
                  document.body.append(marker);
                }).catch(() => {});
              }, { once: true });
            }
          `,
        }),
      );

      const session = yield* (yield* Chromium).launch(
        BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        { bootstrap },
      );

      const stage = session.initialPage;

      yield* stage.navigate(
        NavigateRequest.make({ url: new URL("/pinned?name=stage", site.url).href }),
      );
      const planner = yield* session.createPage();

      plannerAuthority = planner;
      yield* planner.navigate({ url: site.url });

      yield* Deferred.await(entered);

      // The box never stops moving, so the engine's click is sent and never finishes.
      expect(
        yield* planner.click(ClickRequest.make({ selector: "#motion" })).pipe(Effect.flip),
      ).toMatchObject({ operation: "click", outcome: "unknown" });
      expect(yield* Deferred.await(finalized).pipe(Effect.timeoutOption(1000))).toMatchObject({
        _tag: "Some",
        value: { reason: { _tag: "Stale" }, outcome: "undispatched" },
      });
      expect((yield* session.bindingDiagnostics).faulted).toBe(false);
      expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
      expect((yield* session.diagnostics).records).toMatchObject([
        { reason: "page-contained", disposition: "confirmed" },
      ]);
      expect(yield* session.listPages()).toMatchObject([{ selected: true }]);
      expect(yield* planner.describe().pipe(Effect.flip)).toMatchObject({
        outcome: "undispatched",
      });

      yield* stage.click(ClickRequest.make({ selector: "#increment" }));
      expect((yield* stage.readText(ReadTextRequest.make({ selector: "#count" }))).text).toBe("1");
      yield* stage.navigate({ url: new URL("/pinned?name=healthy", site.url).href });
      yield* stage.waitFor({ selector: "#binding-result", state: "attached" });
      expect((yield* stage.readText({ selector: "#binding-result" })).text).toBe("healthy");
      expect((yield* session.bindingDiagnostics).faulted).toBe(false);
      expect(yield* (yield* session.createPage()).describe()).toMatchObject({ selected: false });
    }),
  ).pipe(
    Effect.provide(
      Chromium.layer({ launch, actionTimeoutMillis: 2000 }).pipe(Layer.provide(NodeCrypto.layer)),
    ),
  ),
);

it.live("a delayed genuine native registration failure still faults after its page closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;
      const host = yield* externalChromium;
      const entered = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      let nativePage: PlaywrightPage | undefined;
      let nativeFailure: unknown;
      let release = () => {};

      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const runtime = yield* BrowserRuntime.make({
        implementation: "native-retired-registration-failure",
        automation: { actionTimeoutMillis: 2000 },
        binding: BrowserRuntime.playwright({
          onConnected: ({ native }) => {
            const browser = native as PlaywrightBrowser;
            const context = browser.contexts()[0];
            const first = context?.pages()[0];

            if (context === undefined || first === undefined)
              throw new Error("The native fixture has no initial page");
            const connect = context.newCDPSession.bind(context);

            context.newCDPSession = async (subject) => {
              const cdp = await connect(subject);

              if (subject !== first && "mainFrame" in subject) {
                nativePage = subject;
                const send = cdp.send.bind(cdp);

                cdp.send = (method, params) => {
                  if (method !== "Runtime.enable") return send(method, params);

                  // Chromium rejects this real registration before closure. Only delivery of
                  // its original rejection is delayed; closure must not erase that failure.
                  return send("Runtime.addBinding", {
                    name: "retiredRegistrationFailure",
                    executionContextId: -1,
                  })
                    .then(() => send(method, params))
                    .catch((cause: unknown) => {
                      nativeFailure = cause;
                      Deferred.doneUnsafe(entered, Effect.void);

                      return held.then(() => {
                        throw cause;
                      });
                    })
                    .finally(() => Deferred.doneUnsafe(finished, Effect.void));
                };
              }

              return cdp;
            };
          },
        }),
      }).pipe(Effect.provide(NodeCrypto.layer));

      const bootstrap = Bootstrap.binding({
        name: "registrationWork",
        origins: [new URL(site.url).origin],
        input: Schema.String,
        output: Schema.String,
        handle: Effect.succeed,
      });

      const acquired = yield* runtime.acquire(
        BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        (cleanup) =>
          Effect.gen(function* () {
            const close = yield* Effect.cached(
              cleanup.fence.pipe(
                Effect.andThen(cleanup.capture),
                Effect.andThen(cleanup.initialization),
                Effect.andThen(cleanup.disconnect),
                Effect.orDie,
                Effect.ensuring(Effect.promise(host.close)),
                Effect.asVoid,
              ),
            );

            yield* Effect.addFinalizer(() => close);

            return {
              reference: "native-retired-registration-failure",
              connection: () => Effect.succeed(host.endpoint),
              release: close,
              cleanupResult: Effect.succeedNone,
              closeChecked: close,
              controlRetired: Effect.sync(() => !host.running()),
            };
          }),
        { bootstrap },
      );

      const { session } = yield* acquired.connect;

      yield* Effect.addFinalizer(() => Effect.sync(release));
      const healthy = session.initialPage;

      yield* healthy.navigate({ url: new URL("/pinned?name=healthy", site.url).href });
      const retired = yield* session.createPage();

      yield* Deferred.await(entered);
      expect(nativeFailure).toBeInstanceOf(Error);
      if (!(nativeFailure instanceof Error)) throw new Error("Native registration did not fail");
      expect(nativeFailure.message).toBe(
        "cdpSession.send: Protocol error (Runtime.addBinding): Cannot find execution context with given executionContextId",
      );
      if (nativePage === undefined) throw new Error("The native fixture has no registration page");
      yield* retired.close();
      expect(nativePage.isClosed()).toBe(true);
      expect(yield* session.status).toMatchObject({ phase: "open" });
      yield* healthy.click({ selector: "#increment" });
      expect((yield* healthy.readText({ selector: "#count" })).text).toBe("1");

      yield* Effect.sync(release);
      yield* Deferred.await(finished);
      const failure = yield* session.failure.pipe(Effect.flip, Effect.timeoutOption(1000));

      expect(failure).toMatchObject({
        _tag: "Some",
        value: {
          _tag: "InitializationError",
          operation: "register",
          step: "bindings",
          reason: "native",
        },
      });
      expect((yield* session.bindingDiagnostics).faulted).toBe(true);
      yield* Effect.yieldNow;
      expect(yield* session.status).toMatchObject({
        phase: "uncertain",
        reason: "registration-failure",
      });
      expect(yield* healthy.click({ selector: "#increment" }).pipe(Effect.flip)).toMatchObject({
        outcome: "undispatched",
      });
      yield* session.closeChecked;
      expect(host.running()).toBe(false);
    }),
  ),
);
