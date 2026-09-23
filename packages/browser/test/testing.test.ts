import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Fiber, Option, Redacted, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as Bootstrap from "../src/Bootstrap.ts";
import * as Browser from "../src/Browser.ts";
import { BrowserPolicy, ObservedElement } from "../src/BrowserData.ts";
import * as BrowserRuntime from "../src/BrowserRuntime.ts";
import * as Capture from "../src/Capture.ts";
import { Reasons } from "../src/Errors.ts";
import * as PageControl from "../src/PageControl.ts";
import * as Testing from "../src/Testing.ts";

const origin = "https://shop.test";

const shop: Testing.Script = {
  documents: [
    {
      url: `${origin}/`,
      title: "Shop",
      text: "Welcome. We use cookies.",
      controls: [
        { id: "accept", kind: "button", label: "Accept all", activates: `${origin}/?consent=1` },
        { id: "name", kind: "input", label: "Name", inputType: "text" },
        {
          id: "phish",
          kind: "link",
          label: "Accept all",
          destination: "https://evil.test/",
          offscreen: true,
        },
        { id: "size", kind: "select", label: "Size", multiple: false },
        { id: "small", kind: "other", label: "Small", selectElementId: "size", selected: true },
        { id: "large", kind: "other", label: "Large", selectElementId: "size", selected: false },
        { id: "report", kind: "link", label: "Report", download: "report.csv" },
        { id: "upload", kind: "input", label: "Upload", inputType: "file" },
      ],
    },
    { url: `${origin}/?consent=1`, text: "Welcome back." },
  ],
};

const reference = (observation: { observationId: string }, elementId: string) =>
  ObservedElement.make({ observationId: observation.observationId, elementId });

const acceptCookies = (browser: Browser.AnySession) =>
  Effect.gen(function* () {
    const observation = yield* browser.observe({ scope: "viewport" });

    const accept = observation.controls.find((c) => c.label === "Accept all");

    if (accept === undefined) return "absent" as const;
    yield* browser.clickElement(reference(observation, accept.elementId), {
      admit: (facts) => facts.destination === undefined || facts.destination.startsWith(origin),
    });

    return "accepted" as const;
  });

it.effect("opens the real owner over the scripted engine and closes it with a receipt", () =>
  Effect.gen(function* () {
    const receipts: Testing.ScriptedCleanupResult[] = [];
    let kept: Testing.ScriptedSession | undefined;

    const outcome = yield* Browser.scoped(
      Testing.open(shop, {
        onCleanup: (result) =>
          Effect.sync(() => {
            receipts.push(result);
          }),
      }),
      (browser) =>
        Effect.gen(function* () {
          kept = browser;
          expect(browser.reference.provider).toBe("scripted");
          expect(browser.implementation).toBe("scripted");
          yield* browser.navigate({ url: `${origin}/` });
          const result = yield* acceptCookies(browser);

          expect((yield* browser.control.document.current).url).toBe(`${origin}/?consent=1`);
          expect((yield* browser.readText({})).text).toBe("Welcome back.");

          return result;
        }),
    );

    expect(outcome).toBe("accepted");
    expect(kept).toBeDefined();
    if (kept === undefined) return;
    const calls = yield* kept.control.calls;

    expect(calls.map((call) => call.operation)).toEqual([
      "navigate",
      "observe",
      "click",
      "read-text",
    ]);
    expect(calls[2]).toMatchObject({ elementId: "accept", dispatched: true, settled: "completed" });
    expect(Option.isSome(yield* kept.cleanupResult)).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ connection: "closed", issues: [] });
    expect(yield* kept.status).toMatchObject({ phase: "closed" });
    expect(yield* kept.observe().pipe(Effect.flip)).toMatchObject({
      reason: { _tag: "Closed" },
      outcome: "undispatched",
    });
    expect(yield* kept.close).toBe(receipts[0]);
  }),
);

