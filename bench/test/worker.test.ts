import { mkdtemp, readFile, rm } from "node:fs/promises";
// Real isolated Node/Chromium workers; the only model endpoint is a local scripted HTTP fixture.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Schema, Stream } from "effect";
import * as Agent from "effect-browser/Agent";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel, type Response } from "effect/ai";
import { chromium } from "playwright-core";

import * as Native from "../Native.ts";
import * as Perception from "../Perception.ts";
import * as Protocol from "../Protocol.ts";
import * as Sites from "../Sites.ts";
import { fixtureGuard, isolateNetwork } from "../worker-main.ts";
import * as Worker from "../Worker.ts";

const capability = "a".repeat(48);
const canary = "PRIVATE-WORKER-CREDENTIAL-CANARY";

const config: Worker.Config = {
  task: "quote-table",
  arm: 5,
  seed: 17,
  provider: "local",
  apiUrl: "http://127.0.0.1:1/" + capability,
  model: "fixture/local",
  reasoning: "none",
  maxOutputTokens: 4096,
  endpoint: null,
  perceptionOrigin: null,
  scripted: true,
};

class TestError extends Schema.TaggedError<TestError>()("WorkerTestError", {}) {}

const server = (handler: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const service = createServer(handler);

          service.once("error", reject);
          service.listen(0, "127.0.0.1", () => resolve(service));
        }),
      catch: () => new TestError(),
    }),
    (service) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            service.close(() => resolve());
            service.closeAllConnections();
          }),
      ),
  );

const origin = (service: ReturnType<typeof createServer>) => {
  const address = service.address();

  if (address === null || typeof address === "string") throw new Error("Missing test address");

  return "http://127.0.0.1:" + address.port;
};

const hostedFixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "worker-cdp-")),
      catch: () => new TestError(),
    }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );

  const context = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        chromium.launchPersistentContext(directory, { args: ["--remote-debugging-port=0"] }),
      catch: () => new TestError(),
    }),
    (owned) => Effect.promise(() => owned.close()),
  );

  const port = yield* Effect.tryPromise({
    try: async () =>
      Number((await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]),
    catch: () => new TestError(),
  });

  const page = context.pages()[0] ?? (yield* Effect.promise(() => context.newPage()));

  yield* Effect.promise(() => page.setContent("<p>" + canary + "</p>"));

  return { context, page, endpoint: "http://127.0.0.1:" + port };
});

