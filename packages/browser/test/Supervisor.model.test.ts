// The proposed core's rules, checked over random runs of its transition, as the library's model
// test checks today's (packages/browser/test/Supervisor.test.ts). Pure: no Effect runtime.
import { assert, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";

import * as Released from "../src/providers/Released.ts";
import * as Core from "../src/supervisor/lifecycle.ts";
import type { State, Why } from "../src/supervisor/Supervisor.ts";

type Phase = "none" | "trying" | "failed" | "open" | "ending" | "ended";
type Tag = State<string>["_tag"];

/** Each change a generation publishes: the phases it may follow, and the next. */
const moves: Record<Tag, readonly [ReadonlyArray<Phase>, Phase]> = {
  Opening: [["none", "failed"], "trying"],
  Failed: [["trying"], "failed"],
  // A try that dies has no error to publish, so its generation goes Down from the try.
  Down: [["failed", "trying"], "ended"],
  Open: [["trying"], "open"],
  Ending: [["open"], "ending"],
  Closed: [["ending", "failed"], "ended"],
};

interface Opening {
  readonly number: number;
  attempt: number;
  began: boolean;
  trying: boolean;
  failed: boolean;
}

interface World {
  readonly exclusive: boolean;
  state: Core.Core<string, number, string>;
  newest: number;
  hold: number;
  opening: Opening | undefined;
  retired: boolean;
  readonly opened: Set<number>;
  readonly ended: Map<number, Why>;
  readonly releasing: Set<number>;
  readonly released: Set<number>;
  readonly lost: Set<number>;
  readonly holds: Map<number, Set<number>>;
  readonly phases: Map<number, Phase>;
}

class Broken extends Error {}

const check = (holds: boolean, rule: string) => {
  if (!holds) throw new Broken(rule);
};

const reached = new Map<string, number>();
const note = (what: string) => reached.set(what, (reached.get(what) ?? 0) + 1);

const advance = (world: World, number: number, state: State<string>) => {
  const known = world.phases.get(number) ?? "none";
  const [from, to] = moves[state._tag];

  if (state._tag === "Opening")
    check(
      state.attempt === 1 ? known === "none" : known === "failed",
      "a try begins its generation or follows a failed one",
    );
  else check(from.includes(known), `a generation is not ${state._tag} once ${known}`);
  if (state._tag === "Closed")
    check(
      (state.released === undefined) === (known === "failed"),
      "only one that never opened closes without a release",
    );
  world.phases.set(number, to);
};

const openingOf = (state: Core.Core<string, number, string>) =>
  state._tag === "Retired"
    ? state.opening
    : state._tag === "Opening" && state.started
      ? state.number
      : undefined;

type Transition = typeof Core.transition<string, number, string>;

const transition: Transition = Core.transition;

const apply = (world: World, input: Core.Input<string, number, string>) => {
  const before = world.state;
  const step = transition(before, input, world.exclusive);

  for (const [number, state] of step.events) advance(world, number, state);
  for (const command of step.commands)
    switch (command._tag) {
      case "Open":
        check(world.opening === undefined, "one open at a time");
        check(!world.retired, "nothing opens once retired");
        check(command.number > world.newest, "generation numbers only grow");
        if (world.exclusive)
          check(
            [...world.opened].every((number) => world.released.has(number)),
            "an exclusive generation opens only once every earlier one is released",
          );
        world.newest = command.number;
        world.opening = {
          number: command.number,
          attempt: 0,
          began: false,
          trying: false,
          failed: false,
        };
        break;
      case "Watch":
        check(world.opened.has(command.live.number), "only what opened is watched");
        break;
      case "End":
        check(world.opened.has(command.live.number), "only what opened ends");
        check(!world.ended.has(command.live.number), "each generation ends once");
        world.ended.set(command.live.number, command.why);
        break;
      case "Release":
        check(
          world.ended.get(command.live.number) === command.why,
          "a release is told why its generation ended",
        );
        check(
          !world.releasing.has(command.live.number) && !world.released.has(command.live.number),
          "each generation is released once",
        );
        check(command.live.holds.size === 0, "a release starts after the last hold");
        world.releasing.add(command.live.number);
        break;
      case "Stop":
        check(input._tag === "Retire", "only retiring stops");
    }
  world.state = step.state;

  const serving = Core.servingOf(step.state);

  check(openingOf(step.state) === world.opening?.number, "the state names the open that runs");
  check(serving === undefined || !world.ended.has(serving.number), "an ended one never serves");
  for (const number of step.state.ended.keys())
    check(world.opened.has(number) && world.ended.has(number), "only opened, ended ones release");
  for (const number of world.released)
    check(
      serving?.number !== number && !step.state.ended.has(number),
      "a released generation is forgotten",
    );
  if (world.retired) check(step.state._tag === "Retired", "a retired supervisor stays retired");
  if (step.state._tag === "Opening" && !step.state.started)
    check(step.state.ended.size > 0, "an exclusive open waits only while one is ending");
  if (world.exclusive)
    check(
      !(step.state._tag === "Opening" && step.state.serving !== undefined),
      "exclusive generations never overlap",
    );
  if (input._tag === "Hold")
    if (step.borrowed === undefined) check(step.state === before, "a refused hold changes nothing");
    else
      check(
        Core.servingOf(before)?.number === step.borrowed.number,
        "a hold borrows only the serving generation",
      );
  if (input._tag === "Lost" && Core.servingOf(before)?.number !== input.number)
    check(
      step.state === before && step.events.length === 0 && step.commands.length === 0,
      "a loss of one not serving changes nothing",
    );
  if (input._tag === "Lost" && before._tag === "Open" && before.serving.number === input.number)
    check(
      step.state._tag === "Opening" && step.state.number === input.number + 1,
      "a serving loss opens the next at once",
    );
  if (input._tag === "Rotate" && input.from !== undefined)
    check(
      (step.reply !== undefined) ===
        (before._tag !== "Retired" && Core.servingOf(before)?.number === input.from),
      "a rotation that names a generation acts exactly while it serves",
    );

  const waiting = Core.resolve(step.state);

  if (step.state._tag === "Retired") check(waiting?._tag === "Unavailable", "retired: unavailable");
  else if (serving !== undefined) check(waiting?._tag === "Serve", "serving: served");
  else if (step.state._tag === "Down") check(waiting?._tag === "Unavailable", "down: unavailable");
  else check(waiting === undefined, "opening: a caller waits");
  if (step.state._tag === "Opening" && !step.state.started) note("an exclusive open waits");
  if (step.state._tag === "Down" && step.state.serving !== undefined) note("down, still serving");
  if (step.state._tag === "Opening" && step.state.serving !== undefined) note("make before break");
  if (input._tag === "Opened" && before._tag === "Retired") note("opened after retiring");
  if (input._tag === "Try" && step.reply === undefined) note("a try refused once retired");
  if (input._tag === "GaveUp" && input.error === undefined) note("a try died");

  return step;
};

/** The actions the world can take now: the open's fiber, losses, callers and releases. */
const enabled = (world: World): ReadonlyArray<readonly [string, () => void]> => {
  const actions: Array<readonly [string, () => void]> = [];
  const opening = world.opening;

  if (opening !== undefined)
    if (opening.trying) {
      actions.push(
        [
          "succeed",
          () => {
            opening.trying = false;
            world.opening = undefined;
            world.opened.add(opening.number);
            apply(world, { _tag: "Opened", number: opening.number, value: `${opening.number}` });
          },
        ],
        [
          "fail",
          () => {
            opening.trying = false;
            opening.failed = true;
            apply(world, {
              _tag: "Failed",
              number: opening.number,
              attempt: opening.attempt,
              error: "refused",
            });
          },
        ],
        [
          "die",
          () => {
            opening.trying = false;
            world.opening = undefined;
            apply(world, {
              _tag: "GaveUp",
              number: opening.number,
              error: undefined,
              detail: "a defect",
            });
          },
        ],
      );
    } else {
      actions.push([
        "try",
        () => {
          opening.attempt += 1;

          const step = apply(world, {
            _tag: "Try",
            number: opening.number,
            attempt: opening.attempt,
          });

          if (step.reply !== undefined) {
            opening.trying = true;
            opening.began = true;
          } else {
            world.opening = undefined;
            apply(world, { _tag: "Stopped", number: opening.number, began: opening.began });
          }
        },
      ]);
      if (opening.failed)
        actions.push([
          "give up",
          () => {
            world.opening = undefined;
            apply(world, {
              _tag: "GaveUp",
              number: opening.number,
              error: "refused",
              detail: "refused",
            });
          },
        ]);
      if (world.retired)
        actions.push([
          "stop",
          () => {
            world.opening = undefined;
            apply(world, { _tag: "Stopped", number: opening.number, began: opening.began });
          },
        ]);
    }
  for (const number of world.opened) {
    if (!world.released.has(number) && !world.lost.has(number))
      actions.push([
        `lose ${number}`,
        () => {
          world.lost.add(number);
          apply(world, { _tag: "Lost", number, detail: "connection" });
        },
      ]);
    actions.push([
      `declare ${number}`,
      () => apply(world, { _tag: "Lost", number, detail: "declared" }),
    ]);
    actions.push([`rotate from ${number}`, () => apply(world, { _tag: "Rotate", from: number })]);
  }
  for (const [number, holds] of world.holds)
    for (const hold of holds)
      actions.push([
        `let ${number} ${hold}`,
        () => {
          holds.delete(hold);
          apply(world, { _tag: "Let", number, hold });
        },
      ]);
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
              ? new Released.Unconfirmed({ detail: `${number} may run` })
              : new Released.Settled(),
        });
      },
    ]);
  actions.push([
    "hold",
    () => {
      const hold = ++world.hold;
      const step = apply(world, { _tag: "Hold", hold });

      if (step.borrowed !== undefined) {
        const holds = world.holds.get(step.borrowed.number) ?? new Set<number>();

        holds.add(hold);
        world.holds.set(step.borrowed.number, holds);
      }
    },
  ]);
  actions.push(["rotate", () => apply(world, { _tag: "Rotate" })]);

  return actions;
};

