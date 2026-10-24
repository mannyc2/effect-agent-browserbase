// The accepted generic API plan requests regression-first dispatch and restart proofs here.
// Unresolved input must not be repeated because an effect is absent or only briefly visible.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Clock, Deferred, Duration, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

import { nameOf } from "../src/Action.ts";
import { Browser } from "../src/Browser.ts";
import { BrowserError, Timeout } from "../src/BrowserError.ts";
import { Subject } from "../src/BrowserEvent.ts";
import { Found, type Page as PublicPage, State } from "../src/Page.ts";
import * as Plan from "../src/plan/index.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestPage from "../src/testing/TestPage.ts";
import * as TestCdp from "./support/TestCdp.ts";

type Page = PublicPage;

const subject = new Subject({ role: "button", name: "Target", tag: "button", context: {} });

/** A mid-story seed with explicit action outcomes; no partial Page or browser-shaped cast. */
const scripted = Effect.fnUntraced(function* (
  check: "present" | "absent" | "failed" | "blank" | "error" | "unrendered" = "absent",
) {
  const url =
    check === "blank"
      ? "about:blank"
      : `https://workflow.test/${check === "error" ? "error" : "run"}`;

  const element = {
    key: "target",
    subject,
    text: "Target",
    editable: true,
    state: { checked: check === "present" },
    box: { x: 0, y: 0, width: 20, height: 20 },
  };

  const test = yield* TestPage.make({
    url,
    ready: true,
    elements: [
      element,
      ...(check === "present"
        ? [
            {
              ...element,
              key: "done",
              subject: new Subject({ ...subject, name: "Done" }),
              text: "Done",
            },
          ]
        : []),
    ],
  });

  for (let index = 0; index < 8; index++) yield* test.succeedNext("chosen");

  const page: Page = {
    ...test.page,
    until: (query, want, millis) =>
      check === "failed"
        ? Effect.fail(
            new BrowserError({
              operation: "until",
              reason: new Timeout({ millis: 1 }),
              dispatched: false,
            }),
          )
        : test.page.until(query, want, millis),
  };

  return {
    page,
    dispatches: Effect.map(test.actions, (actions) => actions.map(nameOf)),
  };
});

