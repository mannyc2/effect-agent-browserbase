// Grading, against models scripted to be wrong or blindly sure: no model is called.
import { isDeepStrictEqual } from "node:util";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Schema, Stream } from "effect";
import { Browser } from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Chromium from "effect-browser/Chromium";
import type { Frame } from "effect-browser/Frame";
import type { Page } from "effect-browser/Page";
import { LanguageModel, type Prompt, type Response } from "effect/ai";

import { noCalls } from "../Budget.ts";
import {
  type FixtureUnreadable,
  FrameTruth,
  MarketTruth,
  NavigationTruth,
  QuoteTruth,
  TumbleTruth,
  truth,
} from "../Sites.ts";
import { frameHistory, tasks } from "../Tasks.ts";
import { classify } from "../Trial.ts";

/** A model that answers every call with the same parts. */
const answering = (parts: ReadonlyArray<Response.PartEncoded>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([...parts]),
      streamText: () => Stream.empty,
    }),
  );

const usage = { inputTokens: { total: 1200 }, outputTokens: { total: 40 } };

/** A describer that gives this answer whatever it is shown. */
const says = (answer: unknown) =>
  answering([
    { type: "text", text: JSON.stringify(answer) },
    { type: "finish", reason: "stop", usage },
  ]);

/** An agent that reports this answer at once, without looking. */
const reports = (answer: unknown) =>
  answering([
    { type: "tool-call", id: "call-1", name: "done", params: { answer } },
    { type: "finish", reason: "tool-calls", usage },
  ]);

const taskNamed = (name: string) => {
  const task = tasks.find((candidate) => candidate.name === name);

  if (task === undefined) throw new Error(`no task ${name}`);

  return task;
};

const run = (name: string, model: Layer.Layer<LanguageModel.LanguageModel>) =>
  taskNamed(name)
    .withModel({ seed: 23, onUsage: () => Effect.void })
    .pipe(Effect.provide(Layer.merge(Chromium.layer({ frameHistory }), model)));

/** Inspect the actual description request and retained frames without replacing capture. */
const describeWith = (
  name: string,
  answer: (page: Page) => Effect.Effect<unknown, BrowserError | FixtureUnreadable>,
  options: {
    readonly seed?: number;
    readonly frameDelayMillis?: number;
    readonly frameHistory?: Duration.Input;
    /** Lose every screencast frame once this many clicks begin, as a stalled screencast does. */
    readonly dropFramesAfterClicks?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;

    const frameDelayMillis = options.frameDelayMillis ?? 0;
    let clicks = 0;

    const dropping = () =>
      options.dropFramesAfterClicks !== undefined && clicks >= options.dropFramesAfterClicks;

    if (frameDelayMillis > 0 || options.dropFramesAfterClicks !== undefined) {
      const context = browser.context;
      const createSession = context.newCDPSession.bind(context);
      const pending = new Set<ReturnType<typeof setTimeout>>();

      context.newCDPSession = async (target) => {
        const cdp = await createSession(target);

        const emitter = cdp as typeof cdp & {
          emit(event: string | symbol, ...args: ReadonlyArray<unknown>): boolean;
        };

        const emit = emitter.emit.bind(emitter);

        emitter.emit = (event, ...args) => {
          if (event !== "Page.screencastFrame") return emit(event, ...args);
          if (dropping()) return true;
          if (frameDelayMillis === 0) return emit(event, ...args);

          const timer = setTimeout(() => {
            pending.delete(timer);
            emit(event, ...args);
          }, frameDelayMillis);

          pending.add(timer);

          return true;
        };

        return cdp;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          context.newCDPSession = createSession;
          for (const timer of pending) clearTimeout(timer);
        }),
      );
    }

    const page = yield* browser.page;

    const prompts: Array<Prompt.Prompt> = [];
    const histories: Array<ReadonlyArray<Frame>> = [];
    const currents: Array<Frame> = [];
    let frameAfter = 0;

    const observed: Page = {
      ...page,
      click: (...target) =>
        Effect.sync(() => {
          clicks++;
        }).pipe(Effect.andThen(page.click(...target))),
      recentFrames: page.recentFrames.pipe(
        Effect.tap((frames) => Effect.sync(() => histories.push(frames))),
      ),
      frame: (options) =>
        page.frame(options).pipe(Effect.tap((frame) => Effect.sync(() => currents.push(frame)))),
    };

    const model = yield* LanguageModel.make({
      generateText: (options) =>
        // The scripted model reads the fixture it describes; a failure there is the test's own.
        Effect.gen(function* () {
          prompts.push(options.prompt);
          frameAfter = (yield* truth(page, FrameTruth)).frameAfter;
          const value = yield* answer(page);

          const parts: Array<Response.PartEncoded> = [
            { type: "text", text: JSON.stringify(value) },
            { type: "finish", reason: "stop", usage },
          ];

          return parts;
        }).pipe(Effect.orDie),
      streamText: () => Stream.empty,
    });

    const outcome = yield* taskNamed(name)
      .withModel({ seed: options.seed ?? 23, onUsage: () => Effect.void })
      .pipe(
        Effect.provideService(Browser, Browser.of({ ...browser, page: Effect.succeed(observed) })),
        Effect.provideService(LanguageModel.LanguageModel, model),
      );

    return {
      outcome,
      prompts,
      history: histories.at(-1) ?? [],
      current: currents.at(-1),
      frameAfter,
      events: yield* browser.recentEvents,
    };
  }).pipe(
    Effect.scoped,
    Effect.provide(Chromium.layer({ frameHistory: options.frameHistory ?? frameHistory })),
  );