it.effect("admission refuses an off-origin destination before anything is sent", () =>
  Browser.scoped(
    Testing.open({
      documents: [
        {
          url: `${origin}/`,
          text: "",
          controls: [
            { id: "phish", kind: "link", label: "Accept all", destination: "https://evil.test/" },
          ],
        },
      ],
    }),
    (browser) =>
      Effect.gen(function* () {
        const failure = yield* acceptCookies(browser).pipe(Effect.flip);

        expect(failure).toMatchObject({
          operation: "click",
          reason: { _tag: "Denied" },
          outcome: "undispatched",
        });
        expect((yield* browser.control.calls).at(-1)).toMatchObject({
          operation: "click",
          elementId: "phish",
          dispatched: false,
          settled: "failed",
        });
      }),
  ),
);

it.effect("the action budget is refused undispatched with measured facts", () =>
  Browser.scoped(
    Testing.open(shop, { policy: BrowserPolicy.unrestricted({ maxActions: 1 }) }),
    (browser) =>
      Effect.gen(function* () {
        const failure = yield* acceptCookies(browser).pipe(Effect.flip);

        expect(failure).toMatchObject({
          operation: "click",
          reason: { _tag: "Limit", dimension: "actions", maximum: 1, observed: 1 },
          outcome: "undispatched",
        });
      }),
  ),
);

it.effect("an expired lifetime refuses undispatched under the test clock", () =>
  Browser.scoped(
    Testing.open(shop, { policy: BrowserPolicy.unrestricted({ maxElapsedMillis: 60_000 }) }),
    (browser) =>
      Effect.gen(function* () {
        yield* browser.observe();
        yield* TestClock.adjust("61 seconds");
        expect(yield* browser.observe().pipe(Effect.flip)).toMatchObject({
          reason: { _tag: "Expired" },
          outcome: "undispatched",
        });
        expect(yield* browser.status).toMatchObject({ reason: "expired" });
      }),
  ),
);

it.effect("a click held after dispatch times out unknown and is never replayed", () =>
  Browser.scoped(Testing.open(shop, { automation: { actionTimeoutMillis: 5_000 } }), (browser) =>
    Effect.gen(function* () {
      const gate = yield* browser.control.gate;

      yield* browser.control.next("click", { _tag: "Hold", gate, dispatched: true });
      const attempt = yield* acceptCookies(browser).pipe(Effect.forkScoped);

      yield* gate.reached;
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(attempt).pipe(Effect.flip)).toMatchObject({
        operation: "click",
        reason: { _tag: "Timeout" },
        outcome: "unknown",
      });
      expect(yield* browser.status).toMatchObject({
        phase: "uncertain",
        reason: "native-failure",
        unresolvedDispatch: true,
      });
      // A retry in application code cannot get past the owner: nothing is re-sent.
      expect(yield* acceptCookies(browser).pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Closed" },
        outcome: "undispatched",
      });
      const clicks = (yield* browser.control.calls).filter((call) => call.operation === "click");

      expect(clicks).toHaveLength(1);
      expect(clicks[0]).toMatchObject({ dispatched: true });
      yield* gate.open;
    }),
  ).pipe(
    // The uncertain owner cannot confirm cleanup; the scope still closes.
    Effect.catchTag("BrowserError", (error) =>
      error.operation === "close" ? Effect.void : Effect.fail(error),
    ),
  ),
);

it.effect("interruption before dispatch leaves the session usable", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      const gate = yield* browser.control.gate;

      yield* browser.control.next("observe", { _tag: "Hold", gate, dispatched: false });
      const attempt = yield* acceptCookies(browser).pipe(Effect.forkScoped);

      yield* gate.reached;
      yield* Fiber.interrupt(attempt);
      expect(yield* browser.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
      expect((yield* browser.control.calls)[0]).toMatchObject({
        operation: "observe",
        dispatched: false,
        settled: "failed",
      });
      expect(yield* acceptCookies(browser)).toBe("accepted");
    }),
  ),
);

