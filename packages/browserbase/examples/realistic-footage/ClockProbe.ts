import { Effect, Schema } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";

import { ClockSample, Telemetry } from "./Telemetry.ts";

/** Read-only application clock comparison and font readiness; no input or artwork. */
export const plan = (origins: ReadonlyArray<string>) =>
  Bootstrap.combine(
    Bootstrap.binding({
      name: "footageClock",
      origins,
      input: Schema.Struct({ sample: Schema.optionalKey(ClockSample) }),
      output: Schema.Struct({
        hostReceivedMillis: Schema.Finite,
        hostRepliedMillis: Schema.Finite,
      }),
      maxConcurrent: 4,
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      timeoutMillis: 2000,
      failureMode: "reject-call",
      handle: Effect.fnUntraced(function* (call) {
        const telemetry = yield* Telemetry;
        const hostReceivedMillis = yield* telemetry.now;

        if (call.sample !== undefined) yield* telemetry.clock(call.sample);

        return { hostReceivedMillis, hostRepliedMillis: yield* telemetry.now };
      }),
    }),
    Bootstrap.init({
      id: "footage-clock",
      origins,
      content: `globalThis.__footageReady = (async () => {
        if (document.readyState !== "complete")
          await new Promise(resolve => addEventListener("load", resolve, {once:true}));
        await document.fonts.ready;
        const now = () => performance.timeOrigin + performance.now();
        let sample;
        for (let index = 0; index < 6; index++) {
          const pageSentMillis = now();
          const reply = await globalThis.footageClock(sample ? {sample} : {});
          sample = {pageSentMillis, ...reply, pageReceivedMillis:now()};
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