describe("isolated benchmark workers", () => {
  it.live(
    "denies model navigation and link clicks before dispatch and returns normal tool receipts",
    () =>
      Effect.gen(function* () {
        let requests = 0;

        const outside = yield* server((request, response) => {
          requests += 1;
          request.resume();
          response.end("escaped");
        });

        const external = origin(outside);
        const browser = yield* Chromium.open({ guard: fixtureGuard });

        yield* isolateNetwork(browser);
        yield* Effect.promise(() =>
          browser.context.route(Sites.origin + "/network", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: '<a href="' + external + '/link">Outside</a>',
            }),
          ),
        );
        const page = yield* browser.page;

        yield* page.goto(Sites.origin + "/network");
        const snapshot = yield* page.snapshot();
        const ref = /\[ref=(e\d+)\]/.exec(snapshot.text)?.[1];

        assert.isDefined(ref);

        const turns: ReadonlyArray<ReadonlyArray<Response.PartEncoded>> = [
          [
            {
              type: "tool-call",
              id: "navigate",
              name: "browser_navigate",
              params: { url: external + "/navigate" },
            },
          ],
          [{ type: "tool-call", id: "click", name: "browser_click", params: { ref } }],
          [{ type: "tool-call", id: "done", name: "done", params: { answer: "finished" } }],
        ];

        let turn = 0;
        const steps: Array<Agent.Step> = [];

        const model = yield* LanguageModel.make({
          generateText: () =>
            Effect.sync(() => [
              ...turns[turn++]!,
              {
                type: "finish" as const,
                reason: "tool-calls" as const,
                usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
              },
            ]),
          streamText: () => Stream.empty,
        });

        const result = yield* Agent.run("Try the requested navigation and link.", {
          maxSteps: 3,
          onStep: (step) =>
            Effect.sync(() => {
              steps.push(step);
            }),
        }).pipe(
          Effect.provideService(Browser, browser),
          Effect.provideService(LanguageModel.LanguageModel, model),
        );

        assert.strictEqual(result.answer, "finished");
        for (const step of steps.slice(0, 2)) {
          assert.lengthOf(step.results, 1);
          assert.isTrue(step.results[0]!.isFailure);
          assert.include(String(step.results[0]!.result), "restricted to its local fixture");
        }

        const rejected = (yield* browser.recentEvents).filter(
          (event) => event._tag === "Action" && !event.ok,
        );

        assert.lengthOf(rejected, 2);
        assert.isTrue(rejected.every((event) => event._tag === "Action" && !event.dispatched));
        assert.strictEqual(page.playwright.url(), Sites.origin + "/network");
        assert.strictEqual(requests, 0);
      }).pipe(Effect.scoped),
  );

  it.live(
    "blocks script, subresource, popup, WebSocket and redirect escapes after fixture teardown",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        let upgrades = 0;

        const outside = yield* server((request, response) => {
          requests += 1;
          request.resume();
          response.end("escaped");
        });

        outside.on("upgrade", (_request, socket) => {
          upgrades += 1;
          socket.destroy();
        });
        const external = origin(outside);
        const browser = yield* Chromium.open({ guard: fixtureGuard });

        yield* isolateNetwork(browser);
        const page = yield* browser.page;
        const owned = Sites.origin + "/other-owner";

        yield* Effect.promise(() =>
          browser.context.route(owned, (route) =>
            route.fulfill({ contentType: "text/plain", body: "retained" }),
          ),
        );
        const blocked: Array<string> = [];

        browser.context.on("requestfailed", (request) => {
          if (request.url().startsWith(external)) blocked.push(request.failure()?.errorText ?? "");
        });
        yield* Effect.gen(function* () {
          yield* Sites.serve(browser);
          yield* page.goto(Sites.origin + Sites.routes.quotes);

          const escaped = yield* Effect.promise(() =>
            page.playwright.evaluate(
              async (url) =>
                fetch(url + "/during").then(
                  () => true,
                  () => false,
                ),
              external,
            ),
          );

          assert.isFalse(escaped);
        }).pipe(Effect.scoped);

        // The fixture's release must remove only its own handler. Both the independent local
        // route and the worker's earlier catch-all must still be present.
        const after = yield* Effect.promise(() =>
          page.playwright.evaluate(
            async ({ external, owned }) => ({
              retained: await fetch(owned).then((response) => response.text()),
              fetched: await fetch(external + "/after").then(
                () => true,
                () => false,
              ),
              image: await new Promise<boolean>((resolve) => {
                const image = new Image();

                image.onload = () => resolve(true);
                image.onerror = () => resolve(false);
                image.src = external + "/image";
              }),
              socket: await new Promise<boolean>((resolve) => {
                const socket = new WebSocket(external.replace("http:", "ws:") + "/socket");

                socket.onopen = () => {
                  socket.close();
                  resolve(true);
                };
                socket.onclose = () => resolve(false);
                socket.onerror = () => resolve(false);
              }),
            }),
            { external, owned },
          ),
        );

        assert.deepStrictEqual(after, {
          retained: "retained",
          fetched: false,
          image: false,
          socket: false,
        });
        yield* Effect.promise(() =>
          Promise.all([
            browser.context.waitForEvent("requestfailed", {
              predicate: (request) => request.url() === external + "/popup",
            }),
            page.playwright.evaluate((url) => {
              window.open(url + "/popup", "_blank");
            }, external),
          ]),
        );
        yield* Effect.promise(() =>
          Promise.all([
            browser.context.waitForEvent("requestfailed", {
              predicate: (request) => request.url() === external + "/redirect",
            }),
            page.playwright.evaluate((url) => {
              location.href = url + "/redirect";
            }, external),
          ]),
        );
        assert.lengthOf(blocked, 5);
        assert.isTrue(blocked.every((error) => error.includes("ERR_BLOCKED_BY_CLIENT")));
        assert.strictEqual(requests, 0);
        assert.strictEqual(upgrades, 0);
      }).pipe(Effect.scoped),
  );

  it.live("counts only guard-approved model action attempts in the actual isolated worker", () =>
    Effect.gen(function* () {
      let outsideRequests = 0;

      const outside = yield* server((request, response) => {
        outsideRequests += 1;
        request.resume();
        response.end("escaped");
      });

      let calls = 0;
      let receipt = "";

      const broker = yield* server((request, response) => {
        const index = ++calls;
        const chunks: Array<Uint8Array> = [];

        request.on("data", (chunk: Uint8Array) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          if (index === 2) receipt = Buffer.concat(chunks).toString("utf8");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "fixture",
              object: "chat.completion",
              created: 1,
              model: "fixture/local",
              system_fingerprint: null,
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  logprobs: null,
                  message: {
                    role: "assistant",
                    content: null,
                    refusal: null,
                    tool_calls: [
                      {
                        id: "turn-" + index,
                        type: "function",
                        function:
                          index === 1
                            ? {
                                name: "browser_navigate",
                                arguments: JSON.stringify({ url: origin(outside) + "/escaped" }),
                              }
                            : {
                                name: "done",
                                arguments: JSON.stringify({ answer: { orderId: "WRONG" } }),
                              },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            }),
          );
        });
      });

      const result = yield* Worker.run(
        {
          ...config,
          task: "chart-trade",
          scripted: false,
          apiUrl: origin(broker) + "/" + capability,
        },
        { timeoutMillis: 30_000 },
      );

      assert.strictEqual(result.result.status, "completed");
      assert.isFalse(result.result.pass);
      assert.strictEqual(result.result.steps, 2);
      assert.strictEqual(result.result.actions, 0);
      assert.include(receipt, "restricted to its local fixture");
      assert.strictEqual(outsideRequests, 0);
      assert.strictEqual(calls, 2);
    }).pipe(Effect.scoped),
  );

  it("allows only runtime environment and sets protocol capture before process imports", () => {
    const result = Worker.environment({
      PATH: "/bin",
      HOME: "/tmp/home",
      TMPDIR: "/tmp",
      PLAYWRIGHT_BROWSERS_PATH: "/tmp/browsers",
      OPENROUTER_API_KEY: canary,
      OPENAI_API_KEY: canary,
      BROWSERBASE_API_KEY: canary,
      AWS_SECRET_ACCESS_KEY: canary,
      HTTP_PROXY: canary,
      NODE_OPTIONS: canary,
      LD_PRELOAD: canary,
      DEBUG: "unsafe:*",
      DEBUG_FILE: "/tmp/private-log",
      MAX_LOG_LENGTH: "2",
    });

    assert.deepStrictEqual(result, {
      PATH: "/bin",
      HOME: "/tmp/home",
      TMPDIR: "/tmp",
      PLAYWRIGHT_BROWSERS_PATH: "/tmp/browsers",
      ...Protocol.environment,
    });
    assert.notInclude(JSON.stringify(result), canary);
  });

  it.effect(
    "rejects mismatched ownership and non-loopback broker configuration before spawning",
    () =>
      Effect.gen(function* () {
        const error = yield* Worker.run({ ...config, provider: "browserbase" }).pipe(Effect.flip);

        assert.strictEqual(error.code, "InvalidConfig");
        assert.isFalse(
          Schema.is(Worker.Config)({ ...config, apiUrl: "https://provider.example/" + canary }),
        );
        const timeout = yield* Worker.run(config, { timeoutMillis: 0 }).pipe(Effect.flip);

        assert.strictEqual(timeout.code, "InvalidConfig");
      }),
  );

  it.live(
    "runs an actual free scripted task with aggregate protocol and no raw configuration in its result",
    () =>
      Effect.gen(function* () {
        const result = yield* Worker.run({ ...config, model: canary }, { timeoutMillis: 30_000 });

        assert.strictEqual(result.result.status, "completed");
        assert.isTrue(result.result.pass);
        assert.strictEqual(result.result.steps, 0);
        assert.strictEqual(result.result.code, null);
        assert.isNull(result.result.actions);
        assert.deepStrictEqual(result.result.perception, {
          parseCalls: 0,
          groundCalls: 0,
          millis: 0,
          failures: 0,
        });
        assert.strictEqual(result.process.exitCode, 0);
        assert.isFalse(result.process.forced);
        assert.isTrue(result.protocol.finished);
        assert.isTrue(result.protocol.observed);
        assert.isAbove(result.protocol.commands, 20);
        assert.isAbove(result.protocol.commandsByDomain.page, 0);
        assert.isAbove(result.protocol.commandsByDomain.runtime, 0);
        assert.isAbove(result.protocol.bytes.sent, 0);
        assert.isAbove(result.result.timings.prepareMillis, 0);
        assert.notInclude(JSON.stringify(result), canary);
        assert.notInclude(JSON.stringify(result), capability);
        assert.notInclude(JSON.stringify(result), "bench.test");
      }),
  );

  it.live(
    "uses the actual SDK through the private loopback broker and keeps grading failures distinct",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        let authorization: string | undefined;
        let route: string | undefined;

        const service = yield* server((request, response) => {
          calls += 1;
          authorization = request.headers.authorization;
          route = request.url;
          request.resume();
          request.on("end", () => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: "fixture",
                object: "chat.completion",
                created: 1,
                model: "fixture/local",
                system_fingerprint: null,
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    logprobs: null,
                    message: {
                      role: "assistant",
                      content: JSON.stringify({
                        ticker: "WRONG",
                        price: 1,
                        change1h: 0,
                        change24h: 0,
                        column: "24h",
                        table: "Spot markets",
                      }),
                      refusal: null,
                    },
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
              }),
            );
          });
        });

        const result = yield* Worker.run(
          { ...config, scripted: false, apiUrl: origin(service) + "/" + capability },
          { timeoutMillis: 30_000 },
        );

        assert.strictEqual(calls, 1);
        assert.isUndefined(authorization);
        assert.strictEqual(route, "/" + capability + "/chat/completions");
        assert.strictEqual(result.result.status, "completed");
        assert.isFalse(result.result.pass);
        assert.strictEqual(result.result.steps, 1);
        assert.deepStrictEqual(result.result.usage, {
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 0,
        });
        assert.strictEqual(result.result.actions, 0);
        assert.isAbove(result.result.timings.runMillis, 0);
        assert.isAtLeast(result.result.phaseMarks.run!, result.result.phaseMarks.prepare!);
        assert.isAtLeast(result.result.phaseMarks.grade!, result.result.phaseMarks.run!);
        assert.notInclude(JSON.stringify(result), capability);
      }).pipe(Effect.scoped),
  );

  it.live("counts actual parser calls and failures without inventing inference work", () =>
    Effect.gen(function* () {
      let calls = 0;

      const runtime = {
        python: "fixture",
        torch: "fixture",
        transformers: "fixture",
        ocr: "fixture",
      };

      const perception = yield* server((request, response) => {
        const receive = async () => {
          const chunks: Array<Uint8Array> = [];

          for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(chunk);

          const observation = Schema.decodeSync(Schema.fromJsonString(Perception.Observation))(
            Buffer.concat(chunks).toString("utf8"),
          );

          calls += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              calls === 1
                ? {
                    observation,
                    provenance: {
                      modelId: "microsoft/OmniParser-v2.0",
                      revision: Perception.omniRevision,
                      captionProcessorRevision: Perception.captionProcessorRevision,
                      captionCodeRevision: Perception.captionCodeRevision,
                      preprocessing: Perception.parsePreprocessing,
                      ocrDataSha256: Perception.ocrDataSha256,
                      device: "cpu",
                      runtime,
                    },
                    elements: [],
                  }
                : {},
            ),
          );
        };

        void receive().catch(() => response.destroy());
      });

      const model = yield* server((request, response) => {
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "fixture",
              object: "chat.completion",
              created: 1,
              model: "fixture/local",
              system_fingerprint: null,
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  logprobs: null,
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      ticker: "WRONG",
                      price: 1,
                      change1h: 0,
                      change24h: 0,
                      column: "24h",
                      table: "Spot markets",
                    }),
                    refusal: null,
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            }),
          );
        });
      });

      const parsed = {
        ...config,
        arm: 3 as const,
        scripted: false,
        perceptionOrigin: origin(perception),
        apiUrl: origin(model) + "/" + capability,
      };

      const succeeded = yield* Worker.run(parsed, { timeoutMillis: 30_000 });
      const failed = yield* Worker.run(parsed, { timeoutMillis: 30_000 });

      assert.strictEqual(succeeded.result.status, "completed");
      assert.strictEqual(succeeded.result.perception.parseCalls, 1);
      assert.strictEqual(succeeded.result.perception.groundCalls, 0);
      assert.strictEqual(succeeded.result.perception.failures, 0);
      assert.isAbove(succeeded.result.perception.millis, 0);
      assert.strictEqual(failed.result.code, "InvalidOutput");
      assert.strictEqual(failed.result.steps, 0);
      assert.strictEqual(failed.result.perception.parseCalls, 1);
      assert.strictEqual(failed.result.perception.failures, 1);
      assert.isAbove(failed.result.perception.millis, 0);
      assert.strictEqual(calls, 2);
    }).pipe(Effect.scoped),
  );

  it.live(
    "uses only the accounted native reply envelope and preserves closed broker failures",
    () =>
      Effect.gen(function* () {
        let calls = 0;

        const service = yield* server((request, response) => {
          const receive = async () => {
            const chunks: Array<Uint8Array> = [];

            for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(chunk);

            const body = Schema.decodeSync(Schema.fromJsonString(Native.RequestSchema))(
              Buffer.concat(chunks).toString("utf8"),
            );

            assert.strictEqual(body.model, config.model);
            assert.strictEqual(request.url, "/" + capability + "/responses");
            assert.isUndefined(request.headers.authorization);
            calls += 1;
            response.writeHead(calls === 1 ? 200 : 402, { "content-type": "application/json" });
            response.end(
              JSON.stringify(
                calls === 1
                  ? {
                      status: 200,
                      body: {
                        status: "completed",
                        output: [
                          {
                            type: "message",
                            role: "assistant",
                            content: [
                              {
                                type: "output_text",
                                text: JSON.stringify({
                                  ticker: "WRONG",
                                  price: 1,
                                  change1h: 0,
                                  change24h: 0,
                                  column: "24h",
                                  table: "Spot markets",
                                }),
                              },
                            ],
                          },
                        ],
                      },
                      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
                    }
                  : { code: "UnpricedResponse" },
              ),
            );
          };

          void receive().catch(() => response.destroy());
        });

        const native = {
          ...config,
          arm: 6 as const,
          scripted: false,
          apiUrl: origin(service) + "/" + capability,
        };

        const completed = yield* Worker.run(native, { timeoutMillis: 30_000 });
        const rejected = yield* Worker.run(native, { timeoutMillis: 30_000 });

        assert.strictEqual(completed.result.status, "completed");
        assert.strictEqual(completed.result.steps, 1);
        assert.strictEqual(completed.result.usage?.outputTokens, 20);
        assert.strictEqual(rejected.result.status, "failed");
        assert.strictEqual(rejected.result.code, "UnpricedResponse");
        assert.strictEqual(rejected.result.steps, 0);
        assert.strictEqual(calls, 2);
      }).pipe(Effect.scoped),
  );

  it.live("times out its own process group while a sibling worker completes", () =>
    Effect.gen(function* () {
      const [stopped, sibling] = yield* Effect.all(
        [
          Worker.run({ ...config, task: "tumble-win" }, { timeoutMillis: 3000 }),
          Worker.run(config, { timeoutMillis: 30_000 }),
        ],
        { concurrency: 2 },
      );

      assert.strictEqual(stopped.result.status, "timed-out");
      assert.strictEqual(stopped.result.code, "Timeout");
      assert.isFalse(stopped.result.pass);
      assert.isTrue(stopped.protocol.finished);
      assert.strictEqual(stopped.process.exitCode, 0);
      assert.isAbove(stopped.result.timings.prepareMillis, 0);
      assert.isBelow(stopped.result.timings.totalMillis, 15_000);
      assert.strictEqual(sibling.result.status, "completed");
      assert.isTrue(sibling.result.pass);
      assert.isFalse(sibling.process.forced);
    }),
  );

  it.live("caller interruption waits for owned cleanup without interrupting another worker", () =>
    Effect.gen(function* () {
      const slow = yield* Worker.run({ ...config, task: "tumble-win" }).pipe(Effect.forkChild);
      const sibling = yield* Worker.run(config, { timeoutMillis: 30_000 }).pipe(Effect.forkChild);

      yield* Effect.sleep("1500 millis");
      yield* Fiber.interrupt(slow);
      const stopped = yield* Fiber.await(slow);
      const completed = yield* Fiber.join(sibling);

      assert.strictEqual(stopped._tag, "Failure");
      assert.strictEqual(completed.result.status, "completed");
      assert.isTrue(completed.result.pass);
    }),
  );

  it.live("closes only its fresh CDP trial context and leaves the parent-owned browser alive", () =>
    Effect.gen(function* () {
      const hosted = yield* hostedFixture;
      const connected = hosted.context.browser();
      const before = connected?.contexts().length;

      const result = yield* Worker.run(
        { ...config, provider: "browserbase", endpoint: hosted.endpoint },
        { timeoutMillis: 30_000 },
      );

      assert.strictEqual(result.result.status, "completed");
      assert.isTrue(result.result.pass);
      assert.isTrue(connected?.isConnected());
      assert.strictEqual(connected?.contexts().length, before);
      assert.strictEqual(
        yield* Effect.promise(() => hosted.page.locator("p").textContent()),
        canary,
      );
      assert.strictEqual(result.protocol.knownUnloggedShutdownReplies, 0);
      assert.notInclude(JSON.stringify(result), hosted.endpoint);
      assert.notInclude(JSON.stringify(result), canary);
    }).pipe(Effect.scoped),
  );
});