it.effect("a dispatched mutation and a replaced document both make earlier nodes stale", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      const first = yield* browser.observe();

      yield* browser.fillElement(reference(first, "name"), "Ada");
      expect(
        yield* browser.clickElement(reference(first, "accept")).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "Stale" }, outcome: "undispatched" });
      const second = yield* browser.observe();

      yield* browser.control.document.replace({ url: `${origin}/`, text: "Changed underneath." });
      expect(
        yield* browser.controlFacts(reference(second, "name")).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "Stale" } });
      expect((yield* browser.observe()).text).toBe("Changed underneath.");
    }),
  ),
);

it.effect("scripted failures keep their reason and outcome through the owner", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      yield* browser.control.next("click", {
        _tag: "Fail",
        reason: Reasons.RateLimited.make({ retryAfterMillis: 1000 }),
        outcome: "rejected",
      });
      const observation = yield* browser.observe();

      expect(
        yield* browser.clickElement(reference(observation, "accept")).pipe(Effect.flip),
      ).toMatchObject({
        operation: "click",
        reason: { _tag: "RateLimited", retryAfterMillis: 1000 },
        outcome: "rejected",
      });
      expect((yield* browser.control.calls).at(-1)).toMatchObject({ dispatched: false });
      expect(yield* browser.status).toMatchObject({ phase: "open" });
    }),
  ),
);

it.effect("a lost connection is reported as disconnected and refused afterwards", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      yield* browser.control.disconnect;
      expect(yield* browser.status).toMatchObject({ phase: "uncertain", reason: "disconnected" });
      expect(yield* browser.observe().pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Closed" },
        outcome: "undispatched",
      });
    }),
  ).pipe(
    Effect.catchTag("BrowserError", (error) =>
      error.operation === "close" ? Effect.void : Effect.fail(error),
    ),
  ),
);

it.effect("waits observe the exact node until the document changes or the deadline passes", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      const observation = yield* browser.observe();

      const hidden = yield* browser
        .waitForElement({ reference: reference(observation, "accept"), state: "hidden" })
        .pipe(Effect.forkScoped);

      yield* TestClock.adjust(1);
      // The document's own script removes the control: the exact node detaches, the wait ends.
      yield* browser.control.document.update({
        url: `${origin}/`,
        text: "Welcome. We use cookies.",
        controls: [{ id: "name", kind: "input", label: "Name" }],
      });
      yield* Fiber.join(hidden);

      // Document replacement is stale for a wait, never a satisfied condition.
      const replaced = yield* browser
        .waitForElement({ reference: reference(observation, "name"), state: "disabled" })
        .pipe(Effect.forkScoped);

      yield* TestClock.adjust(1);
      yield* browser.control.document.replace({ url: `${origin}/`, text: "Replaced." });
      expect(yield* Fiber.join(replaced).pipe(Effect.flip)).toMatchObject({
        operation: "wait",
        reason: { _tag: "Stale" },
        outcome: "undispatched",
      });
      yield* browser.control.document.update({
        url: `${origin}/`,
        text: "Replaced.",
        controls: [{ id: "name", kind: "input", label: "Name" }],
      });
      const fresh = yield* browser.observe();

      const never = yield* browser
        .waitForElement({
          reference: reference(fresh, "name"),
          state: "disabled",
          timeoutMillis: 2_000,
        })
        .pipe(Effect.forkScoped);

      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(never).pipe(Effect.flip)).toMatchObject({
        operation: "wait",
        reason: { _tag: "Timeout" },
        outcome: "undispatched",
      });
      expect((yield* browser.control.calls).filter((call) => call.operation === "wait")).toEqual([
        expect.objectContaining({ elementId: "accept", settled: "completed" }),
        expect.objectContaining({ elementId: "name", settled: "failed" }),
        expect.objectContaining({ elementId: "name", settled: "failed" }),
      ]);
    }),
  ),
);

