// The bench's tasks. An "operate" task gives a model the browser tools and a goal. An "understand"
// task brings a page to a moment, then asks a model, in one call, what the moment shows. Every task
// grades against the page's own truth, and has a scripted solution that uses the library alone, to
// show the task can be done and graded without a model.
import { Duration, Effect, Schedule, Schema, Stream } from "effect";
import * as Agent from "effect-browser/Agent";
import { Browser } from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Moment from "effect-browser/Moment";
import type { Page } from "effect-browser/Page";
import type { Snapshot } from "effect-browser/Snapshot";
import type { AiError, LanguageModel } from "effect/ai";

import { CheckoutTruth, MarketTruth, origin, ReelsTruth, serve, truth } from "./Sites.ts";

export interface Grade {
  readonly pass: boolean;
  readonly detail: string;
}

export interface Outcome extends Grade {
  readonly answer: unknown;
  /** Model calls; 0 for a scripted solution. */
  readonly steps: number;
  readonly usage: Agent.Usage;
}

export interface ModelOptions<E> {
  /** Runs after every model call with that call's usage. Failing stops the task, as a spent budget does. */
  readonly onUsage: (usage: Agent.Usage) => Effect.Effect<void, E>;
}

export interface Task {
  readonly name: string;
  readonly kind: "operate" | "understand";
  readonly summary: string;
  readonly withModel: <E>(
    options: ModelOptions<E>,
  ) => Effect.Effect<
    Outcome,
    AiError.AiError | BrowserError | Agent.AgentError | E,
    Browser | LanguageModel.LanguageModel
  >;
  readonly scripted: Effect.Effect<Outcome, BrowserError, Browser>;
}

const noUsage: Agent.Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

/** Serve the bench pages for the rest of the scope, and open `path` in the first tab. */
const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;

    yield* serve(browser);
    const page = yield* browser.page;

    yield* page.goto(`${origin}${path}`);

    return page;
  });

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ref of the first control with this role and name. */
export const refOf = (snapshot: Snapshot, role: string, name: string): string => {
  const ref = new RegExp(`${role} "${literal(name)}" \\[ref=(e\\d+)\\]`).exec(snapshot.text)?.[1];

  if (ref === undefined) throw new Error(`no ${role} "${name}" in:\n${snapshot.rendered}`);

  return ref;
};

const press = (page: Page, role: string, name: string) =>
  page
    .snapshot({ full: true })
    .pipe(Effect.flatMap((snapshot) => page.click(refOf(snapshot, role, name))));

const fill = (page: Page, name: string, text: string) =>
  page
    .snapshot({ full: true })
    .pipe(
      Effect.flatMap((snapshot) => page.type(text, { into: refOf(snapshot, "textbox", name) })),
    );

const operate = <A, I>(spec: {
  readonly name: string;
  readonly summary: string;
  readonly start: string;
  readonly prompt: string;
  readonly answer: Schema.Codec<A, I>;
  readonly maxSteps: number;
  readonly solve: (page: Page) => Effect.Effect<A, BrowserError>;
  readonly grade: (answer: A, page: Page) => Effect.Effect<Grade>;
}): Task => ({
  name: spec.name,
  kind: "operate",
  summary: spec.summary,
  withModel: (options) =>
    Effect.gen(function* () {
      const page = yield* open(spec.start);

      const result = yield* Agent.run(spec.prompt, {
        answer: spec.answer,
        maxSteps: spec.maxSteps,
        onStep: (step) => options.onUsage(step.usage),
      });

      const grade = yield* spec.grade(result.answer, page);

      return { ...grade, answer: result.answer, steps: result.steps, usage: result.usage };
    }).pipe(Effect.scoped),
  scripted: Effect.gen(function* () {
    const page = yield* open(spec.start);
    const answer = yield* spec.solve(page);
    const grade = yield* spec.grade(answer, page);

    return { ...grade, answer, steps: 0, usage: noUsage };
  }).pipe(Effect.scoped),
});

