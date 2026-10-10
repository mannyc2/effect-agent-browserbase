// The accepted generic API plan requests regression-first dispatch and restart proofs here.
// Unresolved input must not be repeated because an effect is absent or only briefly visible.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Deferred, Duration, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Browser } from "../src/Browser.ts";
import { BrowserError, Timeout } from "../src/BrowserError.ts";
import { Subject } from "../src/BrowserEvent.ts";
import * as Chromium from "../src/Chromium.ts";
import { Found, type Page, ResolvedTarget, State } from "../src/Page.ts";
import * as Plan from "../src/Plan.ts";

const subject = new Subject({ role: "button", name: "Target", tag: "button", context: {} });

/** Only the public Page methods Plan consumes; no browser internals or Expect substitute. */
const scripted = (check: "present" | "absent" | "failed" = "absent") => {
  const dispatches: Array<string> = [];
  const dispatch = (action: string) => Effect.sync(() => void dispatches.push(action));
  const url = "https://workflow.test/run";

  const found = new Found({
    ref: "e1",
    subject,
    box: { x: 0, y: 0, width: 20, height: 20 },
    inViewport: true,
    state: { disabled: false, focused: false, checked: check === "present" },
  });

  const methods = {
    url: Effect.succeed(url),
    state: Effect.succeed(new State({ page: "scripted", at: 0, url, document: 1 })),
    ready: () => Effect.void,
    find: (query = {}) =>
      query.text === "Done"
        ? check === "failed"
          ? Effect.fail(
              new BrowserError({
                operation: "find",
                reason: new Timeout({ millis: 1 }),
                dispatched: false,
              }),
            )
          : Effect.succeed(check === "present" ? [found] : [])
        : Effect.succeed([found]),
    goto: () => dispatch("navigate"),
    back: dispatch("back"),
    reload: dispatch("reload"),
    click: () =>
      dispatch("click").pipe(
        Effect.as(
          new ResolvedTarget({
            point: { x: 10, y: 10 },
            element: "button",
            tag: "button",
            role: "button",
            name: "Target",
            context: {},
            cursor: "pointer",
          }),
        ),
      ),
    hover: () => dispatch("hover"),
    drag: () => dispatch("drag"),
    type: () => dispatch("type"),
    press: () => dispatch("press"),
    scroll: () => dispatch("scroll"),
    select: () => dispatch("select").pipe(Effect.as("chosen")),
  } satisfies Pick<
    Page,
    | "url"
    | "state"
    | "ready"
    | "find"
    | "goto"
    | "back"
    | "reload"
    | "click"
    | "hover"
    | "drag"
    | "type"
    | "press"
    | "scroll"
    | "select"
  >;

  // This boundary double deliberately implements only Plan's public operations.
  return { page: methods as unknown as Page, dispatches };
};