const paintTime = (frame: Frame): number => {
  if (frame.timing._tag !== "BrowserPaint")
    throw new Error("benchmark evidence requires a native browser paint");

  return frame.timing.timestamp;
};

const pictures = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) =>
          part.type === "file" && part.mediaType.startsWith("image/") ? [part] : [],
        )
      : [],
  );

const textOf = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");

describe("grading", () => {
  it.live("a made-up confirmation number fails checkout", () =>
    run("checkout", reports({ confirmation: "CONF-00000" })).pipe(
      Effect.map((outcome) => {
        assert.isFalse(outcome.pass, outcome.detail);
        assert.strictEqual(outcome.steps, 1);
        assert.strictEqual(outcome.usage.inputTokens, 1200);
      }),
    ),
  );

  it.live("a misread price fails chart-read", () =>
    run("chart-read", says({ lastPrice: 1, trend: "up" })).pipe(
      Effect.map((outcome) => assert.isFalse(outcome.pass, outcome.detail)),
    ),
  );

  it.live("a model that always sees a sharp rise passes chart-spike and fails its control", () =>
    Effect.gen(function* () {
      const sure = says({ movedSharply: true, direction: "up" });
      const spike = yield* run("chart-spike", sure);
      const calm = yield* run("chart-calm", sure);

      assert.isTrue(spike.pass, spike.detail);
      assert.isFalse(calm.pass, calm.detail);
    }),
  );
});

const quoteAnswer = (quote: typeof QuoteTruth.Type) => ({
  ticker: quote.focus,
  price: quote.price,
  change1h: quote.c1h,
  change24h: quote.c24h,
  column: quote.header,
  table: quote.table,
});

const quote = (page: Page) => truth(page, QuoteTruth).pipe(Effect.map(quoteAnswer));

const order = (page: Page) =>
  truth(page, MarketTruth).pipe(
    Effect.map((market) => {
      const filled = market.orders[0];

      if (filled === undefined) throw new Error("the fixture did not place its order");

      return filled;
    }),
  );

const tumble = (page: Page) =>
  truth(page, TumbleTruth).pipe(
    Effect.map((state) => ({
      tumbles: state.tumbles,
      multiplier: state.multiplier,
      totalWin: state.totalWin,
      balance: state.balance,
      done: state.done,
    })),
  );

