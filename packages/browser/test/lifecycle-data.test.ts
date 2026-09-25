import { NodeCrypto } from "@effect/platform-node";
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

const actionsRead: Same<
  SessionStatus["actions"],
  { readonly used: number; readonly maximum: number }
> = true;

it("status and bounded diagnostics are host data with no admission or native capability", () => {
  expect(statusRead && diagnosticRead && actionsRead).toBe(true);
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
      actions: { used: 100, maximum: 100 },
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
  ).toThrow(Schema.SchemaError);
  expect(() =>
    Schema.decodeUnknownSync(BrowserDiagnostic, { onExcessProperty: "error" })({
      ...record,
      url: "PRIVATE-PAGE",
    }),
  ).toThrow(Schema.SchemaError);
  expect(() =>
    Schema.decodeUnknownSync(SessionStatus)({
      phase: "closed",
      reason: "PRIVATE-CAUSE",
      generation: 1,
      busy: false,
      unresolvedDispatch: true,
      actions: { used: 0, maximum: 100 },
    }),
  ).toThrow(Schema.SchemaError);
  expect(() =>
    decode({ records: [], total: Number.MAX_SAFE_INTEGER + 1, dropped: 0, truncated: false }),
  ).toThrow(Schema.SchemaError);
});

it.effect(
  "the host-read allowance is validated as automation configuration before browser launch",
  () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeEffect(AutomationOptions)({})).not.toHaveProperty("maxHostReads");
      for (const maxHostReads of [1, 10_000, 1_000_000])
        expect((yield* Schema.decodeEffect(AutomationOptions)({ maxHostReads })).maxHostReads).toBe(
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
          Chromium.layer({ maxHostReads: maxHostReads as never }).pipe(
            Layer.provide(NodeCrypto.layer),
          ),
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
      ).toThrow(Schema.SchemaError);
    }),
);

it("the action allowance is bounded like the host-read allowance, and status never overstates use", () => {
  expect(BrowserPolicy.unrestricted().maxActions).toBe(100);
  for (const maxActions of [1, 1000, 1001, 1_000_000])
    expect(BrowserPolicy.unrestricted({ maxActions }).maxActions).toBe(maxActions);
  const policy = Schema.decodeUnknownSync(BrowserPolicy, { onExcessProperty: "error" });

  for (const maxActions of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001]) {
    expect(() => policy({ ...BrowserPolicy.unrestricted(), maxActions })).toThrow(
      Schema.SchemaError,
    );
    expect(() => BrowserPolicy.unrestricted({ maxActions })).toThrow("Schema validation failed");
  }

  const decode = Schema.decodeUnknownSync(SessionStatus, { onExcessProperty: "error" });

  const status = (actions: unknown) =>
    decode({
      phase: "open",
      reason: null,
      generation: 1,
      busy: false,
      unresolvedDispatch: false,
      actions,
    });

  for (const actions of [
    { used: 0, maximum: 1 },
    { used: 1_000_000, maximum: 1_000_000 },
  ])
    expect(status(actions).actions).toEqual(actions);
  for (const actions of [
    { used: 101, maximum: 100 },
    { used: -1, maximum: 100 },
    { used: 0.5, maximum: 100 },
    { used: 0, maximum: 0 },
    { used: 0, maximum: 1_000_001 },
    { used: 0, maximum: 100, hostReads: 3 },
    { used: 0 },
  ])
    expect(() => status(actions)).toThrow(Schema.SchemaError);
  expect(() =>
    decode({ phase: "open", reason: null, generation: 1, busy: false, unresolvedDispatch: false }),
  ).toThrow(Schema.SchemaError);
});