describe("Plan step safety", () => {
  it.effect("refuses to repeat a click whose dispatch is unknown", () =>
    Effect.gen(function* () {
      const { page, dispatches } = scripted();

      const plan = new Plan.Plan({
        version: 1,
        steps: [new Plan.Step({ action: "click", subject, url: "" })],
      });

      const result = yield* Plan.replay(page, plan, {
        settle: false,
        from: { step: 0, input: "unknown" },
      }).pipe(Effect.exit);

      assert.deepStrictEqual(dispatches, []);
      assert.isTrue(Exit.isFailure(result));
    }),
  );

  it.effect("does not move an unresolved stopping point past a later missing input", () =>
    Effect.gen(function* () {
      const { page, dispatches } = scripted();

      const plan = Plan.Plan.new([
        new Plan.Step({ action: "click", subject, url: "" }),
        new Plan.Step({ action: "type", subject, input: "text", url: "" }),
      ]);

      const error = yield* Plan.replay(page, plan, {
        from: new Plan.Stopped({ step: 0, input: "unknown" }),
        settle: false,
      }).pipe(Effect.flip);

      assert.deepStrictEqual([error.stopped.step, error.stopped.input], [0, "unknown"]);

      const retried = yield* Plan.replay(page, plan, {
        from: error.stopped,
        inputs: { text: "memo" },
        settle: false,
      }).pipe(Effect.flip);

      assert.strictEqual(retried.reason._tag, "Uncertain");
      assert.deepStrictEqual(dispatches, []);
    }),
  );

  it.effect("resumes from the run start after a missing input preflight", () =>
    Effect.gen(function* () {
      const { page, dispatches } = scripted();

      const plan = Plan.Plan.new([
        new Plan.Step({ action: "navigate", target: "https://workflow.test/run", url: "" }),
        new Plan.Step({ action: "type", subject, input: "text", url: "" }),
      ]);

      const error = yield* Plan.replay(page, plan, { settle: false }).pipe(Effect.flip);

      assert.deepStrictEqual(dispatches, []);
      assert.deepStrictEqual(error.receipts, []);

      const receipts = yield* Plan.replay(page, plan, {
        from: error.stopped,
        inputs: { text: "memo" },
        settle: false,
      });

      assert.deepStrictEqual(dispatches, ["navigate", "type"]);
      assert.deepStrictEqual(
        receipts.map(({ step }) => step),
        [0, 1],
      );
    }),
  );

  it.effect.prop(
    "never dispatches an unresolved consequential step, regardless of check evidence",
    {
      action: Arbitrary.schema(
        Schema.Literals(["click", "press", "drag", "back", "reload", "type"]),
      ),
      check: Arbitrary.schema(Schema.Literals(["present", "absent", "failed"])),
      expectation: Arbitrary.schema(Schema.Literals(["none", "transient", "durable"])),
      input: Arbitrary.schema(Schema.Literals(["unsent", "unknown"])),
    },
    ({ action, check, expectation, input }) =>
      Effect.gen(function* () {
        const { page, dispatches } = scripted(check);

        const expect =
          expectation === "none"
            ? undefined
            : {
                _tag: "Appeared" as const,
                query: { text: "Done" },
                ...(expectation === "durable" ? { durable: true as const } : {}),
              };

        const step = new Plan.Step({
          action,
          subject,
          to: subject,
          target: "Enter",
          url: "",
          input: action === "type" ? "text" : undefined,
          options: action === "type" ? { replace: false } : undefined,
          expect,
        });

        const plan = new Plan.Plan({ version: expect === undefined ? 1 : 2, steps: [step] });

        const result = yield* Plan.replay(page, plan, {
          from: { step: 0, input },
          settle: false,
          arrival: 0,
          inputs: { text: "memo" },
        }).pipe(Effect.exit);

        if (input === "unknown") {
          assert.deepStrictEqual(dispatches, []);
          assert.strictEqual(
            Exit.isSuccess(result),
            expectation === "durable" && check === "present",
          );
        } else {
          assert.strictEqual(
            dispatches.length,
            expectation === "none" || check === "absent" ? 1 : 0,
          );
        }
      }),
    { arbitrary: { runs: 180 } },
  );

  it.effect("resumes only the repeatable actions whose input was unknown", () =>
    Effect.gen(function* () {
      const cases = [
        new Plan.Step({ action: "navigate", target: "https://workflow.test/run", url: "" }),
        new Plan.Step({ action: "hover", subject, url: "" }),
        new Plan.Step({ action: "scroll", url: "" }),
        new Plan.Step({ action: "select", subject, options: { values: ["chosen"] }, url: "" }),
        new Plan.Step({ action: "type", subject, input: "text", url: "" }),
      ];

      for (const step of cases) {
        const { page, dispatches } = scripted();
        const plan = new Plan.Plan({ version: 1, steps: [step] });

        const receipts = yield* Plan.replay(page, plan, {
          from: { step: 0, input: "unknown" },
          settle: false,
          inputs: { text: "memo" },
        });

        assert.isTrue(Plan.repeatable(step));
        assert.deepStrictEqual(dispatches, [step.action]);
        assert.strictEqual(receipts[0]?.outcome, "taken");
      }
      assert.isFalse(Plan.repeatable(new Plan.Step({ action: "type", input: "text", url: "" })));
      assert.isFalse(
        Plan.repeatable(
          new Plan.Step({ action: "type", subject, options: { submit: true }, url: "" }),
        ),
      );
    }),
  );

  it.effect(
    "refuses a Checked expectation on a target with no checked state before any input",
    () =>
      Effect.gen(function* () {
        const { page, dispatches } = scripted();

        const button: Page = {
          ...page,
          find: (query) =>
            page
              .find(query)
              .pipe(
                Effect.map((found) =>
                  found.map(
                    (target) =>
                      new Found({ ...target, state: { disabled: false, focused: false } }),
                  ),
                ),
              ),
        };

        const plan = Plan.Plan.new([
          new Plan.Step({
            action: "click",
            subject,
            url: "",
            expect: { _tag: "Checked", checked: false },
          }),
        ]);

        for (const at of [0, new Plan.Stopped({ step: 0, input: "unknown" })]) {
          const error = yield* Plan.take(button, plan, at, { settle: false, arrival: 0 }).pipe(
            Effect.flip,
          );

          assert.deepStrictEqual(dispatches, []);
          assert.strictEqual(error.reason._tag, "BrowserError");
          if (error.reason._tag === "BrowserError")
            assert.strictEqual(error.reason.reason._tag, "InvalidRequest");
          assert.strictEqual(error.input, typeof at === "number" ? "unsent" : "unknown");
        }
      }),
  );

  it.effect("bounds effect reads before dispatch, after dispatch, and during recovery", () =>
    Effect.gen(function* () {
      for (const phase of ["after", "before", "recovery"] as const) {
        const { page, dispatches } = scripted();
        let checks = 0;

        const slow: Page = {
          ...page,
          find: (query) =>
            Effect.suspend(() =>
              query?.text === "Done" && ++checks > (phase === "after" ? 1 : 0)
                ? Effect.sleep("1 hour").pipe(Effect.andThen(page.find(query)))
                : page.find(query),
            ),
        };

        const plan = Plan.Plan.new([
          new Plan.Step({
            action: "click",
            subject,
            url: "",
            expect: { _tag: "Appeared", query: { text: "Done" }, durable: true },
          }),
        ]);

        const taking = yield* Effect.forkChild(
          Plan.take(
            slow,
            plan,
            phase === "recovery" ? new Plan.Stopped({ step: 0, input: "unknown" }) : 0,
            { settle: false, arrival: "50 millis" },
          ).pipe(Effect.flip),
        );

        yield* TestClock.adjust("100 millis");
        assert.isDefined(taking.pollUnsafe(), `${phase}: a check must not outlive its deadline`);
        const error = yield* Fiber.join(taking);

        assert.deepStrictEqual(
          [error.reason._tag, error.input, dispatches],
          [
            phase === "recovery" ? "Uncertain" : "Drifted",
            phase === "before" ? "unsent" : "unknown",
            phase === "after" ? ["click"] : [],
          ],
        );
      }
    }),
  );
});

