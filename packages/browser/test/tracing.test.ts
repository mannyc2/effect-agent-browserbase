import { expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Option,
  References,
  Result,
  Schema,
  Tracer,
} from "effect";

import * as Bootstrap from "../src/Bootstrap.ts";
import * as Browser from "../src/Browser.ts";
import * as Capture from "../src/Capture.ts";
import { Reasons } from "../src/Errors.ts";
import * as Testing from "../src/Testing.ts";

const origin = "https://privacy.test";
const privateText = "PRIVATE-PAGE-CONTENT";

const script: Testing.Script = {
  documents: [{ url: `${origin}/?PRIVATE-URL`, text: privateText }],
};

const recorded = () => {
  const spans: Tracer.NativeSpan[] = [];
  const ends: string[] = [];

  const creations: Array<{
    readonly name: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }> = [];

  const tracer = Tracer.make({
    span: (options) => {
      creations.push({
        name: options.name,
        attributes: Context.get(options.annotations, References.TracerSpanAnnotations),
      });
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);

      span.end = (time, exit) => {
        ends.push(span.spanId);
        end(time, exit);
      };
      spans.push(span);

      return span;
    },
  });

  return { spans, ends, tracer, creations };
};

const serialized = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
  JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      attributes: [...span.attributes],
      events: span.events,
      status: span.status,
      failure:
        span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
          ? Cause.pretty(span.status.exit.cause)
          : undefined,
    })),
    (_, value: unknown) => (typeof value === "bigint" ? String(value) : value),
  );

// The tracing audit at main d63463e found no browser outcome spans. Native detail and typed
// callbacks are deliberately host-only diagnostics, so the new boundary must prove its raw
// terminal values cannot export those diagnostics or successful page results.
it.effect(
  "browser outcome spans retain results and host failures while erasing private terminals",
  () => {
    const { spans, ends, tracer, creations } = recorded();

    return Browser.scoped(Testing.open(script), (browser) =>
      Effect.gen(function* () {
        const observation = yield* browser.observe();

        expect(observation.text).toBe(privateText);
        yield* browser.control.next("read-text", {
          _tag: "Fail",
          reason: Reasons.Provider.make({ detail: "PRIVATE-NATIVE-DIAGNOSTIC" }),
          outcome: "undispatched",
        });
        const failure = yield* browser.readText({}).pipe(Effect.flip);

        expect(failure.reason).toEqual(
          Reasons.Provider.make({ detail: "PRIVATE-NATIVE-DIAGNOSTIC" }),
        );
        const observed = spans.find((span) => span.name === "Browser.observe");
        const failed = spans.find((span) => span.name === "Browser.read-text");

        expect(observed?.status).toMatchObject({ _tag: "Ended", exit: Exit.void });
        expect(failed?.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Failure" } });
        expect(failed?.attributes.get("browser.outcome")).toBe("undispatched");
        expect(creations.find((span) => span.name === "Browser.observe")?.attributes).toEqual({
          "browser.operation": "observe",
        });
        expect(serialized(spans)).not.toContain("PRIVATE-");
        expect(new Set(ends).size).toBe(ends.length);
      }),
    ).pipe(Effect.withTracer(tracer));
  },
);

it.effect.each(["typed", "defect"] as const)(
  "binding %s failures remain original on the host and sanitized in the autonomous span",
  (mode) => {
    const { spans, ends, tracer } = recorded();

    const failure =
      mode === "typed"
        ? ({ _tag: "PrivateFailure", secret: "PRIVATE-CALLBACK-CAUSE" } as const)
        : new Error("PRIVATE-CALLBACK-DEFECT");

    const bootstrap = Bootstrap.binding({
      name: "privateBinding",
      origins: [origin],
      input: Schema.String,
      output: Schema.String,
      failureMode: "reject-call",
      handle: () => (mode === "typed" ? Effect.fail(failure) : Effect.die(failure)),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Testing.open(script, { bootstrap });

        expect(yield* browser.control.invoke("privateBinding", "PRIVATE-CALLBACK-INPUT")).toEqual({
          ok: false,
        });
        const diagnostic = (yield* browser.bindingDiagnostics).failures[0];

        expect(diagnostic).toBeDefined();
        if (diagnostic === undefined) return;
        expect(
          mode === "typed"
            ? Option.getOrThrow(Cause.findErrorOption(diagnostic.cause))
            : Result.getOrThrow(Cause.findDefect(diagnostic.cause)),
        ).toBe(failure);
        const callback = spans.find((span) => span.name === "Browser.binding");

        expect(callback?.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Failure" } });
        expect(serialized(spans)).not.toContain("PRIVATE-");
        expect(new Set(ends).size).toBe(ends.length);
      }),
    ).pipe(Effect.withTracer(tracer));
  },
);

// During implementation, the installed makeSpan API was found to apply creation attributes
// before returning the allocated span. An attribute defect could therefore abandon an open span.
it.effect(
  "a tracer attribute defect preserves the reading and still terminates allocated spans",
  () => {
    const spans: Tracer.NativeSpan[] = [];
    const ends: string[] = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);

        span.attribute = () => {
          throw new Error("PRIVATE-EXPORTER-ATTRIBUTE");
        };
        span.end = (time, exit) => {
          ends.push(span.spanId);
          end(time, exit);
        };
        spans.push(span);

        return span;
      },
    });

    return Browser.scoped(Testing.open(script), (browser) =>
      Effect.gen(function* () {
        expect((yield* browser.observe()).text).toBe(privateText);
        const observed = spans.find((span) => span.name === "Browser.observe");

        expect(observed?.status).toMatchObject({ _tag: "Ended", exit: Exit.void });
        expect(ends.filter((id) => id === observed?.spanId)).toHaveLength(1);
      }),
    ).pipe(Effect.withTracer(tracer));
  },
);

