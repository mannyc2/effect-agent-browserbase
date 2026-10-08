/**
 * What a page's parts share: the browser state they act on, the page's own lane, pointer and
 * clock, and how they call the browser and report its failures. The assembly in `page.ts` builds
 * one context per page.
 */
import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  MutableRef,
  Option,
  Schema,
  type Scope,
} from "effect";
import type { CDPSession, Page as PlaywrightPage } from "playwright-core";

import type { CaptureSource } from "../../Browser.ts";
import { BrowserError, Closed, Failed, type Reason, Timeout } from "../../BrowserError.ts";
import type { BrowserEvent } from "../../BrowserEvent.ts";
import type { Point, Settings } from "../../Page.ts";
import type * as BrowserClock from "../pictures/clock.ts";
import * as Lane from "./lane.ts";
import * as Url from "./url.ts";

/** Why a page is gone. */
export type ClosedCause = Closed["cause"];

export interface MakeOptions {
  /** The page's CDP target id, which is also its main frame's id. */
  readonly id: string;
  /** The id of the browser's session, which its frames carry. */
  readonly session: string;
  /** The page's address when the browser began tracking it. */
  readonly url: string;
  readonly playwright: PlaywrightPage;
  readonly cdp: CDPSession;
  /** A call's reply, or a failure as for a closed page once the browser is lost first. */
  readonly untilLost: <A>(reply: Promise<A>) => Promise<A>;
  readonly settings: Settings;
  readonly clock: Clock.Clock;
  /** The browser's epoch mapping: its first capture measures it, and later ones renew it. */
  readonly mapping: BrowserClock.Mapping;
  readonly publish: (event: BrowserEvent) => number;
  /** This page's retained events, oldest first. */
  readonly recentEvents: Effect.Effect<ReadonlyArray<BrowserEvent>>;
  /** Succeeds once the page's own session holds focus emulation, which keeps it painting behind. */
  readonly focused: Effect.Effect<void, BrowserError>;
  /** Succeeds once the page's own session has the Page domain on, so it sees every later commit. */
  readonly paging: (operation: string) => Effect.Effect<void, BrowserError>;
  /** Why the page is gone, once it is: its browser's loss, else its own close or crash. */
  readonly closedBy: () => ClosedCause;
  /** Where the page's screencast runs, if not on its own session. */
  readonly capture?: CaptureSource | undefined;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";

const closedPattern =
  /has been closed|Target closed|Session closed|browser has disconnected|Target page, context or browser/i;

/**
 * Map a Playwright or protocol failure to a reason, `Closed` with `closed` as its cause for a page
 * or browser that is gone. A call that gives Playwright a timeout passes the same bound, so its
 * `Timeout` reports it; without one, Playwright's own message stays.
 */
export const reasonOf = (
  cause: unknown,
  timeoutMillis?: number,
  closed: ClosedCause = "connection",
): Reason => {
  const message = messageOf(cause);

  if (closedPattern.test(message)) return new Closed({ cause: closed });
  if (cause instanceof Error && cause.name === "TimeoutError" && timeoutMillis !== undefined)
    return new Timeout({ millis: timeoutMillis });
  const line = message.split("\n")[0] ?? message;

  return new Failed({ detail: Url.redactWithin(line.replace(/^[\w.]+: /, "")) });
};

/**
 * One Playwright or protocol call, failing undispatched. A closed page says why it is gone as the
 * browser knows then: the library's own calls fail with the browser's loss, and Playwright fails
 * its calls on a dropped connection after reporting the context closed.
 */
export const call = <A>(
  operation: string,
  run: () => Promise<A>,
  closedBy: () => ClosedCause,
  timeoutMillis?: number,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new BrowserError({
        operation,
        reason: reasonOf(cause, timeoutMillis, closedBy()),
        dispatched: false,
      }),
  });

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

export const make = (options: MakeOptions, scope: Scope.Scope) => {
  const { id, clock } = options;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  // Deadlines and pacing guard the page's lane, so page operations run on the owner's clock; a
  // caller's clock, such as a TestClock, cannot stall or stretch them.
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
    const reply = options.untilLost(options.cdp.send(method, params));

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
    call(operation, run, options.closedBy, timeoutMillis);

  /** Fail with `Timeout` once `duration` has passed, the action timeout unless another is given. */
  const within =
    (operation: string, duration: Duration.Input = options.settings.actionTimeout) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.timeoutOrElse(effect, {
        duration,
        orElse: () => failWith(operation, new Timeout({ millis: Duration.toMillis(duration) })),
      });

  // The latest submitted input or page change. A read that must follow it waits for the action in
  // flight, so only paint from after its latest input is current. An action ends after its input
  // was handled, so if that input changed the page, newer paint follows; a lost final paint is
  // bounded by recency instead. Paint from before the current document began, when the page's own
  // session saw the main frame commit it, shows a page the tab has left, so no read reuses it,
  // whatever it asks.
  const activity = { inputAt: 0, documentAt: Number.NEGATIVE_INFINITY };

  const noteInput = () => {
    activity.inputAt = Math.max(activity.inputAt, now());
  };

  const lane = Lane.make({
    now,
    actionTimeout: options.settings.actionTimeout,
    documentAt: () => activity.documentAt,
    gone: (operation) =>
      new BrowserError({
        operation,
        reason: new Closed({ cause: options.closedBy() }),
        dispatched: false,
      }),
    scope,
  });

  // Where this page's latest move left its pointer, which is where its next plain glide starts and
  // where a held button is released. Its lane orders the page's input, and Chromium keeps a
  // pointer per page too.
  const pointer = MutableRef.make(Option.none<Point>());

  // Named, so that the declarations of what holds it need not spell out Playwright's protocol types.
  const protocol: Pick<CDPSession, "send"> = { send };

  return {
    ...options,
    lane,
    pointer,
    now,
    owned,
    span,
    protocol,
    native,
    within,
    activity,
    noteInput,
  };
};

export type PageContext = ReturnType<typeof make>;