it.effect("keyboard input needs focus, values stay out of the recorder", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      const observation = yield* browser.observe();

      expect(
        yield* browser.typeElement(reference(observation, "name"), "Ada").pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "NotFocused" }, outcome: "undispatched" });
      yield* browser.clickElement(reference(observation, "name"));
      const focused = yield* browser.observe();

      yield* browser.typeElement(reference(focused, "name"), "Ada");
      // Real key input is a mutation: the observation it was named from is retired.
      expect(
        yield* browser.pressElement(reference(focused, "name"), { key: "!" }).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "Stale" }, outcome: "undispatched" });
      const again = yield* browser.observe();

      yield* browser.pressElement(reference(again, "name"), { key: "!" });
      expect((yield* browser.control.document.values).get("name")).toBe("Ada!");
      expect(JSON.stringify(yield* browser.control.calls)).not.toContain("Ada");
    }),
  ),
);

it.effect("native selects, downloads and file selection follow the same admission", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      const observation = yield* browser.observe();

      expect(observation.controls.map((c) => c.elementId)).toContain("phish");
      expect(observation.viewport.unreachableControls).toBe(0);
      expect(
        yield* browser.hoverElement(reference(observation, "phish")).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "NotVisible" }, outcome: "undispatched" });
      yield* browser.selectOption(reference(observation, "size"), ["large"]);
      const controls = (yield* browser.control.document.current).controls ?? [];

      expect(controls.find((c) => c.id === "large")?.selected).toBe(true);
      expect(controls.find((c) => c.id === "small")?.selected).toBe(false);
      // A dispatched selection retires the observation it was named from.
      expect(
        yield* browser.hoverElement(reference(observation, "phish")).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "Stale" } });
      const viewport = yield* browser.observe({ scope: "viewport" });

      expect(viewport.controls.map((c) => c.elementId)).not.toContain("phish");
      expect(viewport.viewport.unreachableControls).toBe(1);
    }),
  ),
);

it.effect("capture delivers scripted frames with the real accounting", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      const summary = yield* Effect.scoped(
        Effect.gen(function* () {
          const interval = yield* Capture.start(browser, {
            maxFrames: 2,
            maxDurationMillis: 10_000,
          });

          for (let index = 0; index < 3; index++) yield* browser.control.capture.emit();
          yield* browser.control.capture.emit({ timestamp: 1_700_000_000_120 });
          const frames = yield* interval.frames.pipe(Stream.take(2), Stream.runCollect);

          expect(frames.length).toBe(2);
          expect(frames[0]).toMatchObject({ width: 64, height: 48, mediaType: "image/jpeg" });

          return yield* interval.stop;
        }),
      );

      expect(summary).toMatchObject({ received: 4, delivered: 2, duplicates: 1, overflow: 1 });
      expect(summary.discarded).toBe(
        summary.overflow + summary.late + summary.duplicates + summary.rejected,
      );
      expect(summary.nativeStop).toBe("confirmed");
      expect(summary.initialUrl).toBe(`${origin}/`);

      yield* browser.control.next("capture-stop", {
        _tag: "Fail",
        reason: Reasons.Provider.make({}),
        outcome: "unknown",
      });

      const unconfirmed = yield* Effect.scoped(
        Capture.start(browser, { maxDurationMillis: 10_000 }).pipe(
          Effect.flatMap((interval) => interval.stop),
        ),
      );

      expect(unconfirmed.nativeStop).toBe("unconfirmed");
      expect(yield* browser.control.capture.emit().pipe(Effect.flip)).toMatchObject({
        operation: "capture-consume",
        reason: { _tag: "NotFound" },
      });
    }),
  ),
);

class SettingsUnavailable extends Schema.TaggedError<SettingsUnavailable>()("SettingsUnavailable", {
  revision: Schema.Finite,
}) {}

const settings = Bootstrap.combine(
  Bootstrap.binding({
    name: "getSettings",
    origins: [origin],
    input: Schema.Struct({ revision: Schema.Finite }),
    output: Schema.Struct({ label: Schema.String }),
    maxConcurrent: 4,
    failureMode: "reject-call",
    handle: ({ revision }) => Effect.succeed({ label: `settings:${revision}` }),
  }),
  Bootstrap.binding({
    name: "requireSettings",
    origins: [origin],
    input: Schema.Struct({ revision: Schema.Finite }),
    output: Schema.Struct({ label: Schema.String }),
    failureMode: "fail-session",
    handle: ({ revision }) =>
      revision >= 0
        ? Effect.succeed({ label: `settings:${revision}` })
        : Effect.fail(SettingsUnavailable.make({ revision })),
  }),
  Bootstrap.init({
    id: "settings-ready",
    origins: [origin],
    content: "globalThis.__ready = true;",
    readiness: {
      expression: "globalThis.__ready",
      timeoutMillis: 1000,
      existingDocuments: "RequireFreshNavigation",
    },
  }),
);