it.effect("an undispatched capture failure leaves no allocated interval span open", () => {
  const { spans, ends, tracer, creations } = recorded();

  return Browser.scoped(Testing.open(script), (browser) =>
    Effect.gen(function* () {
      const options: Capture.CaptureOptions = { lifetime: "document" };

      // JavaScript callers can supply a runtime value outside the TypeScript literal union.
      Object.defineProperty(options, "lifetime", { value: "PRIVATE-CAPTURE-LIFETIME" });
      const active = yield* Capture.start(browser, options);
      const existing = spans.filter((span) => span.name === "Browser.capture.interval");

      expect(existing).toHaveLength(1);
      const before = spans.length;
      const refused = yield* Capture.start(browser).pipe(Effect.flip);

      expect(refused).toMatchObject({ reason: { _tag: "Busy" }, outcome: "undispatched" });

      const rejected = spans
        .slice(before)
        .filter((span) => span.name === "Browser.capture.interval");

      for (const span of rejected) {
        expect(span.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Failure" } });
        expect(ends.filter((id) => id === span.spanId)).toHaveLength(1);
      }
      yield* active.stop;
      expect(existing[0]?.status._tag).toBe("Ended");
      expect(existing[0]?.attributes.get("browser.capture.lifetime")).toBe("document");
      expect(
        creations.find((creation) => creation.name === "Browser.capture.interval")?.attributes[
          "browser.capture.lifetime"
        ],
      ).toBe("document");
      expect(serialized(spans)).not.toContain("PRIVATE-CAPTURE-LIFETIME");
    }),
  ).pipe(Effect.withTracer(tracer));
});

// A synchronous tracer hook provides the precise cancellation seam that ordinary timing cannot
// reliably hit: allocation must finish installing termination before cancellation is restored.
it.effect.each(["Browser.admission", "Browser.readiness"])(
  "cancellation during %s allocation preserves interruption and terminates the span once",
  (boundary) => {
    const spans: Tracer.NativeSpan[] = [];
    const ends: string[] = [];
    let current: Fiber.Fiber<unknown, unknown> | undefined;

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);

        span.end = (time, exit) => {
          ends.push(span.spanId);
          end(time, exit);
        };
        spans.push(span);
        if (options.name === boundary) current?.interruptUnsafe();

        return span;
      },
    });

    return Browser.scoped(Testing.open(script), (browser) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.withFiber((fiber) => {
          current = fiber;

          return browser.observe();
        }).pipe(Effect.forkScoped);

        expect(Exit.hasInterrupts(yield* Fiber.await(attempt))).toBe(true);
        expect(yield* browser.control.calls).toEqual([]);
        expect((yield* browser.status).phase).toBe("open");
        const allocated = spans.find((span) => span.name === boundary);

        expect(allocated?.status._tag).toBe("Ended");
        expect(ends.filter((id) => id === allocated?.spanId)).toHaveLength(1);
        expect(spans.find((span) => span.name === "Browser.observe")?.status).toMatchObject({
          _tag: "Ended",
          exit: { _tag: "Failure" },
        });
      }),
    ).pipe(Effect.withTracer(tracer));
  },
);
