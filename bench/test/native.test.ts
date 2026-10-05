// Native envelopes pass through a loopback HTTP server and the public Page API on real Chromium.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { Browser } from "effect-browser/Browser";
import { BrowserError, Failed } from "effect-browser/BrowserError";
import * as Chromium from "effect-browser/Chromium";
import * as Moment from "effect-browser/Moment";
import type { Page } from "effect-browser/Page";
import { Snapshot } from "effect-browser/Snapshot";

import * as Native from "../Native.ts";
import { MarketTruth, origin, serve, truth } from "../Sites.ts";

class TestError extends Schema.TaggedError<TestError>()("NativeTestError", {
  cause: Schema.Defect(),
}) {}

const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 };
const Answer = Schema.Struct({ orderId: Schema.String });
const secret = "PRIVATE-RESPONSE-ERROR-CANARY";

const reasoning = {
  type: "reasoning",
  id: "reasoning-1",
  summary: [],
  encrypted_content: "synthetic-private-state",
};

const call = (actions: ReadonlyArray<unknown>, id = "call-1") => ({
  type: "computer_call",
  id,
  call_id: id + "-output",
  actions,
  pending_safety_checks: [],
});

const response = (output: ReadonlyArray<unknown>) => ({ status: "completed", output });

const message = (text = '{"orderId":"ORD-1001"}') => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

interface HttpReply {
  readonly status: number;
  readonly body: unknown;
}

const provider = Effect.fnUntraced(function* (
  script: (request: Native.Request, index: number) => HttpReply | "disconnect",
) {
  const requests: Array<Native.Request> = [];

  const receive = async (request: IncomingMessage, reply: ServerResponse) => {
    const chunks: Array<Buffer> = [];

    for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));

    const raw = Schema.decodeSync(Schema.fromJsonString(Native.RequestSchema))(
      Buffer.concat(chunks).toString("utf8"),
    );

    assert.isUndefined(request.headers.authorization);
    requests.push(raw);
    const answer = script(raw, requests.length - 1);

    if (answer === "disconnect") {
      request.socket.destroy();

      return;
    }
    reply.writeHead(answer.status, { "content-type": "application/json" });
    reply.end(JSON.stringify(answer.body));
  };

  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer((request, reply) => {
            void receive(request, reply).catch(() => reply.destroy());
          });

          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
      catch: (cause) => new TestError({ cause }),
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

  const address = server.address();

  if (address === null || typeof address === "string")
    return yield* new TestError({ cause: "address" });
  const url = "http://127.0.0.1:" + address.port + "/responses";

  return {
    requests,
    service: Native.NativeTransport.of({
      request: (body) =>
        Effect.tryPromise({
          try: async (signal) => {
            const reply = await fetch(url, {
              method: "POST",
              signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });

            return { status: reply.status, body: (await reply.json()) as unknown, usage };
          },
          catch: () => new Native.NativeError({ code: "RequestUncertain" }),
        }),
    }),
  };
});

const fixture = Effect.gen(function* () {
  const browser = yield* Browser;

  yield* serve(browser, 23);
  const page = yield* browser.page;

  yield* page.goto(origin + "/markets/btc?live=1");

  const coordinates = yield* Effect.tryPromise({
    try: async () => {
      const qty = await page.playwright.locator("#qty").boundingBox();
      const place = await page.playwright.locator("#place").boundingBox();

      if (qty === null || place === null) throw new Error("Fixture controls unavailable");

      return {
        qty: { x: Math.round(qty.x + qty.width / 2), y: Math.round(qty.y + qty.height / 2) },
        place: {
          x: Math.round(place.x + place.width / 2),
          y: Math.round(place.y + place.height / 2),
        },
      };
    },
    catch: (cause) => new TestError({ cause }),
  });

  return {
    page,
    buy: [
      { type: "click", ...coordinates.qty },
      { type: "keypress", keys: ["CTRL", "A"] },
      { type: "type", text: "0.25" },
      { type: "click", ...coordinates.place },
    ],
    place: { type: "click", ...coordinates.place },
  };
});