describe("understanding evidence", () => {
  for (const name of ["quote-table", "quote-dense"]) {
    it.live(`${name} sends one current picture and grades the requested table`, () =>
      Effect.gen(function* () {
        const { outcome, prompts } = yield* describeWith(name, quote);

        assert.isTrue(outcome.pass, outcome.detail);
        assert.strictEqual(prompts.length, 1);
        const prompt = prompts[0];

        if (prompt === undefined) throw new Error("the description prompt is missing");
        assert.strictEqual(pictures(prompt).length, 1);
        assert.include(textOf(prompt), "Spot markets");
        assert.notInclude(textOf(prompt), "__bench");
      }),
    );
  }

  it.live("keeps the full tumble interval, not only enough recent frames", () =>
    Effect.gen(function* () {
      let durationMillis = 0;

      const { outcome, prompts, history, events, frameAfter } = yield* describeWith(
        "tumble-win",
        (page) =>
          truth(page, TumbleTruth).pipe(
            Effect.tap((state) =>
              Effect.sync(() => {
                durationMillis = state.durationMillis;
                assert.strictEqual(state.tumbles, 4);
                assert.strictEqual(state.multiplier, 10);
              }),
            ),
            Effect.andThen(tumble(page)),
          ),
        { seed: 15 },
      );

      assert.isTrue(outcome.pass, outcome.detail);
      const first = history[0];
      const last = history.at(-1);
      const prompt = prompts[0];
      const click = events.find((event) => event._tag === "Action" && event.name === "click");

      if (first === undefined || last === undefined || prompt === undefined || click === undefined)
        throw new Error("the tumble did not retain its frames, prompt and input event");
      assert.isAtLeast(last.receivedAt - first.receivedAt, durationMillis - 300);
      if (click._tag !== "Action") throw new Error("the input event is not an action");
      assert.isBelow(first.receivedAt, click.startedAt);

      const selected = pictures(prompt).map((image) => {
        const frame = history.find((candidate) => candidate.data === image.data);

        if (frame === undefined)
          throw new Error("the description image is not one of the retained frames");

        return frame;
      });

      assert.strictEqual(selected.length, 12);
      for (let index = 1; index < selected.length; index++) {
        const earlier = selected[index - 1];
        const later = selected[index];

        if (earlier === undefined || later === undefined)
          throw new Error("the selected frame sequence is incomplete");
        // One cascade lasts 1,800 ms; a larger gap could conceal an entire paying cascade.
        assert.isAbove(paintTime(later), paintTime(earlier));
        assert.isBelow(paintTime(later) - paintTime(earlier), 1800);
      }
      const final = selected.at(-1);

      if (final === undefined) throw new Error("the final description image is missing");
      assert.isAtLeast(paintTime(final), frameAfter);

      // Timestamp labels come from the selected Moment frames, not the whole retained history.
      const ages = [...textOf(prompt).matchAll(/^(-[\d.]+)s:$/gm)].map(
        (match) => Math.abs(Number(match[1])) * 1000,
      );

      assert.isAtLeast(Math.max(...ages), durationMillis - 400);
    }),
  );

  it.live("fails incomplete frame evidence as infrastructure before any model call", () =>
    Effect.gen(function* () {
      let called = false;

      const failure = yield* describeWith(
        "order-filled",
        (page) =>
          Effect.sync(() => {
            called = true;
          }).pipe(Effect.andThen(order(page))),
        { frameHistory: Duration.millis(1) },
      ).pipe(Effect.flip);

      assert.isFalse(called);
      assert.strictEqual(failure._tag, "EvidenceIncomplete");
      assert.deepStrictEqual(classify(Exit.fail(failure), noCalls), {
        status: "infrastructure-failed",
        reason: "evidence-incomplete",
        pass: null,
      });
    }),
  );

  it.live("waits for the final browser paint when frame delivery is delayed", () =>
    Effect.gen(function* () {
      const { outcome, prompts, history, current, frameAfter } = yield* describeWith(
        "order-filled",
        order,
        { frameDelayMillis: 500 },
      );

      const prompt = prompts[0];

      assert.isTrue(outcome.pass, outcome.detail);
      if (prompt === undefined) throw new Error("the description prompt is missing");
      const image = pictures(prompt).at(-1);
      const final = history.findLast((frame) => isDeepStrictEqual(frame.data, image?.data));

      assert.isTrue(history.some((frame) => paintTime(frame) < frameAfter));
      // Delayed delivery can also lose the settling repaint. Either a retained paint after the
      // barrier is final, or a fresh screenshot taken after the barrier is: a frame stands in for
      // the page only while it was painted at most 250 ms ago, and these arrive 500 ms late.
      if (final === undefined) {
        assert.include(outcome.detail, "final frame from a fresh screenshot");
        assert.isTrue(
          history.every(
            (frame) =>
              paintTime(frame) < frameAfter || (current?.hostTime ?? 0) - frame.hostTime > 250,
          ),
        );
      } else assert.isAtLeast(paintTime(final), frameAfter);
    }),
  );

  it.live("describes a fresh screenshot when the screencast loses the final paint", () =>
    Effect.gen(function* () {
      const { outcome, prompts, history } = yield* describeWith("order-filled", order, {
        dropFramesAfterClicks: 1,
      });

      const prompt = prompts[0];

      assert.isTrue(outcome.pass, outcome.detail);
      assert.include(outcome.detail, "final frame from a fresh screenshot");
      if (prompt === undefined) throw new Error("the description prompt is missing");
      const final = pictures(prompt).at(-1);

      // The order row only reached the screenshot; every retained paint predates the click.
      assert.isFalse(history.some((frame) => isDeepStrictEqual(frame.data, final?.data)));
      assert.strictEqual(pictures(prompt).length, 2);
    }),
  );

  for (const [name, answer] of [
    ["order-filled", order],
    ["navigated", (page: Page) => truth(page, NavigationTruth)],
  ] as const) {
    it.live(`${name} describes frames from before and after its trigger`, () =>
      Effect.gen(function* () {
        const { outcome, prompts, history, current, events, frameAfter } = yield* describeWith(
          name,
          answer,
        );

        const prompt = prompts[0];

        assert.isTrue(outcome.pass, outcome.detail);
        if (prompt === undefined) throw new Error("the description prompt is missing");
        const selected = pictures(prompt);

        assert.isAtLeast(selected.length, 2);
        assert.notDeepEqual(selected[0]?.data, selected.at(-1)?.data);

        const final = history.findLast((frame) =>
          isDeepStrictEqual(frame.data, selected.at(-1)?.data),
        );

        // The final picture is a retained paint after the barrier or, when none was demonstrably
        // current, the moment's own screenshot, taken after a paint at the barrier arrived.
        if (final === undefined) {
          const reached = history.find((frame) => paintTime(frame) >= frameAfter);

          if (current === undefined || reached === undefined)
            throw new Error("the final description image is not a captured frame");
          assert.strictEqual(current.timing._tag, "Screenshot");
          assert.deepStrictEqual(current.data, selected.at(-1)?.data);
          assert.isAtLeast(current.hostTime - current.timing.uncertaintyMillis, reached.receivedAt);
        } else assert.isAtLeast(paintTime(final), frameAfter);
        assert.include(textOf(prompt), "click");

        const lastClick = events.findLast(
          (event) => event._tag === "Action" && event.name === "click",
        );

        const first = history[0];
        const last = history.at(-1);

        if (lastClick === undefined || first === undefined || last === undefined)
          throw new Error("the action did not retain its before and after evidence");
        if (lastClick._tag !== "Action") throw new Error("the input event is not an action");
        assert.isBelow(first.receivedAt, lastClick.startedAt);
        assert.isAtLeast(last.receivedAt - first.receivedAt, 500);
        if (name === "navigated") {
          const { trigger } = yield* Schema.decodeUnknownEffect(NavigationTruth)(outcome.answer);

          assert.include(textOf(prompt), "navigated to");
          // The control is named as it was clicked, not by a ref the new page reuses.
          assert.include(textOf(prompt), `click button "${trigger}"`);
          assert.notMatch(textOf(prompt), /\be\d+\b/);

          const priorClick = events
            .filter((event) => event._tag === "Action" && event.name === "click")
            .at(-2);

          const before = history.find((frame) => isDeepStrictEqual(frame.data, selected[0]?.data));

          if (priorClick === undefined || before === undefined)
            throw new Error("the navigation's initial picture or preceding gate action is missing");
          // A cookie-banner frame cannot show the Play control that actually navigated.
          assert.isAbove(before.receivedAt, priorClick.at);
          assert.isBelow(before.receivedAt, lastClick.startedAt);
        }
      }),
    );
  }
});

