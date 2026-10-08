// The supervisor's lifecycle as a model: random runs of opens, failures, losses, rotations,
// releases and retiring, each checked against the rules a supervisor must keep. Then the
// supervisor itself: over local Chromium for losses and rotations, and over stand-in browsers on
// the test clock for its timing.

import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, DateTime, Effect, Fiber, Option, Schedule, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import type * as Browser from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Lifecycle from "../src/internal/supervisor/lifecycle.ts";
import * as Supervisor from "../src/Supervisor.ts";

type Phase = "opening" | "open" | "lost" | "ended";

/** The runtime around the transition: its open fiber, watchers and releases, as plain records. */
interface World {
  readonly exclusive: boolean;
  state: Lifecycle.State<string>;
  opening: { readonly number: number; readonly after: number | undefined } | undefined;
  cancelling: boolean;
  retired: boolean;
  newest: number;
  readonly opened: Set<number>;
  readonly ordered: Set<number>;
  readonly releasing: Set<number>;
  readonly released: Set<number>;
  readonly watched: Set<number>;
  readonly fired: Set<string>;
  readonly phases: Map<number, { phase: Phase }>;
}

/** Each change a generation makes after it began: the phases it can make it in, and the next. */
const moves = {
  Open: [["opening"], "open"],
  Lost: [["open"], "lost"],
  Down: [["opening"], "ended"],
  Closed: [["opening", "open", "lost"], "ended"],
} satisfies Record<string, readonly [ReadonlyArray<Phase>, Phase]>;

const advance = (world: World, number: number, state: Lifecycle.GenerationState) => {
  const known = world.phases.get(number);

  if (state._tag === "Opening" || state._tag === "Reopening") {
    assert.isUndefined(known, `generation ${number} begins once`);
    world.phases.set(number, { phase: "opening" });

    return;
  }
  assert.isDefined(known, `generation ${number} changes only after it began`);
  const [from, to] = moves[state._tag];

  assert.include(
    from,
    known.phase,
    `generation ${number} is not ${state._tag} once ${known.phase}`,
  );
  if (state._tag === "Closed" && state.released === undefined)
    assert.strictEqual(known.phase, "opening", "only an open that never finished has no release");
  known.phase = to;
};

const apply = (world: World, input: Lifecycle.Input<string>) => {
  const before = world.state;
  const step = Lifecycle.transition(world.state, input, world.exclusive);

  for (const [number, state] of step.events) advance(world, number, state);
  for (const command of step.commands)
    switch (command._tag) {
      case "Open":
        assert.isUndefined(world.opening, "one open at a time");
        assert.isFalse(world.retired, "nothing opens once retired");
        assert.isAbove(command.number, world.newest, "generation numbers only grow");
        world.newest = command.number;
        world.opening = { number: command.number, after: command.after };
        break;
      case "Watch":
        world.watched.add(command.live.number);
        break;
      case "Release":
        assert.isTrue(world.opened.has(command.live.number), "only what opened is released");
        assert.isFalse(world.ordered.has(command.live.number), "each generation is released once");
        world.ordered.add(command.live.number);
        world.releasing.add(command.live.number);
        world.watched.delete(command.live.number);
    }
  world.state = step.state;

  const serving = step.state._tag === "Retired" ? undefined : step.state.serving;

  assert.isFalse(
    serving !== undefined && world.ordered.has(serving.number),
    "a released one never serves",
  );
  if (world.retired) assert.strictEqual(step.state._tag, "Retired");
  if (world.exclusive)
    assert.isFalse(
      step.state._tag === "Opening" && serving !== undefined,
      "exclusive ones never overlap",
    );
  if (input._tag === "Rotate" && input.due !== undefined && step.commands.length > 0)
    assert.isTrue(
      before._tag === "Open" && before.serving.number === input.due,
      "only the serving generation's own time rotates it",
    );
  for (const [number, state] of step.events)
    if (state._tag === "Lost") {
      assert.deepStrictEqual(
        input,
        { _tag: "Lost", number, cause: state.cause },
        "only the lost generation is lost, with its cause",
      );
      assert.strictEqual(step.state._tag, "Opening", "a loss reopens at once");
    }

  const waiting = Lifecycle.resolve(step.state, undefined);

  if (step.state._tag === "Retired") assert.strictEqual(waiting?._tag, "Unavailable");
  else if (serving !== undefined)
    assert.strictEqual(waiting?._tag === "Serve" && waiting.live, serving);
  else if (step.state._tag === "Down") assert.strictEqual(waiting?._tag, "Unavailable");
  else assert.isUndefined(waiting, "a caller waits while the first opens");

  return { before, reply: step.reply };
};