const weight = (name: string) =>
  /^(rotate|hold|declare|die)/.test(name) ? 1 : /^(lose|give up)/.test(name) ? 2 : 6;

const retire = (world: World) => {
  world.retired = true;
  apply(world, { _tag: "Retire" });
};

/** Small, seeded and fast: mulberry32. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const run = (seed: number) => {
  const next = random(seed);
  const exclusive = next() < 0.5;
  const length = 20 + Math.floor(next() * 130);
  const retireAt = Math.floor(next() * 150);
  const started = Core.start<string, number, string>();

  const world: World = {
    exclusive,
    state: started.state,
    newest: 1,
    hold: 0,
    opening: { number: 1, attempt: 0, began: false, trying: false, failed: false },
    retired: false,
    opened: new Set(),
    ended: new Map(),
    releasing: new Set(),
    released: new Set(),
    lost: new Set(),
    holds: new Map(),
    phases: new Map(),
  };

  for (let index = 0; index < length; index++) {
    if (index === retireAt) retire(world);
    const actions = enabled(world);
    let pick = next() * actions.reduce((total, [name]) => total + weight(name), 0);

    for (const [name, act] of actions) {
      pick -= weight(name);
      if (pick < 0) {
        act();
        break;
      }
    }
  }
  if (!world.retired) retire(world);
  // Let everything still running finish: tries end, holds let go, releases complete.
  for (let guard = 0; ; guard++) {
    check(guard < 500, "a retired supervisor settles");

    const actions = enabled(world).filter(([name]) =>
      /^(succeed|fail|stop|let|release)/.test(name),
    );

    if (actions.length === 0) break;
    actions[Math.floor(next() * actions.length)]![1]();
  }
  check(world.opening === undefined && world.releasing.size === 0, "nothing runs once settled");
  check(world.state.ended.size === 0, "every ended generation was released");
  for (const [number, phase] of world.phases)
    check(phase === "ended", `generation ${number} ends once retired`);
  check(
    [...world.opened].every((number) => world.released.has(number)) &&
      world.opened.size === world.released.size,
    "everything opened is released, once",
  );

  return length;
};

it.prop(
  "releases each resource once through arbitrary failures, loss, rotation and retirement",
  {
    seed: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 }))),
  },
  ({ seed }) => assert.isAbove(run(seed), 0),
  { arbitrary: { runs: 5000 } },
);