const run = (page: Page, service: Native.NativeTransport["Service"], maxSteps = 20) =>
  Native.operate(Native.defaults, {
    page,
    prompt: "Buy 0.25 BTC with a market order and report its orderId.",
    schema: Answer,
    maxSteps,
    onUsage: () => Effect.void,
  }).pipe(Effect.provideService(Native.NativeTransport, service));

const code = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected native failure");
  const error = Cause.findErrorOption(exit.cause);

  if (error._tag === "None" || !Schema.is(Native.NativeError)(error.value))
    throw new Error("Expected typed NativeError");
  assert.notInclude(JSON.stringify(error.value), secret);

  return error.value.code;
};

describe("native computer strategy", () => {
  it.live(
    "executes ordered native actions and preserves encrypted stateless history with original screenshots",
    () =>
      Effect.gen(function* () {
        const { page, buy } = yield* fixture;

        const remote = yield* provider((_body, index) => ({
          status: 200,
          body: index === 0 ? response([reasoning, call(buy)]) : response([message()]),
        }));

        const result = yield* run(page, remote.service);

        assert.strictEqual(result.answer.orderId, "ORD-1001");
        assert.strictEqual(result.steps, 2);
        assert.deepStrictEqual(result.usage, {
          inputTokens: 200,
          outputTokens: 40,
          cachedInputTokens: 60,
        });
        const market = yield* truth(page, MarketTruth);

        assert.strictEqual(market.orders.length, 1);
        assert.strictEqual(market.orders[0]?.qty, 0.25);
        assert.strictEqual(market.orders[0]?.side, "buy");
        const [first, second] = remote.requests;

        assert.isDefined(first);
        assert.isDefined(second);
        assert.deepStrictEqual(first?.tools, [{ type: "computer" }]);
        assert.strictEqual(first?.store, false);
        assert.deepStrictEqual(second?.input[1], reasoning);
        assert.deepStrictEqual(second?.input[2], call(buy));
        assert.isFalse(second !== undefined && "previous_response_id" in second);
        const output = second?.input[3];

        assert.strictEqual(output?.type, "computer_call_output");
        assert.strictEqual(output?.call_id, "call-1-output");

        const screenshot = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            type: Schema.Literal("computer_screenshot"),
            image_url: Schema.String,
            detail: Schema.Literal("original"),
          }),
        )(output?.output);

        assert.match(screenshot.image_url, /^data:image\/jpeg;base64,/);
        assert.include(JSON.stringify(first?.input), '"detail":"original"');
        assert.notInclude(JSON.stringify(first), "provider");
        assert.notInclude(JSON.stringify(first), "authorization");
      }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  const invalid = [
    {
      name: "legacy single action",
      code: "ComputerCallInvalid",
      body: response([
        {
          type: "computer_call",
          id: "legacy",
          call_id: "legacy-output",
          action: { type: "click", x: 5, y: 5 },
        },
      ]),
    },
    {
      name: "invalid envelope",
      code: "ResponseEnvelopeInvalid",
      body: { status: "completed", output: null, detail: secret },
    },
    {
      name: "incomplete response",
      code: "NativeIncomplete",
      body: { status: "incomplete", output: [], detail: secret },
    },
    {
      name: "refusal",
      code: "NativeRefused",
      body: response([
        { type: "message", role: "assistant", content: [{ type: "refusal", refusal: secret }] },
      ]),
    },
    {
      name: "non-native tool",
      code: "UnexpectedOutputKind",
      body: response([{ type: "function_call", name: secret }]),
    },
    {
      name: "missing first computer call",
      code: "FirstComputerCallMissing",
      body: response([message()]),
    },
    {
      name: "safety hold",
      code: "SafetyCheckRequired",
      body: response([
        { ...call([{ type: "screenshot" }]), pending_safety_checks: [{ message: secret }] },
      ]),
    },
    { name: "empty native batch", code: "InvalidBatch", body: response([call([])]) },
  ] as const;

  for (const scenario of invalid)
    it.live("stops before dispatch for " + scenario.name, () =>
      Effect.gen(function* () {
        const { page } = yield* fixture;
        const remote = yield* provider(() => ({ status: 200, body: scenario.body }));

        assert.strictEqual(code(yield* run(page, remote.service).pipe(Effect.exit)), scenario.code);
        assert.strictEqual(remote.requests.length, 1);
        assert.strictEqual((yield* truth(page, MarketTruth)).orders.length, 0);
      }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
    );

  const invalidActions = [
    { code: "InvalidKeys", action: { type: "keypress", keys: ["keya"] } },
    { code: "InvalidCoordinates", action: { type: "click", x: 1280, y: 0 } },
    { code: "InvalidCoordinates", action: { type: "click", x: 0.5, y: 0 } },
    { code: "InvalidKeys", action: { type: "keypress", keys: ["CTRL+A"] } },
    {
      code: "UnsupportedAction",
      action: {
        type: "drag",
        path: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
      },
    },
    { code: "UnsupportedAction", action: { type: "launch", url: secret } },
    { code: "InvalidAction", action: { type: "scroll", x: 5, y: 5, scroll_x: 0, scroll_y: 9000 } },
  ] as const;

  it.live("validates every action and every sibling call before any earlier mutation", () =>
    Effect.gen(function* () {
      const { page, buy } = yield* fixture;

      for (const scenario of invalidActions) {
        const remote = yield* provider(() => ({
          status: 200,
          body: response([call(buy), call([scenario.action], "later-call")]),
        }));

        assert.strictEqual(code(yield* run(page, remote.service).pipe(Effect.exit)), scenario.code);
        assert.strictEqual(remote.requests.length, 1);
        assert.strictEqual((yield* truth(page, MarketTruth)).orders.length, 0);
      }
    }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  it.live("never replays a repeated call after a completed order", () =>
    Effect.gen(function* () {
      const { page, buy } = yield* fixture;
      const remote = yield* provider(() => ({ status: 200, body: response([call(buy)]) }));

      assert.strictEqual(code(yield* run(page, remote.service).pipe(Effect.exit)), "RepeatedCall");
      assert.strictEqual(remote.requests.length, 2);
      assert.strictEqual((yield* truth(page, MarketTruth)).orders.length, 1);
    }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  it.live(
    "halts after an uncertain mutation without replaying or dispatching its later sibling",
    () =>
      Effect.gen(function* () {
        const { page, buy, place } = yield* fixture;

        yield* Effect.promise(() => page.playwright.locator("#qty").fill("0.25"));

        const uncertain = new BrowserError({
          operation: "click",
          reason: new Failed({ detail: "Synthetic lost acknowledgement" }),
          dispatched: true,
        });

        let mutations = 0;

        const checked: Page = {
          ...page,
          click: (...args) =>
            page.click(...args).pipe(
              Effect.flatMap((result) => {
                mutations += 1;

                return mutations === 1 ? Effect.fail(uncertain) : Effect.succeed(result);
              }),
            ),
        };

        const remote = yield* provider(() => ({
          status: 200,
          body: response([call([place, ...buy])]),
        }));

        const exit = yield* run(checked, remote.service).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);

          assert.strictEqual(error._tag === "Some" ? error.value : undefined, uncertain);
        }
        assert.strictEqual(mutations, 1);
        assert.strictEqual(remote.requests.length, 1);
        assert.strictEqual((yield* truth(page, MarketTruth)).orders.length, 1);
      }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  it.live("keeps transport uncertainty and unknown price from causing browser actions", () =>
    Effect.gen(function* () {
      const { page } = yield* fixture;
      const remote = yield* provider(() => "disconnect");

      assert.strictEqual(
        code(yield* run(page, remote.service).pipe(Effect.exit)),
        "RequestUncertain",
      );
      assert.strictEqual(remote.requests.length, 1);

      const unpaid = Native.NativeTransport.of({
        request: () => Effect.fail(new Native.NativeError({ code: "UnpricedResponse" })),
      });

      assert.strictEqual(code(yield* run(page, unpaid).pipe(Effect.exit)), "UnpricedResponse");
      assert.strictEqual((yield* truth(page, MarketTruth)).orders.length, 0);
    }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  it.live(
    "rejects oversized action batches and wait budgets before executing their first item",
    () =>
      Effect.gen(function* () {
        const { page, buy } = yield* fixture;

        for (const scenario of [
          {
            expected: "InvalidBatch",
            actions: [...buy, ...Array.from({ length: 61 }, () => ({ type: "screenshot" }))],
          },
          {
            expected: "WaitLimit",
            actions: [...buy, ...Array.from({ length: 21 }, () => ({ type: "wait" }))],
          },
        ]) {
          const remote = yield* provider(() => ({
            status: 200,
            body: response([call(scenario.actions)]),
          }));

          assert.strictEqual(
            code(yield* run(page, remote.service).pipe(Effect.exit)),
            scenario.expected,
          );
          assert.strictEqual((yield* truth(page, MarketTruth)).orders.length, 0);
        }
      }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  it.live("distinguishes final JSON syntax from schema mismatch and respects the turn limit", () =>
    Effect.gen(function* () {
      const { page } = yield* fixture;

      for (const scenario of [
        { text: "{", expected: "FinalJsonInvalid" },
        { text: '{"other":true}', expected: "FinalAnswerInvalid" },
      ]) {
        const remote = yield* provider((_request, index) => ({
          status: 200,
          body: response(index === 0 ? [call([{ type: "screenshot" }])] : [message(scenario.text)]),
        }));

        assert.strictEqual(
          code(yield* run(page, remote.service).pipe(Effect.exit)),
          scenario.expected,
        );
      }

      const remote = yield* provider(() => ({
        status: 200,
        body: response([call([{ type: "screenshot" }])]),
      }));

      assert.strictEqual(code(yield* run(page, remote.service, 1).pipe(Effect.exit)), "MaxTurns");
      assert.strictEqual(remote.requests.length, 1);
    }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  it.live("keeps the exact one page and rejects a changed viewport before making a request", () =>
    Effect.gen(function* () {
      const { page } = yield* fixture;
      const browser = yield* Browser;
      const remote = yield* provider(() => ({ status: 200, body: response([]) }));
      const second = yield* browser.newPage(origin + "/markets/btc");

      assert.strictEqual(code(yield* run(page, remote.service).pipe(Effect.exit)), "PageChanged");
      yield* second.close;
      yield* Effect.promise(() => page.playwright.setViewportSize({ width: 640, height: 360 }));
      assert.strictEqual(code(yield* run(page, remote.service).pipe(Effect.exit)), "ImageSize");
      assert.strictEqual(remote.requests.length, 0);
    }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );

  it.live(
    "reads historical frames once without exposing the outline or accessing a current page",
    () =>
      Effect.gen(function* () {
        const { page } = yield* fixture;
        const captured = yield* Moment.capture(page, { frames: 1 });

        const moment = new Moment.Moment({
          ...captured,
          snapshot: new Snapshot({ ...captured.snapshot, text: secret }),
        });

        const remote = yield* provider(() => ({ status: 200, body: response([message()]) }));

        yield* page.close;

        const result = yield* Native.understand(Native.defaults, {
          moment,
          instructions: "Read the historical quote.",
          schema: Answer,
          onUsage: () => Effect.void,
        }).pipe(Effect.provideService(Native.NativeTransport, remote.service));

        assert.strictEqual(result.answer.orderId, "ORD-1001");
        assert.strictEqual(result.steps, 1);
        assert.strictEqual(remote.requests.length, 1);
        assert.notInclude(JSON.stringify(remote.requests[0]), secret);
        assert.include(JSON.stringify(remote.requests[0]), '"detail":"original"');

        const actions = yield* provider(() => ({
          status: 200,
          body: response([call([{ type: "screenshot" }])]),
        }));

        const exit = yield* Native.understand(Native.defaults, {
          moment,
          instructions: "Read.",
          schema: Answer,
          onUsage: () => Effect.void,
        }).pipe(Effect.provideService(Native.NativeTransport, actions.service), Effect.exit);

        assert.strictEqual(code(exit), "HistoricalActionRequested");
        assert.strictEqual(actions.requests.length, 1);
      }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );
});