const understand = <A, I extends Record<string, unknown>>(spec: {
  readonly name: string;
  readonly summary: string;
  readonly start: string;
  /** Bring the page to the moment, without a model. */
  readonly setup: (page: Page) => Effect.Effect<void, BrowserError>;
  readonly capture: Moment.CaptureOptions;
  readonly instructions: string;
  readonly answer: Schema.Codec<A, I>;
  /** What the moment shows, read from the page's truth as it is captured. */
  readonly expected: (page: Page) => Effect.Effect<A>;
  readonly grade: (answer: A, expected: A) => Grade;
}): Task => {
  const prepare = Effect.gen(function* () {
    const page = yield* open(spec.start);

    // A running screencast gives the moment frames from before it, not just one screenshot.
    yield* page.screencast().pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
    yield* spec.setup(page);
    const moment = yield* Moment.capture(page, spec.capture);

    return { moment, expected: yield* spec.expected(page) };
  }).pipe(Effect.scoped);

  return {
    name: spec.name,
    kind: "understand",
    summary: spec.summary,
    withModel: (options) =>
      Effect.gen(function* () {
        const { moment, expected } = yield* prepare;

        const { value, usage } = yield* Moment.describe(moment, {
          schema: spec.answer,
          instructions: spec.instructions,
        });

        yield* options.onUsage(usage);

        return { ...spec.grade(value, expected), answer: value, steps: 1, usage };
      }),
    // Without a model, check that the moment holds the frames asked for and the truth reads.
    scripted: Effect.gen(function* () {
      const { moment, expected } = yield* prepare;
      const wanted = spec.capture.frames ?? 2;

      return {
        pass: moment.frames.length === wanted,
        detail: `${moment.frames.length} of ${wanted} frames, ${moment.events.length} events; truth ${JSON.stringify(expected)}`,
        answer: expected,
        steps: 0,
        usage: noUsage,
      };
    }),
  };
};

const spin = (page: Page) =>
  page
    .click({ x: 480, y: 561 })
    .pipe(Effect.andThen(page.waitForStill({ quietMillis: 400, timeout: Duration.seconds(10) })));

const casinoPlay = operate({
  name: "casino-play",
  summary: "Pass a cookie wall and an age check, open a canvas slot game and play five spins",
  start: "/casino",
  prompt:
    "Get past the cookie banner and the age check, open Temple Reels and play exactly 5 spins at the default bet. Then report the CREDITS amount the game shows.",
  answer: Schema.Struct({ credits: Schema.Finite }),
  maxSteps: 40,
  solve: (page) =>
    Effect.gen(function* () {
      yield* press(page, "button", "Accept all");
      yield* press(page, "button", "Yes, I am 18 or older");
      yield* press(page, "button", "Play");
      for (let count = 0; count < 5; count++) yield* spin(page);

      return { credits: (yield* truth(page, ReelsTruth)).credits };
    }),
  grade: (answer, page) =>
    truth(page, ReelsTruth).pipe(
      Effect.map((game) => ({
        pass: game.spins === 5 && !game.spinning && answer.credits === game.credits,
        detail: `${game.spins} spins; reported ${answer.credits} credits, the game shows ${game.credits}`,
      })),
    ),
});

const casinoMoment = understand({
  name: "casino-moment",
  summary: "Read the credits and the last win off a slot machine's canvas, just after a win",
  start: "/casino/reels",
  setup: (page) => Effect.andThen(spin(page), spin(page)),
  capture: { frames: 1 },
  instructions:
    "Read the slot machine's display: its CREDITS and WIN figures, and whether the reels are moving.",
  answer: Schema.Struct({
    credits: Schema.Finite,
    lastWin: Schema.Finite,
    reelsSpinning: Schema.Boolean,
  }),
  expected: (page) =>
    truth(page, ReelsTruth).pipe(
      Effect.map((game) => ({
        credits: game.credits,
        lastWin: game.lastWin,
        reelsSpinning: game.spinning,
      })),
    ),
  grade: (answer, expected) => ({
    pass:
      answer.credits === expected.credits &&
      answer.lastWin === expected.lastWin &&
      answer.reelsSpinning === expected.reelsSpinning,
    detail: `answered ${JSON.stringify(answer)}, expected ${JSON.stringify(expected)}`,
  }),
});

const chartRead = understand({
  name: "chart-read",
  summary: "Read the last price and the trend off a canvas candlestick chart",
  start: "/markets/btc",
  setup: () => Effect.sleep(Duration.millis(300)),
  capture: { frames: 1 },
  instructions:
    "Read the chart: the last traded price, in the tag at its right edge, and the trend across the candles shown.",
  answer: Schema.Struct({ lastPrice: Schema.Finite, trend: Schema.Literals(["up", "down"]) }),
  expected: (page) =>
    truth(page, MarketTruth).pipe(
      Effect.map((market) => ({ lastPrice: market.last, trend: market.trend })),
    ),
  grade: (answer, expected) => ({
    // Within 0.05%: the tag's figure, allowing for a dropped decimal.
    pass:
      Math.abs(answer.lastPrice - expected.lastPrice) <= expected.lastPrice * 0.0005 &&
      answer.trend === expected.trend,
    detail: `answered ${answer.lastPrice} ${answer.trend}, expected ${expected.lastPrice} ${expected.trend}`,
  }),
});

const MoveAnswer = Schema.Struct({
  movedSharply: Schema.Boolean,
  direction: Schema.Literals(["up", "down", "flat"]),
});

const moveInstructions =
  "The screenshots span the last few seconds of a live price chart. Say whether the price just moved sharply, and which way it went.";