/** The actions the world can take now, each a name and what it does. */
const enabled = (world: World): ReadonlyArray<readonly [string, () => void]> => {
  const actions: Array<readonly [string, () => void]> = [];
  const { opening } = world;

  // The open of a generation tries until it opens or its schedule gives up; a try that fails and
  // is tried again changes nothing the transition sees. Exclusive ones try only once the
  // generation before has been released.
  if (opening !== undefined) {
    const ready = opening.after === undefined || !world.releasing.has(opening.after);

    const tried = (input: Lifecycle.Input<string>) => () => {
      if (world.exclusive)
        for (const number of world.opened)
          assert.isTrue(world.released.has(number), `${number} ended before the next tried`);
      world.opening = undefined;
      if (input._tag === "Opened") world.opened.add(opening.number);
      apply(world, input);
    };

    if (ready)
      actions.push(
        [
          "succeed",
          tried({
            _tag: "Opened",
            live: { number: opening.number, value: `browser ${opening.number}` },
          }),
        ],
        [
          "give up",
          tried({ _tag: "Failed", number: opening.number, detail: "refused", cause: "refused" }),
        ],
      );
    if (world.cancelling)
      actions.push([
        "cancel",
        () => {
          world.opening = undefined;
          apply(world, { _tag: "Abandoned", number: opening.number });
        },
      ]);
  }
  for (const number of new Set([...world.watched, ...world.releasing])) {
    if (!world.fired.has(`lost ${number}`))
      actions.push([
        `lose ${number}`,
        () => {
          world.fired.add(`lost ${number}`);
          // A generation being released is lost to its own release.
          apply(world, {
            _tag: "Lost",
            number,
            cause: world.releasing.has(number) ? "released" : "connection",
          });
        },
      ]);
    if (!world.fired.has(`due ${number}`))
      actions.push([
        `due ${number}`,
        () => {
          world.fired.add(`due ${number}`);
          apply(world, { _tag: "Rotate", due: number });
        },
      ]);
  }
  for (const number of world.releasing)
    actions.push([
      `release ${number}`,
      () => {
        world.releasing.delete(number);
        world.released.add(number);
        apply(world, {
          _tag: "Released",
          number,
          released:
            number % 3 === 0
              ? new Lifecycle.Unconfirmed({ detail: "running" })
              : new Lifecycle.Settled(),
        });
      },
    ]);
  actions.push([
    "rotate",
    () => {
      const { before, reply } = apply(world, { _tag: "Rotate" });

      if (before._tag === "Retired") assert.isUndefined(reply);
      else assert.isTrue(world.state._tag === "Opening" && world.state.number === reply);
    },
  ]);

  return actions;
};

const retire = (world: World) => {
  world.retired = true;
  world.cancelling = true;
  apply(world, { _tag: "Retire" });
};

// Callers and timers act less often than the runtime's own fibers, so runs reach deep states.
const weight = (name: string) => (name === "rotate" ? 1 : /^(lose|due) /.test(name) ? 2 : 6);

const run = (choices: ReadonlyArray<number>, exclusive: boolean, retireAt: number) => {
  const started = Lifecycle.start<string>();

  const world: World = {
    exclusive,
    state: started.state,
    opening: { number: 1, after: undefined },
    cancelling: false,
    retired: false,
    newest: 1,
    opened: new Set(),
    ordered: new Set(),
    releasing: new Set(),
    released: new Set(),
    watched: new Set(),
    fired: new Set(),
    phases: new Map(),
  };

  for (const [number, state] of started.events) advance(world, number, state);

  for (const [index, choice] of choices.entries()) {
    if (index === retireAt) retire(world);
    const actions = enabled(world);
    let pick = choice % actions.reduce((total, [name]) => total + weight(name), 0);

    for (const [name, act] of actions) {
      pick -= weight(name);
      if (pick < 0) {
        act();
        break;
      }
    }
  }
  // Retire, then let everything still running finish.
  if (!world.retired) retire(world);
  for (let guard = 0; world.opening !== undefined || world.releasing.size > 0; guard++) {
    assert.isBelow(guard, 100, "a retired supervisor settles");
    const actions = enabled(world).filter(([name]) => !/^(lose|due|rotate)/.test(name));

    (actions.find(([name]) => name === "cancel") ?? actions[0])?.[1]();
  }

  for (const [number, { phase }] of world.phases)
    assert.strictEqual(phase, "ended", `generation ${number} ends once retired`);
  assert.deepStrictEqual(
    [...world.opened].toSorted((a, b) => a - b),
    [...world.released].toSorted((a, b) => a - b),
  );
};