describe("Plan step safety", () => {
  it.effect("refuses to repeat a click whose dispatch is unknown", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { page, dispatches } = yield* scripted();

        const plan = new Plan.Plan({
          version: 3,
          steps: [new Plan.Step({ action: { _tag: "Click", target: "e0" }, subject, url: "" })],
        });

        const result = yield* Plan.replay(page, plan, {
          settle: false,
          from: { step: 0, input: "unknown" },
        }).pipe(Effect.exit);

        assert.deepStrictEqual(yield* dispatches, []);
        assert.isTrue(Exit.isFailure(result));
      }),
    ),
  );

  it.effect("does not move an unresolved stopping point past a later missing input", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { page, dispatches } = yield* scripted();

        const plan = Plan.Plan.new([
          new Plan.Step({ action: { _tag: "Click", target: "e0" }, subject, url: "" }),
          new Plan.Step({ action: { _tag: "Type", text: "" }, subject, input: "text", url: "" }),
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
        assert.deepStrictEqual(yield* dispatches, []);
      }),
    ),
  );

  it.effect("resumes from the run start after a missing input preflight", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { page, dispatches } = yield* scripted();

        const plan = Plan.Plan.new([
          new Plan.Step({ action: { _tag: "Goto", url: "https://workflow.test/run" }, url: "" }),
          new Plan.Step({ action: { _tag: "Type", text: "" }, subject, input: "text", url: "" }),
        ]);

        const error = yield* Plan.replay(page, plan, { settle: false }).pipe(Effect.flip);

        assert.deepStrictEqual(yield* dispatches, []);
        assert.deepStrictEqual(error.receipts, []);

        const receipts = yield* Plan.replay(page, plan, {
          from: error.stopped,
          inputs: { text: "memo" },
          settle: false,
        });

        assert.deepStrictEqual(yield* dispatches, ["navigate", "type"]);
        assert.deepStrictEqual(
          receipts.map(({ step }) => step),
          [0, 1],
        );
      }),
    ),
  );

  it.effect.prop(
    "never dispatches an unresolved consequential step, regardless of check evidence",
    {
      action: Arbitrary.schema(
        Schema.Literals(["click", "press", "drag", "back", "reload", "type"]),
      ),
      check: Arbitrary.schema(
        Schema.Literals(["present", "absent", "failed", "blank", "error", "unrendered"]),
      ),
      expectation: Arbitrary.schema(
        Schema.Literals(["none", "transient", "durable", "gone", "relative", "exact"]),
      ),
      input: Arbitrary.schema(Schema.Literals(["unsent", "unknown"])),
      entry: Arbitrary.schema(Schema.Literals(["take", "replay", "restore"])),
    },
    ({ action, check, expectation, input, entry }) =>
      Effect.gen(function* () {
        const { page, dispatches } = yield* scripted(check);
        let document = 1;

        const changing: Page = {
          ...page,
          state: Effect.map(page.state, (state) => new State({ ...state, document: document++ })),
        };

        const prohibited = expectation === "gone" || expectation === "relative";
        const unknown = input === "unknown" || prohibited || entry === "restore";

        const expect =
          expectation === "none"
            ? undefined
            : expectation === "relative" || expectation === "exact"
              ? {
                  _tag: "Navigated" as const,
                  ...(expectation === "exact"
                    ? {
                        url:
                          check === "present"
                            ? "https://workflow.test/run"
                            : "https://workflow.test/receipt/42",
                      }
                    : {}),
                  durable: true as const,
                }
              : {
                  _tag: expectation === "gone" ? ("Gone" as const) : ("Appeared" as const),
                  query: { text: "Done" },
                  ...(expectation === "durable" || expectation === "gone"
                    ? { durable: true as const }
                    : {}),
                };

        // Deliberately bypass constructors: persisted or constructed malformed objects must not
        // turn negative or relative evidence into a receipt (beta.11 review, user-requested R1).
        const step = {
          action:
            action === "click"
              ? { _tag: "Click", target: "e0" }
              : action === "drag"
                ? { _tag: "Drag", from: "e0", to: "e0" }
                : action === "press"
                  ? { _tag: "Press", keys: "Enter" }
                  : action === "type"
                    ? { _tag: "Type", text: "", options: { replace: false } }
                    : { _tag: action === "back" ? "Back" : "Reload" },
          subject,
          to: subject,
          url: "",
          input: action === "type" ? "text" : undefined,
          expect,
        };

        const payload = { version: 3, steps: [step] };
        const plan = payload as unknown as Plan.Plan;
        const from = new Plan.Stopped({ step: 0, input: unknown ? "unknown" : "unsent" });
        const options = { arrival: 0, inputs: { text: "memo" } };

        const result = yield* (
          entry === "take"
            ? Plan.take(changing, plan, from, options).pipe(Effect.map((receipt) => [receipt]))
            : entry === "restore"
              ? Plan.restore(changing, plan, options)
              : Plan.replay(changing, plan, { ...options, from })
        ).pipe(Effect.exit);

        if (unknown) {
          assert.deepStrictEqual(yield* dispatches, []);
          assert.strictEqual(
            Exit.isSuccess(result),
            (expectation === "durable" || expectation === "exact") && check === "present",
          );
          if (Exit.isFailure(result)) {
            const error = Exit.findErrorOption(result);

            assert.isTrue(error._tag === "Some" && error.value.reason._tag === "Uncertain");
            if (error._tag === "Some") assert.deepStrictEqual(error.value.receipts, []);
          }
        } else {
          assert.strictEqual(
            (yield* dispatches).length,
            expectation === "none" ||
              (expectation === "exact"
                ? check !== "present"
                : check !== "present" && check !== "failed")
              ? 1
              : 0,
          );
        }
        const decoded = Schema.decodeUnknownExit(Plan.Plan)(payload);

        if (prohibited) assert.isTrue(Exit.isFailure(decoded));
        else {
          assert.isTrue(Exit.isSuccess(decoded));
          if (Exit.isSuccess(decoded))
            assert.deepStrictEqual(
              yield* Schema.decodeEffect(Plan.Plan)(
                yield* Schema.encodeEffect(Plan.Plan)(decoded.value),
              ),
              decoded.value,
            );
        }
      }),
    { arbitrary: { runs: 180 } },
  );

  it.effect("refuses malformed durable absence and relative navigation before any input", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        for (const expect of [
          { _tag: "Gone", query: { text: "Done" }, durable: true },
          { _tag: "Navigated", durable: true },
        ]) {
          const payload = {
            version: 3,
            steps: [{ action: { _tag: "Click", target: "e0" }, subject, url: "", expect }],
          };

          const plan = payload as unknown as Plan.Plan;
          const { page, dispatches } = yield* scripted("blank");

          for (const at of [new Plan.Stopped({ step: 0, input: "unknown" }), 0]) {
            const result = yield* Plan.take(page, plan, at, { settle: false, arrival: 0 }).pipe(
              Effect.exit,
            );

            assert.deepStrictEqual(yield* dispatches, []);
            assert.isTrue(Exit.isFailure(result));
            if (Exit.isFailure(result)) {
              const error = Exit.findErrorOption(result);

              assert.isTrue(error._tag === "Some" && error.value.reason._tag === "Uncertain");
              if (error._tag === "Some") assert.deepStrictEqual(error.value.receipts, []);
            }
          }
          for (const onExcessProperty of ["ignore", "error"] as const)
            assert.isTrue(
              Exit.isFailure(Schema.decodeUnknownExit(Plan.Plan, { onExcessProperty })(payload)),
            );
        }
      }),
    ),
  );

  it.effect("resumes only the repeatable actions whose input was unknown", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const cases = [
          new Plan.Step({ action: { _tag: "Goto", url: "https://workflow.test/run" }, url: "" }),
          new Plan.Step({ action: { _tag: "Hover", target: "e0" }, subject, url: "" }),
          new Plan.Step({ action: { _tag: "Scroll" }, url: "" }),
          new Plan.Step({
            action: { _tag: "Select", ref: "e0", values: ["chosen"] },
            subject,
            url: "",
          }),
          new Plan.Step({ action: { _tag: "Type", text: "" }, subject, input: "text", url: "" }),
        ];

        for (const step of cases) {
          const { page, dispatches } = yield* scripted();
          const plan = new Plan.Plan({ version: 3, steps: [step] });

          const receipts = yield* Plan.replay(page, plan, {
            from: { step: 0, input: "unknown" },
            settle: false,
            inputs: { text: "memo" },
          });

          assert.isTrue(Plan.repeatable(step));
          assert.deepStrictEqual(yield* dispatches, [
            step.action._tag === "Goto" ? "navigate" : step.action._tag.toLowerCase(),
          ]);
          assert.strictEqual(receipts[0]?.outcome, "taken");
        }
        assert.isFalse(
          Plan.repeatable(
            new Plan.Step({ action: { _tag: "Type", text: "" }, input: "text", url: "" }),
          ),
        );
        assert.isFalse(
          Plan.repeatable(
            new Plan.Step({
              action: { _tag: "Type", text: "", options: { submit: true } },
              subject,
              url: "",
            }),
          ),
        );
      }),
    ),
  );

  it.effect(
    "refuses a Checked expectation on a target with no checked state before any input",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const { page, dispatches } = yield* scripted();

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
              action: { _tag: "Click", target: "e0" },
              subject,
              url: "",
              expect: { _tag: "Checked", checked: false },
            }),
          ]);

          for (const at of [0, new Plan.Stopped({ step: 0, input: "unknown" })]) {
            const error = yield* Plan.take(button, plan, at, { settle: false, arrival: 0 }).pipe(
              Effect.flip,
            );

            assert.deepStrictEqual(yield* dispatches, []);
            assert.strictEqual(error.reason._tag, "BrowserError");
            if (error.reason._tag === "BrowserError")
              assert.strictEqual(error.reason.reason._tag, "InvalidRequest");
            assert.strictEqual(error.input, typeof at === "number" ? "unsent" : "unknown");
          }
        }),
      ),
  );

  it.effect("bounds effect reads before dispatch, after dispatch, and during recovery", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        for (const phase of ["after", "before", "recovery"] as const) {
          const { page, dispatches } = yield* scripted();
          let checks = 0;

          const slow: Page = {
            ...page,
            until: (query, want, millis) =>
              Effect.suspend(() =>
                ++checks > (phase === "after" ? 1 : 0)
                  ? Effect.sleep("1 hour").pipe(Effect.andThen(page.until(query, want, millis)))
                  : page.until(query, want, millis),
              ),
          };

          const plan = Plan.Plan.new([
            new Plan.Step({
              action: { _tag: "Click", target: "e0" },
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
            [error.reason._tag, error.input, yield* dispatches],
            [
              phase === "recovery" ? "Uncertain" : "Drifted",
              phase === "before" ? "unsent" : "unknown",
              phase === "after" ? ["click"] : [],
            ],
          );
        }
      }),
    ),
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
        if (address.pathname === "/receipt/1") {
          response.end(orders > 0 ? "<h1>Saved order 1</h1>" : "<h1>No saved order</h1>");

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
  perform: (action) =>
    page.perform(action).pipe(
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
    version: 3,
    steps: [
      new Plan.Step({
        action: { _tag: "Click", target: "e0" },
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

layer(TestCdp.provideLayer(Chromium.layer()), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Plan steps in Chromium", (it) => {
  it.effect("recovers an exact operation URL without more input", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const site = yield* workflow();
        const page = yield* open(site.url);

        yield* Plan.take(page, orderPlan(true), 0);
        const receiptUrl = site.url + "/receipt/1";

        yield* page.goto(receiptUrl);

        const exact = Plan.Plan.new([
          new Plan.Step({
            action: { _tag: "Click", target: "e0" },
            subject: named("Place order"),
            url: "",
            expect: { _tag: "Navigated", url: receiptUrl, durable: true },
          }),
        ]);

        const saved = yield* Schema.decodeEffect(Plan.Plan)(
          yield* Schema.encodeEffect(Plan.Plan)(exact),
        );

        assert.strictEqual(
          (yield* Plan.take(page, saved, 0, { settle: false })).outcome,
          "skipped",
        );
        const replacement = yield* open(receiptUrl);
        const options = { settle: false, arrival: "100 millis" } satisfies Plan.TakeOptions;
        const stopped = new Plan.Stopped({ step: 0, input: "unknown" });

        assert.strictEqual(
          (yield* Plan.take(replacement, saved, stopped, options)).outcome,
          "skipped",
        );
        assert.strictEqual(
          (yield* Plan.restore(replacement, saved, options))[0]?.outcome,
          "skipped",
        );
        assert.strictEqual(
          (yield* Plan.replay(replacement, saved, { ...options, from: stopped }))[0]?.outcome,
          "skipped",
        );
        assert.strictEqual(yield* site.orders, 1);
      }),
    ),
  );

  it.effect(
    "skips a checked target instead of toggling it, and stamps the receipt on the browser clock",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);
          const browser = yield* Browser;
          const before = yield* browser.now;

          const plan = new Plan.Plan({
            version: 3,
            steps: [
              new Plan.Step({
                action: { _tag: "Click", target: "e0" },
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
            yield* Effect.promise(() => TestCdp.nativePage(page).getByLabel("Enabled").isChecked()),
          );
          assert.isUndefined(
            yield* Effect.promise(() =>
              TestCdp.nativePage(page).evaluate(() => document.body.dataset["toggles"]),
            ),
          );

          const unchecked = new Plan.Plan({
            version: 3,
            steps: [
              new Plan.Step({
                action: { _tag: "Click", target: "e0" },
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
              TestCdp.nativePage(page).evaluate(() => document.body.dataset["toggles"]),
            ),
            "1",
          );
        }),
      ),
  );

  it.effect(
    "verifies a lost reply against durable read-back and restores on a fresh page without ordering twice",
    () =>
      TestCdp.withCdp(
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
      ),
  );

  it.effect(
    "does not treat a transient success notice as permission to continue after a lost reply",
    () =>
      TestCdp.withCdp(
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
            TestCdp.nativePage(page).getByRole("alert").waitFor({ state: "visible" }),
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
      ),
  );

  it.effect(
    "records completed receipts and an unsent stopping point when the next input is refused",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);

          const plan = new Plan.Plan({
            version: 3,
            steps: [
              new Plan.Step({
                action: { _tag: "Hover", target: "e0" },
                subject: named("Place order"),
                url: site.url,
              }),
              new Plan.Step({
                action: { _tag: "Click", target: "e0" },
                subject: named("Unavailable"),
                url: site.url,
              }),
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
      ),
  );

  it.effect(
    "preserves dispatched Action evidence on cancellation and refuses its journaled unknown restart",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);

          const plan = new Plan.Plan({
            version: 3,
            steps: [
              new Plan.Step({
                action: { _tag: "Click", target: "e0", options: { holdMillis: 60_000 } },
                subject: named("Commit on press"),
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
      ),
  );

  it.effect(
    "does not bypass recorded arrival when an effect already holds or reconciles a lost reply",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const site = yield* workflow();
          const page = yield* open(site.url);
          const elsewhere = site.url.replace("127.0.0.1", "localhost") + "/done";

          const checked = Plan.Plan.new([
            new Plan.Step({
              action: { _tag: "Click", target: "e0" },
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
      ),
  );

  it.effect("waits for a delayed cross-site arrival and refuses one outside its bound", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const site = yield* workflow();
        const expected = site.url.replace("127.0.0.1", "localhost") + "/done";

        const plan = new Plan.Plan({
          version: 3,
          steps: [
            new Plan.Step({
              action: { _tag: "Click", target: "e0" },
              subject: named("Continue"),
              url: expected,
            }),
          ],
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
    ),
  );

  it.effect("retains a delayed recorded navigation before resuming the following step", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const site = yield* workflow();
        const expected = site.url.replace("127.0.0.1", "localhost") + "/done";
        const recording = yield* open(site.url + "?delay=200");
        const [continued] = yield* recording.find({ role: "button", name: "Continue" });

        if (continued === undefined) return yield* Effect.die("missing Continue fixture");
        yield* recording.click(continued.ref);
        yield* Effect.promise(() => TestCdp.nativePage(recording).waitForURL(expected));
        yield* recording.press("Shift");
        const plan = Plan.fromEvents(yield* recording.recentEvents);
        const following = plan.steps.findIndex((step) => step.action._tag === "Press");
        const replacement = yield* open(expected);

        const receipt = yield* Plan.take(replacement, plan, following, {
          settle: false,
          arrival: "100 millis",
        });

        assert.strictEqual(receipt.outcome, "taken");
        assert.strictEqual(plan.steps[following - 1]?.url, expected);
      }),
    ),
  );
});

// 1d6d7c7: public locate inherited a caller clock instead of the page's retry clock.
it.effect("locate retries on the page clock even when its caller clock is suspended", () =>
  Effect.gen(function* () {
    const test = yield* TestPage.make();
    const clock = yield* Clock.Clock;

    const locating = yield* Plan.locate(test.page, subject).pipe(
      Effect.provideService(Clock.Clock, { ...clock, sleep: () => Effect.never }),
      Effect.flip,
      Effect.forkChild,
    );

    yield* TestClock.adjust("3 seconds");
    const done = locating.pollUnsafe();

    assert.isDefined(done, "a suspended caller clock must not stall page-owned retries");
    assert.strictEqual((yield* Fiber.join(locating))._tag, "Missing");
  }),
);