/** An operation record belongs to the server and survives a replacement browser page. */
const workflow = Effect.fnUntraced(function* () {
  let orders = 0;
  const ordered = yield* Deferred.make<void>();

  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((request, response) => {
        const address = new URL(request.url ?? "/", "http://workflow.test");

        response.setHeader("content-type", "text/html; charset=utf-8");
        if (address.pathname === "/order") {
          orders += 1;
          Deferred.doneUnsafe(ordered, Effect.void);
          response.end(String(orders));

          return;
        }
        if (address.pathname === "/done") {
          response.end("<h1>Arrived</h1>");

          return;
        }
        response.end(`<h1>Workflow</h1>
          <label><input type="checkbox" checked onchange="document.body.dataset.toggles = String(Number(document.body.dataset.toggles || 0) + 1)">Enabled</label>
          <button id="order" onclick="fetch('/order', {method:'POST'}).then(r => r.text()).then(n => { record.textContent = 'Order '+n; notice.textContent = 'Submitted' })">Place order</button>
          <button onmousedown="fetch('/order', {method:'POST'})">Commit on press</button>
          <button disabled>Unavailable</button><p role="status" id="record">${orders === 0 ? "" : `Order ${orders}`}</p>
          <p role="alert" id="notice"></p>
          <button onclick="setTimeout(() => location.href = 'http://localhost:'+location.port+'/done', ${Number(address.searchParams.get("delay") ?? 200)})">Continue</button>`);
      });

      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    orders: Effect.sync(() => orders),
    ordered: Deferred.await(ordered),
  };
});

const open = Effect.fnUntraced(function* (url: string) {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(url), (page) => Effect.ignore(page.close));
});

const named = (name: string, role = "button") =>
  new Subject({ role, name, tag: role === "checkbox" ? "input" : "button", context: {} });

/** The native click runs; its public operation then loses the acknowledgement. */
const losesReply = (page: Page): Page => ({
  ...page,
  click: (target, options) =>
    page.click(target, options).pipe(
      Effect.andThen(
        Effect.fail(
          new BrowserError({
            operation: "click",
            reason: new Timeout({ millis: 1 }),
            dispatched: true,
          }),
        ),
      ),
    ),
});