describe("Supervisor's lifecycle", () => {
  it.prop(
    "keeps its rules through any run of opens, losses, rotations and releases",
    {
      choices: Arbitrary.array(
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
        { minLength: 20, maxLength: 120 },
      ),
      exclusive: Arbitrary.schema(Schema.Boolean),
      retireAt: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 150 }))),
    },
    ({ choices, exclusive, retireAt }) => run(choices, exclusive, retireAt),
    { arbitrary: { runs: 1000, size: 120 } },
  );
});

/** A generation's change as one line, such as `2 Reopening` or `1 Closed Settled`. */
const line = ({ number, state }: Supervisor.Generation) =>
  state._tag === "Closed"
    ? `${number} Closed ${state.released?._tag ?? "none"}`
    : state._tag === "Lost"
      ? `${number} Lost ${state.cause}`
      : `${number} ${state._tag}`;

/** Everything `states` publishes until the supervisor retires, as lines. */
const record = (supervisor: Supervisor.Supervisor) =>
  supervisor.states.pipe(Stream.map(line), Stream.runCollect, Effect.forkChild);

/** One generation's lines, in the order published. */
const of = (lines: ReadonlyArray<string>, number: number) =>
  lines.filter((candidate) => candidate.startsWith(`${number} `));

/** Wait until a generation's change has been published. */
const published = (supervisor: Supervisor.Supervisor, expected: string) =>
  supervisor.states.pipe(
    Stream.filter((generation) => line(generation) === expected),
    Stream.runHead,
  );

const local = Chromium.open().pipe(Effect.map((browser) => ({ browser })));

/** A browser never driven and never lost, which its provider ends at `expiresAt`, if given. */
const standIn = (expiresAt?: DateTime.Utc) =>
  ({ disconnected: Effect.never, expiresAt }) as unknown as Browser.Service;

