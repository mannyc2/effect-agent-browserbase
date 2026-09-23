import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Reasons } from "effect-browser/errors";
import type { Script } from "effect-browser/testing";
import { TestClock } from "effect/testing";

import { BrowserbaseBrowser } from "../src/Browser.ts";
import * as Testing from "../src/Testing.ts";
import { elapse } from "./fixtures/Time.ts";

const script: Script = {
  documents: [
    {
      url: "https://example.test/",
      text: "initial",
      controls: [{ id: "act", kind: "button", label: "act" }],
    },
  ],
};

/**
 * The engine times an in-flight navigation out on the clock it was opened under, and the owner
 * bounds that timeout by the lifetime, so on the test's clock both would end at the same instant.
 * Opened under a clock the test never advances, the navigation is still loading at expiry.
 */
const stillLoading = Testing.layer({ browser: script }).pipe(Layer.provide(TestClock.layer()));

it.effect.each([false, true])(
  "expiry preserves pending navigation evidence (%s) until owned release confirms retirement",
  (pending) =>
    Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;

      const acquisition = yield* BrowserbaseBrowser.acquire(
        BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 100 }),
      );

      const session = yield* acquisition.connect;
      const [browser] = yield* scripted.browsers;
      const disconnect = yield* browser!.gate;
      const loading = yield* browser!.gate;

      // Local cleanup waits at the native disconnect until the test lets it finish.
      yield* browser!.next("disconnect", { _tag: "Hold", gate: disconnect, dispatched: true });
      if (pending)
        yield* browser!.next("navigate", { _tag: "Hold", gate: loading, dispatched: true });

      const operation = pending
        ? yield* session.startNavigation({ url: "https://example.test/slow" })
        : undefined;

      yield* TestClock.adjust(100);
      yield* disconnect.reached;
      expect(yield* session.status).toMatchObject({
        phase: "closing",
        reason: "expired",
        unresolvedDispatch: pending,
      });
      if (operation !== undefined)
        expect(yield* Effect.result(operation.completed)).toMatchObject({
          _tag: "Failure",
          failure: { outcome: "unknown" },
        });
      yield* disconnect.open;
      // The acquisition's close is the owned release that may retire native control.
      const report = yield* acquisition.close;

      expect(report.remote).toBe("confirmed");
      expect(yield* session.status).toMatchObject({
        phase: "closed",
        reason: "expired",
        unresolvedDispatch: false,
      });
      expect(yield* Effect.result(session.click({ selector: "#act" }))).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Expired" }, outcome: "undispatched" },
      });
      expect((yield* scripted.provider.sessions)[0]).toMatchObject({ releaseRequests: 1 });
      expect((yield* browser!.calls).filter((call) => call.operation === "click")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(stillLoading)),
);

it.effect("unconfirmed owned release cannot retire a dispatched operation's control evidence", () =>
  Effect.gen(function* () {
    const scripted = yield* Testing.ScriptedBrowserbase;
    const acquisition = yield* BrowserbaseBrowser.acquire(BrowserPolicy.unrestricted());
    const session = yield* acquisition.connect;
    const [browser] = yield* scripted.browsers;

    // The click is sent and its acknowledgement is lost.
    yield* browser!.next("click", {
      _tag: "Fail",
      reason: Reasons.Provider.make({}),
      outcome: "unknown",
    });
    expect(yield* Effect.result(session.click({ selector: "#act" }))).toMatchObject({
      _tag: "Failure",
      failure: { outcome: "unknown" },
    });
    const original = yield* session.status;

    expect(original.unresolvedDispatch).toBe(true);
    const report = yield* elapse(acquisition.close, 12_000);

    expect(report.remote).not.toBe("confirmed");
    expect(yield* session.status).toMatchObject({
      phase: "closed",
      reason: original.reason,
      unresolvedDispatch: true,
    });
    expect(yield* acquisition.close).toEqual(report);
    expect((yield* scripted.provider.sessions)[0]).toMatchObject({ releaseRequests: 1 });
  }).pipe(
    Effect.scoped,
    Effect.provide(Testing.layer({ browser: script, provider: { release: "failed" } })),
  ),
);
