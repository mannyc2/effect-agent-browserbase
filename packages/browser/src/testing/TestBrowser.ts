/** A seeded browser whose pages use the production lane, suspension gate and event timeline. */
import { Clock, Deferred, Duration, Effect, Option, Scope, Semaphore } from "effect";

import { type Service, Suspension } from "../Browser.ts";
import { Closed, InvalidRequest, undispatched } from "../BrowserError.ts";
import { type DisconnectCause, Disconnected, PageOpened } from "../BrowserEvent.ts";
import { monotonicMillis } from "../Clock.ts";
import * as Gate from "../internal/input/gate.ts";
import * as Timeline from "../internal/timeline/events.ts";
import type { Page } from "../Page.ts";
import { unsupported } from "./model.ts";
import { makeIn } from "./page.ts";
import type * as TestPage from "./TestPage.ts";

export const make = Effect.fnUntraced(function* (
  seeds: ReadonlyArray<TestPage.Seed> = [],
  options: {
    readonly id?: string;
    readonly connection?: string;
    readonly eventHistory?: number;
  } = {},
) {
  const clock = yield* Clock.Clock;
  const scope = yield* Scope.Scope;
  const id = options.id ?? "test-browser";
  const connection = options.connection ?? "test-connection";
  const capacity = options.eventHistory ?? 4096;

  if (!Number.isSafeInteger(capacity) || capacity < 1)
    return yield* undispatched(
      "make",
      new InvalidRequest({ detail: "eventHistory must be a positive safe integer" }),
    );
  const timeline = Timeline.make(capacity);
  const lost = Deferred.makeUnsafe<DisconnectCause>();
  const now = () => monotonicMillis(clock);
  let closedBy: DisconnectCause | undefined;
  let next = 0;
  const tracked: Array<Effect.Success<ReturnType<typeof makeIn>>> = [];

  const gate = Gate.make({
    now,
    sequence: timeline.sequence,
    closedBy: () => closedBy,
    lost: Deferred.await(lost),
    clock,
    drain: Duration.seconds(10),
  });

  const add = Effect.fnUntraced(function* (seed: TestPage.Seed = {}) {
    if (closedBy !== undefined)
      return yield* undispatched("newPage", new Closed({ cause: closedBy }));

    const test = yield* makeIn(seed, {
      id: `${id}-page-${++next}`,
      connection,
      session: id,
      gate,
      timeline,
      closedBy: () => closedBy,
    }).pipe(Effect.provideService(Scope.Scope, scope));

    tracked.push(test);
    timeline.publish(new PageOpened({ at: now(), page: test.page.id, url: yield* test.page.url }));

    return test;
  });

  const pages = Effect.gen(function* () {
    const pages: Array<Page> = [];

    for (const test of tracked) if (!(yield* test.isClosed)) pages.push(test.page);

    return pages;
  });

  const firstPageLock = Semaphore.makeUnsafe(1);

  const disconnect = (cause: DisconnectCause = "connection") =>
    Effect.sync(() => {
      if (closedBy !== undefined) return;
      closedBy = cause;
      timeline.publish(new Disconnected({ at: now(), cause }));
      Deferred.doneUnsafe(lost, Effect.succeed(cause));
    });

  const browser: Service = {
    id,
    connection,
    provider: "test",
    expiresAt: undefined,
    now: Effect.sync(now),
    suspend: (options) =>
      Effect.map(gate.suspend(options?.drain), (stopped) => new Suspension(stopped)),
    pages,
    page: (id) =>
      Effect.map(pages, (pages) => Option.fromUndefinedOr(pages.find((page) => page.id === id))),
    firstPage: firstPageLock.withPermits(1)(
      Effect.flatMap(pages, (pages) =>
        pages[0] === undefined ? Effect.map(add(), (test) => test.page) : Effect.succeed(pages[0]),
      ),
    ),
    newPage: (url) => Effect.map(add({ url }), (test) => test.page),
    hasCookie: () => unsupported("hasCookie"),
    disconnected: Deferred.await(lost),
    events: (options) => timeline.stream(options?.after),
    recentEvents: Effect.map(timeline.recent, (records) => records.map((record) => record.event)),
  };

  for (const seed of seeds) yield* add(seed);
  yield* Effect.addFinalizer(() => Effect.andThen(disconnect("released"), timeline.close));

  return { browser, add, disconnect, pages: Effect.sync(() => [...tracked]) };
});
