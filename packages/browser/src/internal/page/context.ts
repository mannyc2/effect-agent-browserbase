/**
 * What a page's parts share: the browser state they act on, the page's own lock and clock, and
 * how they call the browser and report its failures. The assembly in `page.ts` builds one context
 * per page.
 */
import {
  Clock,
  Context,
  Effect,
  Fiber,
  type Option,
  type Ref,
  Schema,
  type Semaphore,
} from "effect";
import type { CDPSession, Page as PlaywrightPage } from "playwright-core";

import { BrowserError, Closed, Failed, type Reason, Timeout } from "../../BrowserError.ts";
import type { BrowserEvent } from "../../BrowserEvent.ts";
import type * as Motion from "../../Motion.ts";
import type { Point, Settings } from "../../Page.ts";
import type * as BrowserClock from "../pictures/clock.ts";

export interface MakeOptions {
  readonly id: string;
  readonly playwright: PlaywrightPage;
  readonly cdp: CDPSession;
  readonly settings: Settings;
  readonly motion: Motion.Service;
  readonly clock: Clock.Clock;
  /** The browser's epoch mapping: its first capture measures it, and later ones renew it. */
  readonly mapping: BrowserClock.Mapping;
  readonly pointer: Ref.Ref<Option.Option<Point>>;
  readonly inputLock: Semaphore.Semaphore;
  readonly publish: (event: BrowserEvent) => number;
  /** This page's retained events, oldest first. */
  readonly recentEvents: Effect.Effect<ReadonlyArray<BrowserEvent>>;
  /** Succeeds once the page's own session holds focus emulation, which keeps it painting behind. */
  readonly focused: Effect.Effect<void, BrowserError>;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";

const closedPattern =
  /has been closed|Target closed|Session closed|browser has disconnected|Target page, context or browser/i;

/**
 * Map a Playwright or protocol failure to a reason. A call that gives Playwright a timeout passes
 * the same bound, so its `Timeout` reports it; without one, Playwright's own message stays.
 */
export const reasonOf = (cause: unknown, timeoutMillis?: number): Reason => {
  const message = messageOf(cause);

  if (closedPattern.test(message)) return new Closed();
  if (cause instanceof Error && cause.name === "TimeoutError" && timeoutMillis !== undefined)
    return new Timeout({ millis: timeoutMillis });
  const line = message.split("\n")[0] ?? message;

  return new Failed({ detail: line.replace(/^[\w.]+: /, "") });
};

export const contextGone = (error: BrowserError) =>
  error.reason._tag === "Failed" &&
  /Cannot find context|Execution context was destroyed|__effectBrowser|Inspected target navigated/i.test(
    error.reason.detail,
  );

/**
 * What a page operation spent on the page's own protocol session: its calls, the bytes of their
 * parameters and results, and how long at least one of them awaited its reply. An operation inside
 * another counts toward both.
 */
interface Cost {
  readonly enclosing: Cost | undefined;
  calls: number;
  bytesOut: number;
  bytesIn: number;
  waitedMillis: number;
  awaiting: number;
  awaitingSince: number;
}

/** The cost of the page operation the current fiber runs, if any. */
const CurrentCost = Context.Reference<Cost | undefined>(
  "effect-browser/internal/page/CurrentCost",
  {
    defaultValue: () => undefined,
  },
);

// A message's size on the wire, give or take its envelope.
const sizeOf = (value: unknown) =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));

export const failWith = (operation: string, reason: Reason) =>
  Effect.fail(new BrowserError({ operation, reason, dispatched: false }));

export const decodeWith =
  <A>(operation: string, schema: Schema.Codec<A, unknown>) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (error) =>
          new BrowserError({
            operation,
            reason: new Failed({ detail: error.message }),
            dispatched: false,
          }),
      ),
    );

export const make = (options: MakeOptions, lock: Semaphore.Semaphore) => {
  const { id, clock } = options;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  // Deadlines and pacing guard the browser-wide input lock, so page operations run on the
  // owner's clock; a caller's clock, such as a TestClock, cannot stall or stretch them.
  const owned = Effect.provideService(Clock.Clock, clock);

  // This page's spans name it and report what the operation cost on the protocol. Fine-grained
  // ones carry a level below the default Info, so an application keeps only the coarse ones by
  // raising `Tracer.MinimumTraceLevel`.
  const span =
    (name: string, attributes: Record<string, unknown> = {}, level?: "Debug" | "Trace") =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const cost: Cost = {
          enclosing: yield* CurrentCost,
          calls: 0,
          bytesOut: 0,
          bytesIn: 0,
          waitedMillis: 0,
          awaiting: 0,
          awaitingSince: 0,
        };

        return yield* effect.pipe(
          Effect.provideService(CurrentCost, cost),
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.annotateCurrentSpan({
                calls: cost.calls,
                bytesOut: cost.bytesOut,
                bytesIn: cost.bytesIn,
                waitedMillis: Math.round(cost.waitedMillis * 10) / 10,
              }),
            ),
          ),
        );
      }).pipe(
        Effect.withSpan(
          name,
          { attributes: { page: id, ...attributes }, ...(level === undefined ? {} : { level }) },
          { captureStackTrace: false },
        ),
      );

  // Every call on the page's own protocol session, counted into the operation that sends it and
  // the operations around that one. It is looked up when the call is sent, so input pipelined
  // from inside an operation counts toward it too.
  const send: CDPSession["send"] = (method, params) => {
    const cost = Fiber.getCurrent()?.getRef(CurrentCost);
    const sentAt = now();
    const bytesOut = sizeOf(params);

    for (let each = cost; each !== undefined; each = each.enclosing) {
      each.calls++;
      each.bytesOut += bytesOut;
      if (each.awaiting++ === 0) each.awaitingSince = sentAt;
    }
    const reply = options.cdp.send(method, params);

    if (cost === undefined) return reply;

    const settle = (bytesIn: number) => {
      const at = now();

      for (let each: Cost | undefined = cost; each !== undefined; each = each.enclosing) {
        each.bytesIn += bytesIn;
        if (--each.awaiting === 0) each.waitedMillis += at - each.awaitingSince;
      }
    };

    return reply.then(
      (result) => {
        settle(sizeOf(result));

        return result;
      },
      (cause: unknown) => {
        settle(0);

        return Promise.reject(cause);
      },
    );
  };

  // Every protocol or Playwright call. Errors are undispatched here; `perform` marks them
  // dispatched once input has gone out.
  const native = <A>(operation: string, run: () => Promise<A>, timeoutMillis?: number) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new BrowserError({ operation, reason: reasonOf(cause, timeoutMillis), dispatched: false }),
    });

  // Actions that have started changing the page and not yet ended, and the latest submitted input
  // or page change. While an action runs no cached paint is current; afterwards only paint from
  // after its latest input is. An action ends after its input was handled, so if that input changed
  // the page, newer paint follows; a lost final paint is bounded by recency instead.
  const activity = { changing: 0, inputAt: 0 };

  const noteInput = () => {
    activity.inputAt = Math.max(activity.inputAt, now());
  };

  // Named, so that the declarations of what holds it need not spell out Playwright's protocol types.
  const protocol: Pick<CDPSession, "send"> = { send };

  return { ...options, lock, now, owned, span, protocol, native, activity, noteInput };
};

export type PageContext = ReturnType<typeof make>;