/** Wait on the live chart until `ready` holds, then `thenMillis` more. */
const waitForMarket =
  (ready: (market: typeof MarketTruth.Type) => boolean, thenMillis: number) => (page: Page) =>
    truth(page, MarketTruth).pipe(
      Effect.repeat({ schedule: Schedule.spaced(Duration.millis(250)), until: ready }),
      Effect.andThen(Effect.sleep(Duration.millis(thenMillis))),
      Effect.timeout(Duration.seconds(30)),
      Effect.orDie,
    );

const chartSpike = understand({
  name: "chart-spike",
  summary: "Notice that a live chart just jumped, from frames spread over the last few seconds",
  start: "/markets/btc?live=1",
  setup: waitForMarket((market) => market.spikeAt !== null, 1500),
  capture: { frames: 3, windowMillis: 4000 },
  instructions: moveInstructions,
  answer: MoveAnswer,
  expected: () => Effect.succeed({ movedSharply: true, direction: "up" as const }),
  grade: (answer) => ({
    pass: answer.movedSharply && answer.direction === "up",
    detail: `answered ${JSON.stringify(answer)}, expected a sharp move up`,
  }),
});

// The control for chart-spike: the same chart and question, before the jump.
const chartCalm = understand({
  name: "chart-calm",
  summary: "Say that a live chart has not jumped, before it does",
  start: "/markets/btc?live=1",
  setup: waitForMarket((market) => market.candles >= 63, 0),
  capture: { frames: 3, windowMillis: 4000 },
  instructions: moveInstructions,
  answer: MoveAnswer,
  expected: () => Effect.succeed({ movedSharply: false, direction: "flat" as const }),
  grade: (answer) => ({
    pass: !answer.movedSharply,
    detail: `answered ${JSON.stringify(answer)}, expected no sharp move`,
  }),
});

const chartTrade = operate({
  name: "chart-trade",
  summary: "Place a market buy on a live trading page and report the order id",
  start: "/markets/btc?live=1",
  prompt: "Buy 0.25 BTC with a market order, then report the id of the order in the orders table.",
  answer: Schema.Struct({ orderId: Schema.String }),
  maxSteps: 20,
  solve: (page) =>
    Effect.gen(function* () {
      yield* fill(page, "Quantity (BTC)", "0.25");
      yield* press(page, "button", "Place order");
      const snapshot = yield* page.snapshot({ full: true });

      return { orderId: /ORD-\d+/.exec(snapshot.text)?.[0] ?? "" };
    }),
  grade: (answer, page) =>
    truth(page, MarketTruth).pipe(
      Effect.map((market) => {
        const order = market.orders[0];

        return {
          pass:
            market.orders.length === 1 &&
            order?.side === "buy" &&
            order.qty === 0.25 &&
            order.type === "market" &&
            order.id === answer.orderId,
          detail: `orders ${JSON.stringify(market.orders)}; reported ${answer.orderId}`,
        };
      }),
    ),
});

const customer = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  street: "1 Market Street",
  city: "San Francisco",
  postal: "94105",
  country: "US",
  shipping: "express",
};

const checkout = operate({
  name: "checkout",
  summary: "Fill in a checkout form, choose express shipping and report the confirmation number",
  start: "/shop/checkout",
  prompt: `Check out as ${customer.name} (${customer.email}), shipping to ${customer.street}, ${customer.city} ${customer.postal}, United States, with express shipping. Report the confirmation number.`,
  answer: Schema.Struct({ confirmation: Schema.String }),
  maxSteps: 25,
  solve: (page) =>
    Effect.gen(function* () {
      yield* fill(page, "Full name", customer.name);
      yield* fill(page, "Email", customer.email);
      yield* fill(page, "Street address", customer.street);
      yield* fill(page, "City", customer.city);
      yield* fill(page, "Postal code", customer.postal);
      const form = yield* page.snapshot({ full: true });

      yield* page.select(refOf(form, "combobox", "Country"), ["United States"]);
      yield* page.click(refOf(form, "radio", "Express (1-2 days, +$15)"));
      yield* page.click(refOf(form, "button", "Place order"));
      const done = yield* page.snapshot();

      return { confirmation: /CONF-\d+/.exec(done.text)?.[0] ?? "" };
    }),
  grade: (answer, page) =>
    truth(page, CheckoutTruth).pipe(
      Effect.map((shop) => {
        const submitted = shop.submitted ?? {};
        const wrong = Object.entries(customer).filter(([key, value]) => submitted[key] !== value);

        return {
          pass:
            shop.confirmation !== null &&
            answer.confirmation === shop.confirmation &&
            wrong.length === 0,
          detail:
            wrong.length === 0
              ? `reported ${answer.confirmation}, the shop issued ${shop.confirmation ?? "none"}`
              : `wrong or missing: ${wrong.map(([key]) => key).join(", ")}`,
        };
      }),
    ),
});

export const tasks: ReadonlyArray<Task> = [
  casinoPlay,
  casinoMoment,
  chartRead,
  chartSpike,
  chartCalm,
  chartTrade,
  checkout,
];