it.effect("typed callbacks run through the real admission and fail the session as declared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(shop, { bootstrap: settings });

      // The starting document predates registration, so dependent work is refused until navigation.
      expect((yield* browser.ready)._tag).toBe("RequiresNavigation");
      expect(yield* browser.observe().pipe(Effect.flip)).toMatchObject({
        operation: "observe",
        reason: { _tag: "Stale" },
      });
      yield* browser.navigate({ url: `${origin}/` });
      expect((yield* browser.ready)._tag).toBe("Ready");

      expect(yield* browser.control.invoke("getSettings", { revision: 7 })).toEqual({
        ok: true,
        output: { label: "settings:7" },
      });
      expect(
        yield* browser.control.invoke(
          "getSettings",
          { revision: 7 },
          { origin: "https://other.test" },
        ),
      ).toEqual({ ok: false });
      const diagnostics = yield* browser.bindingDiagnostics;

      expect(diagnostics.bindings[0]).toMatchObject({
        name: "getSettings",
        succeeded: 1,
        rejected: 1,
      });
      const refused = diagnostics.failures[0];

      expect(refused).toBeDefined();
      if (refused === undefined) return;
      expect(Option.getOrThrow(Cause.findErrorOption(refused.cause))).toMatchObject({
        _tag: "InitializationError",
        operation: "callback",
        step: "getSettings",
        reason: "origin",
      });

      expect((yield* browser.bindingDiagnostics).faulted).toBe(false);
      expect(yield* browser.control.invoke("requireSettings", { revision: -1 })).toEqual({
        ok: false,
      });
      expect(yield* browser.failure.pipe(Effect.flip)).toEqual(
        SettingsUnavailable.make({ revision: -1 }),
      );
      expect((yield* browser.bindingDiagnostics).faulted).toBe(true);
      expect(yield* browser.observe().pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Closed" },
      });
    }),
  ),
);

it.effect("page holds refuse input on the held page until it is resumed and revalidated", () =>
  Browser.scoped(Testing.open(shop, { automation: { pageControl: true } }), (browser) =>
    Effect.gen(function* () {
      const observation = yield* browser.observe();
      const page = (yield* browser.pages).find((candidate) => candidate.selected);

      expect(page).toBeDefined();
      if (page === undefined) return;
      const held = yield* PageControl.suspend(browser, page);

      expect((yield* PageControl.state(browser, page)).state).toBe("suspended");
      // A held page is refused, never woken: the owner says so before any node check.
      expect(
        yield* browser.clickElement(reference(observation, "accept")).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "Busy" }, outcome: "undispatched" });
      yield* PageControl.resume(browser, held);
      expect(yield* PageControl.resume(browser, held).pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Stale" },
      });
      // After a hold nothing observed on that page may be acted on unchecked.
      expect(
        yield* browser.clickElement(reference(observation, "accept")).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "Stale" }, outcome: "undispatched" });
      yield* browser.revalidateElement(reference(observation, "accept"));
      yield* browser.clickElement(reference(observation, "accept"));
      expect((yield* browser.control.document.current).url).toBe(`${origin}/?consent=1`);
    }),
  ),
);

