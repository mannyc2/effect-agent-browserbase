import { Effect, Schema } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";

import { PageClockStamps, Telemetry } from "./Telemetry.ts";

/** One probe call: this plan's secret and, after the first, the page's stamps for the last one. */
export const Call = Schema.Struct({
  secret: Schema.String.check(Schema.isMaxLength(64)),
  previous: Schema.optionalKey(PageClockStamps),
});

/**
 * The host side of a probe call. Only the init script holding this plan's secret opens or
 * completes an exchange; another script on the origin can call the binding but gets no exchange.
 * The reply names the new exchange and carries no host time.
 */
export const answer = (secret: string) =>
  Effect.fnUntraced(function* (call: typeof Call.Type) {
    if (call.secret !== secret) return { exchange: null };

    return { exchange: yield* (yield* Telemetry).clockExchange(call.previous) };
  });

/** Read-only application clock comparison and font readiness; no input or artwork. */
export const plan = (origins: ReadonlyArray<string>) => {
  // Held only by this plan's init script and the host; page scripts never see its source.
  const secret = crypto.randomUUID();

  return Bootstrap.combine(
    Bootstrap.binding({
      name: "footageClock",
      origins,
      input: Call,
      output: Schema.Struct({ exchange: Schema.NullOr(Schema.String) }),
      maxConcurrent: 4,
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      timeoutMillis: 2000,
      failureMode: "reject-call",
      handle: answer(secret),
    }),
    Bootstrap.init({
      id: "footage-clock",
      origins,
      // The binding and the page clock are captured before any page script runs, so a later
      // script can neither intercept these calls nor replace the clock they read.
      content: `globalThis.__footageReady = (async () => {
        const call = globalThis.footageClock;
        const elapsed = performance.now.bind(performance);
        const origin = performance.timeOrigin;
        const secret = ${JSON.stringify(secret)};
        if (document.readyState !== "complete")
          await new Promise(resolve => addEventListener("load", resolve, {once:true}));
        await document.fonts.ready;
        const now = () => origin + elapsed();
        let previous;
        for (let index = 0; index < 6; index++) {
          const pageSentMillis = now();
          const reply = await call(previous ? {secret, previous} : {secret});
          previous = {exchange: reply.exchange, pageSentMillis, pageReceivedMillis: now()};
        }
        return true;
      })();`,
      readiness: {
        expression: "globalThis.__footageReady",
        timeoutMillis: 15_000,
        existingDocuments: "RequireFreshNavigation",
      },
    }),
  );
};
