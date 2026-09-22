import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { BrowserSession } from "effect-browser/browser";
import {
  AutomationOptions,
  BrowserDiagnostic,
  BrowserDiagnostics,
  BrowserPolicy,
  SessionPhase,
  SessionStatus,
} from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const statusRead: Same<BrowserSession["status"], Effect.Effect<SessionStatus>> = true;
const diagnosticRead: Same<BrowserSession["diagnostics"], Effect.Effect<BrowserDiagnostics>> = true;

it("status and bounded diagnostics are host data with no admission or native capability", () => {
  expect(statusRead && diagnosticRead).toBe(true);
  for (const phase of [
    "acquiring",
    "open",
    "paused",
    "detached",
    "faulted",
    "uncertain",
    "closing",
    "closed",
  ] as const) {
    expect(Schema.is(SessionPhase)(phase)).toBe(true);

    const status = SessionStatus.make({
      phase,
      reason: "expired",
      generation: 3,
      busy: false,
      unresolvedDispatch: false,
    });

    expect(Schema.decodeSync(SessionStatus)(status)).toEqual(status);
  }

  const record = {
    reason: "popup-overflow",
    disposition: "pending",
    generation: 3,
    monotonicNanos: 10n,
  } as const;

  const decode = Schema.decodeUnknownSync(BrowserDiagnostics, { onExcessProperty: "error" });

  expect(
    decode({ records: [record], total: 1, dropped: 0, truncated: false }).records,
  ).toHaveLength(1);
  expect(() =>
    decode({ records: Array(33).fill(record), total: 33, dropped: 0, truncated: false }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(BrowserDiagnostic, { onExcessProperty: "error" })({
      ...record,
      url: "PRIVATE-PAGE",
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(SessionStatus)({
      phase: "closed",
      reason: "PRIVATE-CAUSE",
      generation: 1,
      busy: false,
      unresolvedDispatch: true,
    }),
  ).toThrow();
  expect(() =>
    decode({ records: [], total: Number.MAX_SAFE_INTEGER + 1, dropped: 0, truncated: false }),
  ).toThrow();
});

it.effect(
  "the host-read allowance is validated as automation configuration before browser launch",
  () =>
    Effect.gen(function* () {
      expect(Schema.decodeSync(AutomationOptions)({})).not.toHaveProperty("maxHostReads");
      for (const maxHostReads of [1, 10_000, 1_000_000])
        expect(Schema.decodeSync(AutomationOptions)({ maxHostReads }).maxHostReads).toBe(
          maxHostReads,
        );
      for (const maxHostReads of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        null,
        1_000_001,
      ]) {
        const result = yield* Layer.build(
          Chromium.layer({ maxHostReads: maxHostReads as never }),
        ).pipe(Effect.scoped, Effect.result);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            operation: "configure",
            reason: { _tag: "Configuration" },
            outcome: "undispatched",
          },
        });
      }
      expect(() =>
        Schema.decodeUnknownSync(BrowserPolicy, { onExcessProperty: "error" })({
          ...BrowserPolicy.unrestricted(),
          maxHostReads: 2,
        }),
      ).toThrow();
    }),
);