describe("Supervisor", () => {
  it.live("publishes a loss at once, reopens, and reports the lost generation's release", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.make({
        open: local,
        reopen: Schedule.spaced("10 millis"),
      });

      const states = yield* record(supervisor);
      const first = yield* supervisor.browser;

      // Closed from the other side, as a dropped connection or a crash would close it.
      yield* Effect.promise(async () => first.context.browser()?.close());
      yield* published(supervisor, "2 Open");
      const second = yield* supervisor.browser;

      assert.notStrictEqual(second, first);
      assert.isTrue(second.context.browser()?.isConnected());
      yield* supervisor.retire;
      assert.isFalse(second.context.browser()?.isConnected());
      const lines = yield* Fiber.join(states);

      assert.deepStrictEqual(of(lines, 1), [
        "1 Opening",
        "1 Open",
        "1 Lost connection",
        "1 Closed Settled",
      ]);
      assert.deepStrictEqual(of(lines, 2), ["2 Reopening", "2 Open", "2 Closed Settled"]);
      assert.isBelow(lines.indexOf("1 Lost connection"), lines.indexOf("2 Reopening"));
    }),
  );

  it.live("makes the next generation before it breaks the current, unless they are exclusive", () =>
    Effect.gen(function* () {
      for (const exclusive of [false, true]) {
        // The order in which the provider opened and released its browsers.
        const order: Array<string> = [];

        const open = Effect.sync(() => order.push("open")).pipe(
          Effect.andThen(Chromium.open()),
          Effect.map((browser) => ({
            browser,
            release: Effect.sync(() => order.push("release")).pipe(
              Effect.as(new Supervisor.Settled()),
            ),
          })),
        );

        const lines = yield* Effect.gen(function* () {
          const supervisor = yield* Supervisor.make({ open, exclusive });
          const states = yield* record(supervisor);
          const first = yield* supervisor.browser;

          assert.notStrictEqual(yield* supervisor.rotate, first);
          yield* supervisor.retire;

          return yield* Fiber.join(states);
        }).pipe(Effect.scoped);

        assert.deepStrictEqual(
          order.slice(0, 3),
          exclusive ? ["open", "release", "open"] : ["open", "open", "release"],
        );
        if (exclusive)
          assert.isBelow(lines.indexOf("1 Closed Settled"), lines.indexOf("2 Open"), lines.join());
        else
          assert.isBelow(lines.indexOf("2 Open"), lines.indexOf("1 Closed Settled"), lines.join());
      }
    }),
  );

  it.effect("rotates `rotateBefore` ahead of a generation's end, and no sooner than halfway", () =>
    Effect.gen(function* () {
      let opened = 0;

      const open = DateTime.now.pipe(
        Effect.map((now) => {
          opened += 1;

          return { browser: standIn(DateTime.add(now, { minutes: opened === 1 ? 60 : 10 })) };
        }),
      );

      const supervisor = yield* Supervisor.make({ open, rotateBefore: "20 minutes" });

      yield* published(supervisor, "1 Open");
      yield* TestClock.adjust("39 minutes");
      assert.strictEqual(opened, 1);
      yield* TestClock.adjust("1 minute");
      yield* published(supervisor, "2 Open");
      // The second ends 10 minutes after it opened, so it rotates halfway, at 5 minutes.
      yield* TestClock.adjust("4 minutes");
      assert.strictEqual(opened, 2);
      yield* TestClock.adjust("1 minute");
      yield* published(supervisor, "3 Open");
    }),
  );

  it.effect("stops a reopen waiting on its schedule at once when retired", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const open = Effect.suspend(() => Effect.fail(`refused ${++attempts}`));
      const supervisor = yield* Supervisor.make({ open, reopen: Schedule.spaced("1 hour") });
      const states = yield* record(supervisor);

      // Let the first try fail, so the reopen waits an hour for the next one.
      while (attempts === 0) yield* Effect.yieldNow;
      yield* supervisor.retire;
      assert.strictEqual(attempts, 1);
      assert.deepStrictEqual(yield* Fiber.join(states), ["1 Opening", "1 Closed none"]);
      assert.strictEqual((yield* Effect.flip(supervisor.browser)).reason, "retired");
    }),
  );

  it.effect("finishes an open its caller stopped waiting for, and bounds every wait", () =>
    Effect.gen(function* () {
      const open = Effect.sleep("30 seconds").pipe(Effect.as({ browser: standIn() }));
      const supervisor = yield* Supervisor.make({ open, waitTimeout: "10 seconds" });

      const impatient = yield* Effect.forkChild(
        supervisor.browser.pipe(Effect.timeout("1 second")),
      );

      const patient = yield* Effect.forkChild(Effect.flip(supervisor.browser));

      yield* TestClock.adjust("10 seconds");
      assert.isTrue((yield* Fiber.await(impatient))._tag === "Failure");
      assert.strictEqual((yield* Fiber.join(patient)).reason, "opening");
      yield* TestClock.adjust("20 seconds");
      yield* published(supervisor, "1 Open");
      yield* supervisor.browser;
    }),
  );

  it.effect("goes down at once, with its cause, on a failure the provider deems definite", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const open = Effect.suspend(() => Effect.fail(++attempts === 1 ? "refused key" : "busy"));

      const supervisor = yield* Supervisor.make({
        open,
        reopen: Schedule.spaced("1 second"),
        definite: (error) => error === "refused key",
      });

      // Trying again would have tried several times within these seconds.
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(attempts, 1);

      const down = yield* supervisor.states.pipe(
        Stream.filter(({ state }) => state._tag === "Down"),
        Stream.runHead,
      );

      assert.deepStrictEqual(
        down.pipe(Option.map(({ state }) => state._tag === "Down" && state.cause)),
        Option.some("refused key"),
      );
      const unavailable = yield* Effect.flip(supervisor.browser);

      assert.deepStrictEqual([unavailable.reason, unavailable.cause], ["down", "refused key"]);
    }),
  );

  it.effect("goes down when its schedule gives up, and opens again on `rotate`", () =>
    Effect.gen(function* () {
      let attempts = 0;

      const open = Effect.suspend(() =>
        ++attempts <= 2
          ? Effect.fail(`refused ${attempts}`)
          : Effect.succeed({ browser: standIn() }),
      );

      const supervisor = yield* Supervisor.make({ open, reopen: Schedule.recurs(1) });

      yield* published(supervisor, "1 Down");
      assert.deepStrictEqual(
        yield* Effect.flip(supervisor.browser).pipe(
          Effect.map(({ reason, detail }) => [reason, detail]),
        ),
        ["down", "refused 2"],
      );
      yield* supervisor.rotate;
      assert.strictEqual(attempts, 3);
    }),
  );
});
