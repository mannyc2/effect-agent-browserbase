import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ActionResult, NavigateRequest } from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";

import { checked, decoded } from "../src/internal/browser/PublicSession.ts";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const expected = BrowserError.make({
  operation: "observe",
  reason: Reasons.Limit.make({ dimension: "returned-bytes", maximum: 10, observed: 11 }),
  outcome: "undispatched",
});

const failure = Effect.fail(expected);

const recovered = failure.pipe(
  Effect.catchReason("BrowserError", "Limit", (reason) =>
    Effect.succeed([reason.dimension, reason.maximum, reason.observed]),
  ),
);

const recoveredReasons = failure.pipe(
  Effect.catchReasons("BrowserError", {
    Limit: (reason) => Effect.succeed(reason.observed),
    Busy: () => Effect.succeed(0),
  }),
);

const exhaustive = failure.pipe(
  Effect.unwrapReason("BrowserError"),
  Effect.catchTags({
    Active: () => Effect.void,
    Ambiguous: () => Effect.void,
    Authorization: () => Effect.void,
    Busy: () => Effect.void,
    Closed: () => Effect.void,
    Configuration: () => Effect.void,
    ContentType: () => Effect.void,
    ContextLease: () => Effect.void,
    Denied: () => Effect.void,
    Disabled: () => Effect.void,
    Disconnected: () => Effect.void,
    Expired: () => Effect.void,
    Failed: () => Effect.void,
    Interrupted: () => Effect.void,
    Limit: () => Effect.void,
    Malformed: () => Effect.void,
    NotFocused: () => Effect.void,
    NotFound: () => Effect.void,
    NotVisible: () => Effect.void,
    Provider: () => Effect.void,
    RateLimited: () => Effect.void,
    Resized: () => Effect.void,
    Stale: () => Effect.void,
    TargetChanged: () => Effect.void,
    Timeout: () => Effect.void,
    Timestamp: () => Effect.void,
    Transport: () => Effect.void,
    UnregisteredSession: () => Effect.void,
    UnsafeUrl: () => Effect.void,
    Unsupported: () => Effect.void,
  }),
);

const noErrors: Same<Effect.Error<typeof exhaustive>, never> = true;

it.effect("host reasons support reason recovery, factual limits and exhaustive unwrapping", () =>
  Effect.gen(function* () {
    expect(yield* recovered).toEqual(["returned-bytes", 10, 11]);
    expect(yield* recoveredReasons).toBe(11);
    yield* exhaustive;
    expect(noErrors).toBe(true);
    const decode = Schema.decodeUnknownSync(BrowserError, { onExcessProperty: "error" });

    expect(
      decode({
        _tag: "BrowserError",
        operation: expected.operation,
        reason: expected.reason,
        outcome: expected.outcome,
      }),
    ).toMatchObject({
      operation: expected.operation,
      reason: expected.reason,
      outcome: expected.outcome,
    });
    for (const input of [
      { operation: "observe", reason: { _tag: "Busy" } },
      { operation: "observe", reason: "busy", outcome: "undispatched" },
      { operation: "observe", reason: { _tag: "Limit" }, outcome: "undispatched" },
      { operation: "observe", reason: { _tag: "Busy", maximum: 10 }, outcome: "undispatched" },
    ])
      expect(() => decode({ _tag: "BrowserError", ...input })).toThrow();
  }),
);

it.effect(
  "schema failures disclose a declared field prefix without values or unexpected input keys",
  () =>
    Effect.gen(function* () {
      const invalid = yield* checked(NavigateRequest, { url: "PRIVATE-VALUE" }, "navigate").pipe(
        Effect.flip,
      );

      expect(invalid).toMatchObject({
        reason: { _tag: "Configuration", path: "url" },
        outcome: "undispatched",
      });
      expect(JSON.stringify(invalid)).not.toContain("PRIVATE-VALUE");

      const excess = yield* checked(
        NavigateRequest,
        { url: "https://example.test/", "PRIVATE-KEY": "PRIVATE-VALUE" },
        "navigate",
      ).pipe(Effect.flip);

      expect(excess).toMatchObject({ reason: { _tag: "Configuration" }, outcome: "undispatched" });
      expect(JSON.stringify(excess)).not.toContain("PRIVATE-KEY");
      expect(JSON.stringify(excess)).not.toContain("PRIVATE-VALUE");

      const malformed = yield* decoded(
        ActionResult,
        "action-result",
        "unknown",
      )({ url: 42 }).pipe(Effect.flip);

      expect(malformed).toMatchObject({
        reason: { _tag: "Malformed", path: "url" },
        outcome: "unknown",
      });
    }),
);
