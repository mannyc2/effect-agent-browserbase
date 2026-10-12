// The accepted generic API plan requests two executable consumer compositions. These tests
// exercise retained output ownership and a restarted journal against actual local Chromium.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { Subject } from "effect-browser/BrowserEvent";
import * as Chromium from "effect-browser/Chromium";
import * as Plan from "effect-browser/Plan";
import * as Supervisor from "effect-browser/Supervisor";

import * as Watched from "../Watched.ts";
import * as Workflow from "../Workflow.ts";

const button = (name: string) => new Subject({ role: "button", name, tag: "button", context: {} });

const fixture = Effect.fnUntraced(function* (needsOperator = false) {
  let submissions = 0;
  let verified = !needsOperator;
  let visibleReceipt = true;

  const server = createServer((request, response) => {
    if (request.method === "POST") {
      if (request.url === "/submit") submissions++;
      if (request.url === "/verify") verified = true;
      response.end();

      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Composition fixture</title>
      <body style="background: white"><main>
      ${
        verified
          ? '<button id="submit">Submit claim</button>'
          : '<p>Operator verification required</p><button id="verify">Verify operator</button>'
      }
      ${submissions > 0 && visibleReceipt ? "<h1>Saved claim RUN-1</h1>" : ""}
      <button id="first">First</button><button id="second">Second</button>
      <output id="steps"></output></main><script>
      document.getElementById('submit')?.addEventListener('click', async () => {
        await fetch('/submit', { method: 'POST' });
        document.querySelector('main').insertAdjacentHTML('beforeend', '<h1>Saved claim RUN-1</h1>');
      });
      document.getElementById('verify')?.addEventListener('click', async () => {
        await fetch('/verify', { method: 'POST' }); location.reload();
      });
      for (const name of ['first', 'second']) document.getElementById(name).onclick = () => {
        document.getElementById('steps').textContent += name + ' ';
      };
      </script>`);
  });

  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const walk = Plan.Plan.new([new Plan.Step({ action: "navigate", url, target: url })]);
  const closed: Array<number> = [];
  let opened = 0;

  const sessions = yield* Supervisor.make({
    handover: "2 seconds",
    open: Effect.gen(function* () {
      const browser = yield* Chromium.open();
      const number = ++opened;

      yield* Effect.addFinalizer(() => Effect.sync(() => void closed.push(number)));

      return { browser, value: { number } };
    }),
  });

  return {
    sessions,
    url,
    walk,
    closed,
    submissions: () => submissions,
    hideReceipt: () => {
      visibleReceipt = false;
    },
  };
});

const claim = (url: string, durable: boolean) =>
  Plan.Plan.new([
    new Plan.Step({ action: "navigate", url, target: url }),
    new Plan.Step({
      action: "click",
      url,
      subject: button("Submit claim"),
      expect: {
        _tag: "Appeared",
        query: { role: "heading", name: "Saved claim RUN-1" },
        ...(durable ? { durable: true as const } : {}),
      },
    }),
  ]);

class StoreFailed extends Schema.TaggedError<StoreFailed>()("StoreFailed", {}) {}

// The port is external to the runner. Reopening reads a file, not the old runner's memory.
// This fixture simulates process loss after dispatch, not a filesystem's power-loss durability.
const journal = (path: string, failAfterSubmit = false): Workflow.Journal<StoreFailed> => {
  const save = (stopped: Plan.Stopped) =>
    Effect.sync(() => writeFileSync(path, JSON.stringify(stopped)));

  return {
    read: () =>
      Effect.sync(() => JSON.parse(readFileSync(path, "utf8"))).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Plan.Stopped)),
        Effect.orDie,
      ),
    begun: (_run, step) => save(new Plan.Stopped({ step, input: "unknown" })),
    done: (_run, receipt) =>
      receipt.step === 1 && failAfterSubmit
        ? Effect.fail(new StoreFailed())
        : save(new Plan.Stopped({ step: receipt.step + 1, input: "unsent" })),
  };
};

const journalFile = Effect.gen(function* () {
  const directory = mkdtempSync(join(tmpdir(), "browser-composition-"));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
  const path = join(directory, "run.json");

  writeFileSync(path, JSON.stringify(new Plan.Stopped({ step: 0, input: "unsent" })));

  return path;
});

describe("consumer compositions", () => {
  it.live(
    "keeps output through rotation, commits on an actual line and closes retired resources",
    () =>
      Effect.gen(function* () {
        const world = yield* fixture();
        const watched = yield* Watched.make(world.sessions);
        const first = yield* watched.prepare("first", world.walk);

        yield* watched.reveal(first, first.browser.now.pipe(Effect.asSome));
        yield* world.sessions.rotate;
        assert.isFalse(first.page.playwright.isClosed());
        assert.deepStrictEqual(world.closed, []);
        const next = yield* watched.prepare("next", world.walk);
        const sent = yield* Deferred.make<Option.Option<number>>();
        const waiting = yield* Effect.forkChild(watched.reveal(next, Deferred.await(sent)));

        yield* Effect.sleep("50 millis");
        assert.strictEqual(Option.getOrThrow(yield* watched.current).id, first.page.id);
        const sentAt = yield* next.browser.now;

        yield* Deferred.succeed(sent, Option.some(sentAt));
        const result = Option.getOrThrow(yield* Fiber.join(waiting));

        assert.isAtLeast(result.at, sentAt);
        assert.strictEqual(Option.getOrThrow(yield* watched.current).id, next.page.id);
        assert.isTrue(first.page.playwright.isClosed());
        yield* world.sessions.states.pipe(
          Stream.filter((event) => event.number === 1 && event.state._tag === "Closed"),
          Stream.runHead,
        );
        assert.deepStrictEqual(world.closed, [1]);
        assert.strictEqual(next.value.number, 2);
      }).pipe(Effect.scoped),
  );

  it.live("drops a cue without switching and stops the walk at a completed step boundary", () =>
    Effect.gen(function* () {
      const world = yield* fixture();
      const watched = yield* Watched.make(world.sessions);
      const first = yield* watched.prepare("first", world.walk);

      yield* watched.reveal(first, first.browser.now.pipe(Effect.asSome));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const dropped = yield* watched.prepare("dropped", world.walk);

          assert.isTrue(Option.isNone(yield* watched.reveal(dropped, Effect.succeedNone)));
          assert.strictEqual(Option.getOrThrow(yield* watched.current).id, first.page.id);
        }),
      );
      const stop = yield* Deferred.make<void>();

      const plan = Plan.Plan.new([
        new Plan.Step({ action: "click", url: world.url, subject: button("First") }),
        new Plan.Step({ action: "click", url: world.url, subject: button("Second") }),
      ]);

      yield* Effect.promise(() =>
        first.page.playwright.exposeFunction("stopAtBoundary", () =>
          Deferred.doneUnsafe(stop, Effect.void),
        ),
      );
      yield* Effect.promise(() =>
        first.page.playwright.evaluate(() => {
          document.getElementById("first")?.addEventListener("click", () => {
            const callback = Reflect.get(window, "stopAtBoundary");

            if (typeof callback === "function") void callback();
          });
        }),
      );
      const outcome = yield* watched.perform(first, plan, 0, stop, { settle: false });

      assert.deepStrictEqual(
        outcome.receipts.map((receipt) => receipt.step),
        [0],
      );
      assert.deepStrictEqual(
        Option.getOrThrow(outcome.stopped),
        new Plan.Stopped({ step: 1, input: "unsent" }),
      );
      assert.strictEqual(
        yield* Effect.promise(() => first.page.playwright.locator("output").textContent()),
        "first ",
      );
      yield* world.sessions.retire;
      assert.isTrue(first.page.playwright.isClosed());
      assert.isTrue(
        Exit.isFailure(
          yield* watched
            .perform(
              first,
              plan,
              Option.getOrThrow(outcome.stopped),
              yield* Deferred.make<void>(),
              {
                settle: false,
              },
            )
            .pipe(Effect.exit),
        ),
      );
    }).pipe(Effect.scoped),
  );

  for (const evidence of ["transient", "durable", "absent"] as const)
    it.live(`reopens a begun journal with ${evidence} evidence without resubmitting`, () =>
      Effect.gen(function* () {
        const world = yield* fixture();
        const path = yield* journalFile;
        const accepted = evidence === "durable";
        const plan = claim(world.url, evidence !== "transient");

        const failed = yield* Workflow.run(world.sessions, journal(path, true), "RUN-1", plan).pipe(
          Effect.flip,
        );

        assert.strictEqual(failed._tag, "StoreFailed");
        assert.strictEqual(world.submissions(), 1);
        yield* world.sessions.rotate;
        if (evidence === "absent") world.hideReceipt();

        const resumed = yield* Workflow.run(world.sessions, journal(path), "RUN-1", plan).pipe(
          Effect.result,
        );

        assert.strictEqual(resumed._tag, accepted ? "Success" : "Failure");
        assert.strictEqual(world.submissions(), 1);
        const checkpoint = yield* journal(path).read("RUN-1");

        assert.deepStrictEqual(
          checkpoint,
          new Plan.Stopped({ step: accepted ? 2 : 1, input: accepted ? "unsent" : "unknown" }),
        );
      }).pipe(Effect.scoped),
    );

  it.live("suspends automated input for an operator while reads and capture remain available", () =>
    Effect.gen(function* () {
      const world = yield* fixture(true);
      const path = yield* journalFile;
      let interventions = 0;

      yield* Workflow.run(world.sessions, journal(path), "RUN-1", claim(world.url, true), {
        operator: {
          needed: (page) =>
            page
              .find({ text: "Operator verification required" })
              .pipe(Effect.map((found) => found.length > 0)),
          resolve: (page) =>
            Effect.gen(function* () {
              interventions++;
              const refused = yield* page.press("Space").pipe(Effect.flip);

              assert.strictEqual(refused.reason._tag, "Suspended");
              assert.isFalse(refused.dispatched);
              assert.include((yield* page.text()).text, "Operator verification required");
              assert.isAbove((yield* page.screenshot()).data.length, 0);
              // A human/provider viewer is outside the library's automated-input gate.
              yield* Effect.promise(() =>
                page.playwright.getByRole("button", { name: "Verify operator" }).click(),
              );
              yield* Effect.promise(() =>
                page.playwright.getByRole("button", { name: "Submit claim" }).waitFor(),
              );
            }),
        },
      });
      assert.strictEqual(interventions, 1);
      assert.strictEqual(world.submissions(), 1);
      assert.strictEqual((yield* journal(path).read("RUN-1")).step, 2);
    }).pipe(Effect.scoped),
  );
});