const orderPlan = (durable: boolean) =>
  new Plan.Plan({
    version: 2,
    steps: [
      new Plan.Step({
        action: "click",
        subject: named("Place order"),
        url: "",
        expect: {
          _tag: "Appeared",
          query: { role: durable ? "status" : "alert", text: durable ? "Order 1" : "Submitted" },
          ...(durable ? { durable: true } : {}),
        },
      }),
    ],
  });

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Plan steps in Chromium",
  (it) => {
    it.effect(
      "skips a checked target instead of toggling it, and stamps the receipt on the browser clock",
      () =>
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);
          const browser = yield* Browser;
          const before = yield* browser.now;

          const plan = new Plan.Plan({
            version: 2,
            steps: [
              new Plan.Step({
                action: "click",
                subject: named("Enabled", "checkbox"),
                url: site.url,
                expect: { _tag: "Checked", checked: true },
              }),
            ],
          });

          const receipt = yield* Plan.take(page, plan, 0);

          assert.strictEqual(receipt.outcome, "skipped");
          assert.isAtLeast(receipt.startedAt, before);
          assert.isAtLeast(receipt.at, receipt.startedAt);
          assert.isAtMost(receipt.at, yield* browser.now);
          assert.isTrue(
            yield* Effect.promise(() => page.playwright.getByLabel("Enabled").isChecked()),
          );
          assert.isUndefined(
            yield* Effect.promise(() =>
              page.playwright.evaluate(() => document.body.dataset["toggles"]),
            ),
          );

          const unchecked = new Plan.Plan({
            version: 2,
            steps: [
              new Plan.Step({
                action: "click",
                subject: named("Enabled", "checkbox"),
                url: site.url,
                expect: { _tag: "Checked", checked: false },
              }),
            ],
          });

          const from = new Plan.Stopped({ step: 0, input: "unknown" });

          assert.strictEqual((yield* Plan.take(page, unchecked, from)).outcome, "verified");
          assert.strictEqual((yield* Plan.take(page, unchecked, from)).outcome, "skipped");
          assert.strictEqual(
            yield* Effect.promise(() =>
              page.playwright.evaluate(() => document.body.dataset["toggles"]),
            ),
            "1",
          );
        }),
    );

    it.effect(
      "verifies a lost reply against durable read-back and restores on a fresh page without ordering twice",
      () =>
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);
          const plan = orderPlan(true);
          const receipt = yield* Plan.take(losesReply(page), plan, 0, { arrival: "1 second" });

          assert.strictEqual(receipt.outcome, "verified");
          assert.strictEqual(yield* site.orders, 1);

          const replacement = yield* open(site.url);
          const restored = yield* Plan.restore(replacement, plan, { upTo: 1 });

          assert.deepStrictEqual(
            restored.map(({ outcome }) => outcome),
            ["skipped"],
          );

          const resumed = yield* Plan.replay(replacement, plan, {
            from: new Plan.Stopped({ step: 0, input: "unknown" }),
          });

          assert.deepStrictEqual(
            resumed.map(({ outcome }) => outcome),
            ["skipped"],
          );
          assert.strictEqual(yield* site.orders, 1);
        }),
    );

    it.effect(
      "does not treat a transient success notice as permission to continue after a lost reply",
      () =>
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);
          const plan = orderPlan(false);

          const error = yield* Effect.flip(
            Plan.take(losesReply(page), plan, 0, { arrival: "1 second" }),
          );

          assert.strictEqual(error.input, "unknown");
          yield* site.ordered;
          assert.strictEqual(yield* site.orders, 1);
          yield* Effect.promise(() =>
            page.playwright.getByRole("alert").waitFor({ state: "visible" }),
          );
          const visible = yield* Effect.flip(Plan.replay(page, plan, { from: error.stopped }));

          assert.strictEqual(visible.reason._tag, "Uncertain");

          const stopped = yield* Schema.decodeUnknownEffect(Plan.Stopped)(
            JSON.parse(JSON.stringify(error.stopped)),
          );

          const replacement = yield* open(site.url);
          const absent = yield* Effect.flip(Plan.replay(replacement, plan, { from: stopped }));
          const restore = yield* Effect.flip(Plan.restore(replacement, plan, { upTo: 1 }));

          assert.strictEqual(absent.reason._tag, "Uncertain");
          assert.strictEqual(restore.reason._tag, "Uncertain");
          assert.strictEqual(yield* site.orders, 1);
        }),
    );

    it.effect(
      "records completed receipts and an unsent stopping point when the next input is refused",
      () =>
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);

          const plan = new Plan.Plan({
            version: 1,
            steps: [
              new Plan.Step({ action: "hover", subject: named("Place order"), url: site.url }),
              new Plan.Step({ action: "click", subject: named("Unavailable"), url: site.url }),
            ],
          });

          const error = yield* Effect.flip(Plan.replay(page, plan));

          assert.deepStrictEqual(
            [error.step, error.input, error.stopped.step, error.stopped.input],
            [1, "unsent", 1, "unsent"],
          );
          assert.deepStrictEqual(
            error.receipts.map(({ step, outcome }) => [step, outcome]),
            [[0, "taken"]],
          );
          assert.strictEqual(yield* site.orders, 0);
        }),
    );

    it.effect(
      "preserves dispatched Action evidence on cancellation and refuses its journaled unknown restart",
      () =>
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);

          const plan = new Plan.Plan({
            version: 1,
            steps: [
              new Plan.Step({
                action: "click",
                subject: named("Commit on press"),
                options: { holdMillis: 60_000 },
                url: site.url,
              }),
            ],
          });

          const taking = yield* Effect.forkChild(Plan.take(page, plan, 0));

          yield* site.ordered;
          yield* Fiber.interrupt(taking);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(taking)));

          const action = (yield* page.recentEvents).findLast(
            (event) => event._tag === "Action" && event.name === "click",
          );

          assert.deepStrictEqual(
            action?._tag === "Action" && [action.dispatched, action.ok, action.error],
            [true, false, "interrupted"],
          );

          const error = yield* Effect.flip(
            Plan.replay(page, plan, {
              from: new Plan.Stopped({ step: 0, input: "unknown" }),
            }),
          );

          assert.strictEqual(error.reason._tag, "Uncertain");
          assert.strictEqual(yield* site.orders, 1);
        }),
    );

    it.effect(
      "does not bypass recorded arrival when an effect already holds or reconciles a lost reply",
      () =>
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);
          const elsewhere = site.url.replace("127.0.0.1", "localhost") + "/done";

          const checked = Plan.Plan.new([
            new Plan.Step({
              action: "click",
              subject: named("Enabled", "checkbox"),
              url: elsewhere,
              expect: { _tag: "Checked", checked: true },
            }),
          ]);

          const order = Plan.Plan.new(
            orderPlan(true).steps.map((step) => new Plan.Step({ ...step, url: elsewhere })),
          );

          const skipped = yield* Plan.take(page, checked, 0, { arrival: "10 millis" }).pipe(
            Effect.exit,
          );

          const verified = yield* Plan.take(losesReply(page), order, 0, {
            arrival: "100 millis",
          }).pipe(Effect.exit);

          assert.isTrue(
            Exit.isFailure(skipped),
            "a preexisting effect cannot bypass recorded arrival",
          );
          assert.isTrue(
            Exit.isFailure(verified),
            "durable read-back cannot bypass recorded arrival",
          );
          assert.strictEqual(yield* site.orders, 1);
        }),
    );

    it.effect("waits for a delayed cross-site arrival and refuses one outside its bound", () =>
      Effect.gen(function* () {
        const site = yield* workflow();
        const expected = site.url.replace("127.0.0.1", "localhost") + "/done";

        const plan = new Plan.Plan({
          version: 1,
          steps: [new Plan.Step({ action: "click", subject: named("Continue"), url: expected })],
        });

        const timely = yield* open(site.url + "?delay=200");

        assert.strictEqual(
          (yield* Plan.take(timely, plan, 0, { settle: false, arrival: "2 seconds" })).outcome,
          "taken",
        );
        assert.strictEqual(yield* timely.url, expected);

        const late = yield* open(site.url + "?delay=60000");

        const error = yield* Effect.flip(
          Plan.take(late, plan, 0, { settle: false, arrival: "100 millis" }),
        );

        assert.deepStrictEqual([error.reason._tag, error.input], ["Drifted", "unknown"]);
        assert.notStrictEqual(yield* late.url, expected);
      }),
    );

    it.effect("retains a delayed recorded navigation before resuming the following step", () =>
      Effect.gen(function* () {
        const site = yield* workflow();
        const expected = site.url.replace("127.0.0.1", "localhost") + "/done";
        const recording = yield* open(site.url + "?delay=200");
        const [continued] = yield* recording.find({ role: "button", name: "Continue" });

        if (continued === undefined) return yield* Effect.die("missing Continue fixture");
        yield* recording.click(continued.ref);
        yield* Effect.promise(() => recording.playwright.waitForURL(expected));
        yield* recording.press("Shift");
        const plan = Plan.fromEvents(yield* recording.recentEvents);
        const following = plan.steps.findIndex((step) => step.action === "press");
        const replacement = yield* open(expected);

        const receipt = yield* Plan.take(replacement, plan, following, {
          settle: false,
          arrival: "100 millis",
        });

        assert.strictEqual(receipt.outcome, "taken");
        assert.strictEqual(plan.steps[following - 1]?.url, expected);
      }),
    );
  },
);