it.effect("pages can be created, pinned, selected and closed", () =>
  Browser.scoped(Testing.open(shop, { automation: { maxPages: 2 } }), (browser) =>
    Effect.gen(function* () {
      const created = yield* browser.createPage;

      expect((yield* browser.pages).map((page) => page.selected)).toEqual([true, false]);
      const pinned = yield* browser.pinPage(created);

      yield* pinned.navigate({ url: `${origin}/?consent=1` });
      expect((yield* pinned.readText({})).text).toBe("Welcome back.");
      expect((yield* browser.readText({})).text).toBe("Welcome. We use cookies.");
      expect(yield* browser.createPage.pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Limit", dimension: "pages", maximum: 2, observed: 2 },
      });
      yield* browser.selectPage(created);
      expect((yield* browser.observe()).url).toBe(`${origin}/?consent=1`);
      yield* browser.closePage(created);
      expect(yield* browser.observe().pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Closed" },
      });
    }),
  ),
);

it.effect("an in-flight navigation can be watched, stopped, or time out under the test clock", () =>
  Browser.scoped(Testing.open(shop, { automation: { actionTimeoutMillis: 5_000 } }), (browser) =>
    Effect.gen(function* () {
      const gate = yield* browser.control.gate;

      yield* browser.control.next("navigate", { _tag: "Hold", gate, dispatched: true });

      const stopped = yield* Effect.scoped(
        Effect.gen(function* () {
          const operation = yield* browser.startNavigation({ url: `${origin}/?consent=1` });

          yield* gate.reached;
          expect((yield* browser.readText({})).text).toBe("Welcome. We use cookies.");
          yield* operation.stop;

          return yield* operation.completed.pipe(Effect.flip);
        }),
      );

      expect(stopped).toMatchObject({ operation: "navigate", reason: { _tag: "Interrupted" } });
      expect(yield* browser.status).toMatchObject({ phase: "open" });

      const late = yield* browser.control.gate;

      yield* browser.control.next("navigate", { _tag: "Hold", gate: late, dispatched: true });

      const attempt = yield* browser
        .navigate({ url: `${origin}/?consent=1` })
        .pipe(Effect.forkScoped);

      yield* late.reached;
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(attempt).pipe(Effect.flip)).toMatchObject({
        operation: "navigate",
        reason: { _tag: "Timeout" },
        outcome: "unknown",
      });
    }),
  ).pipe(
    Effect.catchTag("BrowserError", (error) =>
      error.operation === "close" ? Effect.void : Effect.fail(error),
    ),
  ),
);

it.effect("the same engine composes under browser-runtime as an opaque binding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scripted = yield* Testing.binding(shop);

      const runtime = yield* BrowserRuntime.make({
        implementation: "integration-under-test",
        binding: scripted.binding,
      }).pipe(Effect.provide(NodeCrypto.layer));

      const acquired = yield* runtime.acquire(BrowserPolicy.unrestricted(), (cleanup) =>
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
            reference: "integration-under-test",
            connection: () => Effect.succeed(Redacted.make("wss://integration.test/")),
            release,
            cleanupResult: Effect.succeedNone,
            closeChecked: release,
          };
        }),
      );

      const { session } = yield* acquired.connect;
      const [control] = yield* scripted.connections;

      expect(control).toBeDefined();
      expect((yield* session.observe()).text).toBe("Welcome. We use cookies.");
      expect((yield* control!.calls).map((call) => call.operation)).toEqual(["observe"]);
    }),
  ),
);

it.effect("an invalid script is a configuration failure before anything is acquired", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = yield* Testing.open({ documents: [] }).pipe(Effect.flip);

      expect(failure).toMatchObject({ operation: "configure", reason: { _tag: "Configuration" } });

      const duplicate = yield* Testing.open({
        documents: [
          {
            url: `${origin}/`,
            text: "",
            controls: [
              { id: "a", kind: "button", label: "A" },
              { id: "a", kind: "button", label: "B" },
            ],
          },
        ],
      }).pipe(Effect.flip);

      expect(duplicate).toMatchObject({ operation: "configure" });

      // A plain button has no destination in a real document; only links and submits do.
      const button = yield* Testing.open({
        documents: [
          {
            url: `${origin}/`,
            text: "",
            controls: [{ id: "go", kind: "button", label: "Go", destination: `${origin}/next` }],
          },
        ],
      }).pipe(Effect.flip);

      expect(button).toMatchObject({ operation: "configure", reason: { _tag: "Configuration" } });
    }),
  ),
);