describe("specific misreads", () => {
  it.live("rejects a quote from the wrong row", () =>
    describeWith("quote-dense", (page) =>
      truth(page, QuoteTruth).pipe(
        Effect.map((state) => {
          const wrong = state.rows.find(
            (row) => row.table === state.table && row.ticker !== state.focus,
          );

          if (wrong === undefined) throw new Error("the quote fixture has no distractor row");

          return {
            ...quoteAnswer(state),
            price: wrong.price,
            change1h: wrong.c1h,
            change24h: wrong.c24h,
          };
        }),
      ),
    ).pipe(Effect.map(({ outcome }) => assert.isFalse(outcome.pass, outcome.detail))),
  );

  for (const [field, otherPeriod] of [
    ["change24h", "c1h"],
    ["change1h", "c24h"],
  ] as const) {
    it.live(`rejects ${field} borrowed from the other percentage column`, () =>
      describeWith("quote-table", (page) =>
        truth(page, QuoteTruth).pipe(
          Effect.map((state) => ({ ...quoteAnswer(state), [field]: state[otherPeriod] })),
        ),
      ).pipe(Effect.map(({ outcome }) => assert.isFalse(outcome.pass, outcome.detail))),
    );
  }

  it.live("rejects the same asset's quote from another table", () =>
    describeWith("quote-dense", (page) =>
      truth(page, QuoteTruth).pipe(
        Effect.map((state) => {
          const wrong = state.rows.find(
            (row) => row.table !== state.table && row.ticker === state.focus,
          );

          if (wrong === undefined) throw new Error("the quote fixture has no distractor table");

          return {
            ...quoteAnswer(state),
            price: wrong.price,
            change1h: wrong.c1h,
            change24h: wrong.c24h,
          };
        }),
      ),
    ).pipe(Effect.map(({ outcome }) => assert.isFalse(outcome.pass, outcome.detail))),
  );

  for (const changed of [
    { ticker: "WRONG-USD" },
    { column: "1h %" },
    { table: "Perpetual futures" },
  ]) {
    it.live(`rejects correct quote values with the wrong ${Object.keys(changed)[0]}`, () =>
      describeWith("quote-dense", (page) =>
        quote(page).pipe(Effect.map((answer) => ({ ...answer, ...changed }))),
      ).pipe(Effect.map(({ outcome }) => assert.isFalse(outcome.pass, outcome.detail))),
    );
  }

  it.live("rejects an extra tumble inferred from unrelated motion", () =>
    describeWith("tumble-win", (page) =>
      tumble(page).pipe(Effect.map((answer) => ({ ...answer, tumbles: answer.tumbles + 1 }))),
    ).pipe(Effect.map(({ outcome }) => assert.isFalse(outcome.pass, outcome.detail))),
  );

  it.live("rejects a filled order described as still pending", () =>
    describeWith("order-filled", (page) =>
      order(page).pipe(Effect.map((answer) => ({ ...answer, status: "pending" }))),
    ).pipe(Effect.map(({ outcome }) => assert.isFalse(outcome.pass, outcome.detail))),
  );

  it.live("rejects navigation assigned to the earlier cookie action", () =>
    describeWith("navigated", (page) =>
      truth(page, NavigationTruth).pipe(
        Effect.map((answer) => ({ ...answer, trigger: "Accept all" })),
      ),
    ).pipe(Effect.map(({ outcome }) => assert.isFalse(outcome.pass, outcome.detail))),
  );
});
