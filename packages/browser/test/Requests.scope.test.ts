// Native policies belong to one context; redirects, first requests and worker egress retain that owner.
import { createServer } from "node:http";

import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { chromium } from "playwright-core";

import * as Browser from "../src/Browser.ts";
import { refuse } from "../src/BrowserError.ts";
import * as TestCdp from "./support/TestCdp.ts";

const site = Effect.acquireRelease(
  Effect.callback<{ server: ReturnType<typeof createServer>; hits: string[] }>((resume) => {
    const hits: string[] = [];

    const server = createServer((request, response) => {
      hits.push(request.url ?? "");
      if (request.url === "/redirect") {
        response.writeHead(307, { location: "/blocked" });
        response.end();
      } else if (request.url === "/frame") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<script>fetch("/blocked").then(() => "went", () => "failed")
          .then(value => parent.postMessage(value, "*"))</script>`);
      } else if (request.url === "/sw.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(`self.addEventListener("message", event => event.waitUntil(fetch("/blocked")
          .then(() => event.source.postMessage("went"), () => event.source.postMessage("failed"))))`);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<h1>native response</h1>");
      }
    });

    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, hits })));
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
).pipe(
  Effect.map(({ server, hits }) => {
    const address = server.address();

    assert.isTrue(typeof address === "object" && address !== null);

    return {
      origin: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
      hits,
    };
  }),
);

const nativeBrowser = Effect.acquireRelease(
  Effect.promise(() => chromium.launch()),
  (browser) => Effect.promise(() => browser.close()),
);

for (const order of [
  [0, 1],
  [1, 0],
] as const)
  it.live(`keeps simultaneous policies isolated with installation order ${order.join(",")}`, () =>
    Effect.gen(function* () {
      const { origin } = yield* site;
      const native = yield* nativeBrowser;
      const seen: string[][] = [[], []];
      const first = yield* Effect.promise(() => native.newContext());
      const second = yield* Effect.promise(() => native.newContext());

      const open = (context: typeof first, index: number) =>
        Browser.make(
          context,
          { provider: `owned-context-${index}` },
          {
            requests: {
              patterns: [`${origin}/*`],
              decide: ({ url }) =>
                Effect.sleep(index === 0 ? "20 millis" : "0 millis").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      seen[index]?.push(url);

                      return url.endsWith("/blocked")
                        ? { _tag: "Refused" as const, reason: "owned request blocked" }
                        : {
                            _tag: "Fulfilled" as const,
                            status: 200,
                            contentType: "text/html",
                            body: `<h1>policy ${index}</h1>`,
                          };
                    }),
                  ),
                ),
            },
          },
        );

      const leading = yield* open(order[0] === 0 ? first : second, order[0]);
      const trailing = yield* open(order[1] === 0 ? first : second, order[1]);
      const a = order[0] === 0 ? leading : trailing;
      const b = order[0] === 0 ? trailing : leading;
      const foreign = yield* Effect.promise(() => native.newContext());
      const unrelated = yield* Effect.promise(() => foreign.newPage());

      yield* Effect.promise(() => unrelated.goto(`${origin}/blocked`));
      assert.strictEqual(
        yield* Effect.promise(() => unrelated.locator("h1").innerText()),
        "native response",
      );
      const pageA = yield* a.newPage(`${origin}/first`);
      const pageB = yield* b.newPage(`${origin}/second`);

      assert.include((yield* pageA.text()).text, "policy 0");
      assert.include((yield* pageB.text()).text, "policy 1");
      assert.strictEqual(
        (yield* a.newPage(`${origin}/blocked`).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* b.newPage(`${origin}/blocked`).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepStrictEqual(seen, [
        [`${origin}/first`, `${origin}/blocked`],
        [`${origin}/second`, `${origin}/blocked`],
      ]);
    }).pipe(Effect.scoped),
  );

it.live("guards popup first requests, nested frames, worker egress and each redirect hop", () =>
  Effect.gen(function* () {
    const { origin } = yield* site;
    const native = yield* nativeBrowser;
    const context = yield* Effect.promise(() => native.newContext());
    const seen: string[] = [];

    const browser = yield* Browser.make(
      context,
      { provider: "owned-target-fixture" },
      {
        requests: {
          patterns: [`${origin}/*`],
          decide: ({ url }) =>
            Effect.sync(() => {
              seen.push(url);

              return url.endsWith("/blocked")
                ? { _tag: "Refused" as const, reason: `refused ${url}?token=private` }
                : { _tag: "Allowed" as const };
            }),
        },
      },
    );

    const publicPage = yield* browser.newPage(origin);
    const page = context.pages()[0];

    assert.isDefined(page);
    if (page === undefined) return;

    const popup = yield* Effect.promise(async () => {
      const opened = context.waitForEvent("page");

      await page.evaluate((url) => {
        window.open(url);
      }, `${origin}/blocked`);

      return opened;
    });

    yield* Effect.promise(() => popup.waitForLoadState().catch(() => undefined));
    assert.notInclude(
      yield* Effect.promise(() => popup.locator("body").innerText()),
      "native response",
    );

    const frames = yield* Effect.promise(() =>
      page.evaluate(
        (url) =>
          new Promise<string>((resolve) => {
            const frame = document.createElement("iframe");

            frame.onload = () => resolve(frame.contentDocument?.body.textContent ?? "blocked");
            frame.src = url;
            document.body.append(frame);
          }),
        `${origin}/blocked`,
      ),
    );

    assert.notInclude(frames, "native response");
    assert.isTrue(
      (yield* publicPage.recentEvents).some(
        (event) =>
          event._tag === "RequestRefused" &&
          event.page === publicPage.id &&
          event.url.endsWith("/blocked"),
      ),
      "an iframe refusal belongs to its containing public page",
    );

    const worker = yield* Effect.promise(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register("/sw.js");

        await navigator.serviceWorker.ready;

        return new Promise<unknown>((resolve) => {
          navigator.serviceWorker.addEventListener("message", (event) => resolve(event.data), {
            once: true,
          });
          registration.active?.postMessage("go");
        });
      }),
    );

    assert.strictEqual(worker, "failed");
    const redirected = yield* browser.newPage(`${origin}/redirect`).pipe(Effect.result);

    assert.strictEqual(redirected._tag, "Failure");
    assert.isAtLeast(seen.filter((url) => url.endsWith("/blocked")).length, 4);
    assert.notInclude(JSON.stringify(yield* browser.recentEvents), "private");
  }).pipe(Effect.scoped),
);

it.live.each(["typed", "defect", "timeout", "reply"] as const)(
  "refuses and loses authority when its policy ends in %s",
  (failure) =>
    Effect.gen(function* () {
      const { origin, hits } = yield* site;
      const native = yield* nativeBrowser;
      const context = yield* Effect.promise(() => native.newContext());

      const faults = yield* TestCdp.make();

      if (failure === "reply")
        faults.rule(
          { channel: "browser", method: "Fetch.continueRequest" },
          { _tag: "Fail", error: new Error("private protocol failure") },
        );

      const browser = yield* faults.provide(
        Browser.make(
          context,
          { provider: "policy-failure-fixture" },
          {
            requests: {
              patterns: [`${origin}/*`],
              timeout: "1 second",
              decide: () =>
                failure === "reply"
                  ? Effect.succeed({ _tag: "Allowed" as const })
                  : failure === "timeout"
                    ? Effect.never
                    : failure === "defect"
                      ? Effect.die("private defect")
                      : refuse("requests", "private failure"),
            },
          },
        ),
      );

      const error = yield* browser.newPage(`${origin}/blocked`).pipe(Effect.flip);

      assert.strictEqual(error._tag, "BrowserError");
      assert.strictEqual(
        yield* browser.disconnected.pipe(Effect.timeout("300 millis")),
        "connection",
      );

      const pagesBefore = context.pages().length;

      const cookies = yield* browser
        .hasCookie({ name: "fixture", url: origin })
        .pipe(Effect.result);

      const opening = yield* browser.newPage().pipe(Effect.result);

      assert.strictEqual(cookies._tag, "Failure");
      assert.strictEqual(opening._tag, "Failure");
      if (cookies._tag === "Failure") assert.strictEqual(cookies.failure.reason._tag, "Closed");
      if (opening._tag === "Failure") assert.strictEqual(opening.failure.reason._tag, "Closed");
      assert.strictEqual(context.pages().length, pagesBefore);

      const refused = (yield* browser.recentEvents).filter(
        (event) => event._tag === "RequestRefused",
      );

      assert.strictEqual(refused.length, 1);
      assert.deepStrictEqual(
        refused[0]?.failure,
        failure === "timeout"
          ? { reason: "Timeout", timeoutMillis: 1000 }
          : {
              reason:
                failure === "defect" ? "Threw" : failure === "reply" ? "Failed" : "InvalidRequest",
            },
      );
      assert.include(refused[0]?.reason, failure === "timeout" ? "timed out" : "failed");
      assert.notInclude(JSON.stringify(refused), "private");
      assert.deepStrictEqual(hits, []);
    }).pipe(Effect.scoped),
);

it.live("guards a cross-site out-of-process iframe without inventing a parent page", () =>
  Effect.gen(function* () {
    const { origin, hits } = yield* site;

    const native = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ args: ["--site-per-process"] })),
      (browser) => Effect.promise(() => browser.close()),
    );

    const context = yield* Effect.promise(() => native.newContext());
    const seen: string[] = [];

    const browser = yield* Browser.make(
      context,
      { provider: "oopif-fixture" },
      {
        requests: {
          patterns: [`*://*:${new URL(origin).port}/*`],
          timeout: "1 second",
          decide: ({ url }) =>
            Effect.sync(() => {
              seen.push(url);

              return url.endsWith("/blocked")
                ? { _tag: "Refused" as const, reason: "owned iframe" }
                : { _tag: "Allowed" as const };
            }),
        },
      },
    );

    const page = yield* browser.newPage(origin);

    const result = yield* page
      .act(
        (src) =>
          new Promise<string>((resolve) => {
            addEventListener("message", (event) => resolve(event.data), { once: true });
            document.body.append(Object.assign(document.createElement("iframe"), { src }));
          }),
        {
          arg: `${origin.replace("127.0.0.1", "localhost")}/frame`,
          document: (yield* page.state).document,
          result: Schema.String,
        },
      )
      .pipe(Effect.result);

    assert.strictEqual(result._tag, "Success", "known iframe context remains authoritative");
    if (result._tag === "Success") assert.strictEqual(result.success, "failed");
    assert.isTrue(seen.some((url) => url.endsWith("/blocked")));
    assert.notInclude(hits, "/blocked");

    const session = yield* Effect.acquireRelease(
      Effect.promise(() => native.newBrowserCDPSession()),
      (cdp) => Effect.promise(() => cdp.detach()),
    );

    const targets = yield* Effect.promise(() => session.send("Target.getTargets"));

    assert.isTrue(
      targets.targetInfos.some((target) => target.type === "iframe"),
      "fixture creates an out-of-process iframe",
    );

    const refusal = (yield* browser.recentEvents).find(
      (event) => event._tag === "RequestRefused" && event.url.endsWith("/blocked"),
    );

    assert.isDefined(refusal);
    if (refusal?._tag === "RequestRefused")
      assert.isUndefined(refusal.page, "context proof does not invent a containing page");
    assert.strictEqual(
      (yield* browser.hasCookie({ name: "fixture", url: origin }).pipe(Effect.result))._tag,
      "Success",
    );
  }).pipe(Effect.scoped),
);

it.live("keeps pending and post-loss requests blocked when retiring a timed-out policy", () =>
  Effect.gen(function* () {
    const { origin, hits } = yield* site;
    const native = yield* nativeBrowser;
    const context = yield* Effect.promise(() => native.newContext());
    const page = yield* Effect.promise(() => context.newPage());
    const foreign = yield* Effect.promise(() => native.newContext());
    const untouched = yield* Effect.promise(() => foreign.newPage());
    const owner = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
    const faults = yield* TestCdp.make();

    const browser = yield* faults.provide(
      Browser.make(
        context,
        { provider: "timed-out-retirement-fixture" },
        {
          requests: {
            patterns: [`${origin}/owned*`],
            timeout: "1 second",
            decide: () => Effect.never,
          },
        },
      ).pipe(Scope.provide(owner)),
    );

    yield* Effect.promise(() => page.goto(origin));
    yield* Effect.promise(() =>
      page.evaluate(() => {
        for (let index = 0; index < 4; index++)
          void fetch(`/owned-held-${index}`, { method: "POST", body: "private" }).catch(
            () => undefined,
          );
      }),
    );
    yield* browser.disconnected.pipe(Effect.timeout("3 seconds"));
    yield* Effect.promise(() =>
      page.evaluate(() => {
        void fetch("/owned-after-loss", { method: "POST", body: "private" }).catch(() => undefined);
      }),
    );
    yield* faults.waitUntil(
      (calls) => calls.filter(({ method }) => method === "Fetch.requestPaused").length === 5,
    );
    yield* Effect.yieldNow;
    yield* Scope.close(owner, Exit.void);
    yield* Effect.promise(() => untouched.goto(`${origin}/foreign`));

    assert.isTrue(native.isConnected(), "retirement must preserve the borrowed browser");
    assert.deepStrictEqual(
      hits.filter((url) => url.startsWith("/owned")),
      [],
      "retirement must not release a request the policy never allowed",
    );
  }).pipe(Effect.scoped),
);

it.live("guards existing pages, out-of-process iframes and their nested frames", () =>
  Effect.gen(function* () {
    const { origin, hits } = yield* site;

    const native = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ args: ["--site-per-process"] })),
      (browser) => Effect.promise(() => browser.close()),
    );

    const context = yield* Effect.promise(() => native.newContext());
    const page = yield* Effect.promise(() => context.newPage());
    const foreignOrigin = origin.replace("127.0.0.1", "localhost");

    yield* Effect.promise(() => page.goto(origin));
    yield* Effect.promise(() =>
      page.evaluate(
        (url) =>
          new Promise<void>((resolve) => {
            const frame = document.createElement("iframe");

            frame.onload = () => resolve();
            frame.src = `${url}/old-frame`;
            document.body.append(frame);
          }),
        foreignOrigin,
      ),
    );
    const frame = page.frame({ url: `${foreignOrigin}/old-frame` });

    assert.isNotNull(frame);
    if (frame === null) return;
    yield* Effect.promise(() =>
      frame.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const nested = document.createElement("iframe");

            nested.onload = () => resolve();
            nested.src = "/old-nested";
            document.body.append(nested);
          }),
      ),
    );
    const nested = page.frame({ url: `${foreignOrigin}/old-nested` });

    assert.isNotNull(nested);
    if (nested === null) return;
    const seen: string[] = [];

    const browser = yield* Browser.make(
      context,
      { provider: "existing-frame-fixture" },
      {
        requests: {
          patterns: [`${origin}/owned*`, `${foreignOrigin}/owned*`],
          decide: ({ url }) =>
            Effect.sync(() => {
              seen.push(new URL(url).pathname);

              return { _tag: "Refused" as const, reason: "owned request blocked" };
            }),
        },
      },
    );

    for (const [target, name] of [
      [page, "page"],
      [frame, "frame"],
      [nested, "nested"],
    ] as const) {
      const result = yield* Effect.promise(() =>
        target.evaluate(
          (name) =>
            fetch(`/owned-${name}`, { method: "POST", body: "private" }).then(
              () => "went",
              () => "blocked",
            ),
          name,
        ),
      );

      assert.strictEqual(result, "blocked");
    }
    assert.deepStrictEqual(seen, ["/owned-page", "/owned-frame", "/owned-nested"]);
    assert.deepStrictEqual(
      hits.filter((url) => url.startsWith("/owned")),
      [],
    );
    yield* browser.newPage("about:blank");
  }).pipe(Effect.scoped),
);

for (const foreign of [false, true])
  it.live(
    `settles a 150-request ${foreign ? "foreign" : "owned"} burst without losing authority`,
    () =>
      Effect.gen(function* () {
        const { origin, hits } = yield* site;
        const native = yield* nativeBrowser;
        const context = yield* Effect.promise(() => native.newContext());
        let decisions = 0;

        const browser = yield* Browser.make(
          context,
          { provider: "request-burst-fixture" },
          {
            requests: {
              patterns: [`${origin}/burst*`],
              decide: () =>
                Effect.sync(() => {
                  decisions++;

                  return { _tag: "Allowed" as const };
                }),
            },
          },
        );

        const source = foreign ? yield* Effect.promise(() => native.newContext()) : context;
        const page = yield* Effect.promise(() => source.newPage());

        yield* Effect.promise(() => page.goto(origin));

        const results = yield* Effect.promise(() =>
          page.evaluate(() =>
            Promise.all(
              Array.from({ length: 150 }, (_, index) =>
                fetch(`/burst-${index}`).then(
                  (response) => response.ok,
                  () => false,
                ),
              ),
            ),
          ),
        ).pipe(Effect.timeout("5 seconds"));

        assert.isTrue(results.every(Boolean));
        assert.strictEqual(hits.filter((url) => url.startsWith("/burst")).length, 150);
        assert.strictEqual(decisions, foreign ? 0 : 150);
        yield* browser.newPage("about:blank");
      }).pipe(Effect.scoped),
  );

it.live.each(["abort", "navigate", "close"] as const)(
  "keeps browser authority when a paused request ends through %s",
  (ending) =>
    Effect.gen(function* () {
      const { origin } = yield* site;
      const native = yield* nativeBrowser;
      const context = yield* Effect.promise(() => native.newContext());
      const page = yield* Effect.promise(() => context.newPage());
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const answered = yield* Deferred.make<void>();
      const faults = yield* TestCdp.make();

      faults.observe((call, phase) => {
        if (call.method === "Fetch.continueRequest" && phase === "settled")
          Deferred.doneUnsafe(answered, Effect.void);
      });

      const browser = yield* faults.provide(
        Browser.make(
          context,
          { provider: "cancelled-request-fixture" },
          {
            requests: {
              patterns: [`${origin}/held*`],
              decide: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ _tag: "Allowed" as const }),
                ),
            },
          },
        ),
      );

      yield* Effect.promise(() => page.goto(origin));
      yield* Effect.promise(() =>
        page.evaluate(() => {
          const controller = new AbortController();

          Object.assign(window, { abortRequest: () => controller.abort() });
          void fetch("/held", { signal: controller.signal }).catch(() => undefined);
        }),
      );
      yield* Deferred.await(entered);
      yield* Effect.promise(() =>
        ending === "abort"
          ? page.evaluate(() => Reflect.get(window, "abortRequest")())
          : ending === "navigate"
            ? page.goto(`${origin}/next`)
            : page.close(),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(answered);
      yield* browser.newPage("about:blank");
    }).pipe(Effect.scoped),
);

it.live("retirement awaits an in-flight reply without answering it twice or closing its page", () =>
  Effect.gen(function* () {
    const { origin } = yield* site;
    const native = yield* nativeBrowser;
    const context = yield* Effect.promise(() => native.newContext());
    const page = yield* Effect.promise(() => context.newPage());
    const owner = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
    const faults = yield* TestCdp.make();
    const received = yield* Deferred.make<void>();

    faults.rule(
      { channel: "browser", method: "Fetch.continueRequest" },
      { _tag: "Delay", duration: "500 millis" },
      { phase: "after", times: 1 },
    );
    faults.observe((call, phase) => {
      if (call.method === "Fetch.continueRequest" && phase === "received")
        Deferred.doneUnsafe(received, Effect.void);
    });
    yield* faults.provide(
      Browser.make(
        context,
        { provider: "reply-retirement-fixture" },
        {
          requests: {
            patterns: [`${origin}/held*`],
            decide: () => Effect.succeed({ _tag: "Allowed" }),
          },
        },
      ).pipe(Scope.provide(owner)),
    );
    yield* Effect.promise(() => page.goto(origin));
    yield* Effect.promise(() =>
      page.evaluate(() => {
        void fetch("/held").catch(() => undefined);
      }),
    );
    yield* Deferred.await(received);
    const retiring = yield* Scope.close(owner, Exit.void).pipe(Effect.forkScoped);

    yield* Fiber.join(retiring);
    assert.isFalse(page.isClosed());
    assert.strictEqual(
      faults.calls.filter(({ method }) => method === "Fetch.continueRequest").length,
      1,
    );
    assert.strictEqual(
      faults.calls.filter(({ method }) => method === "Fetch.failRequest").length,
      0,
    );
    yield* Effect.promise(() => page.goto(`${origin}/after-retirement`));
  }).pipe(Effect.scoped),
);

it.live.each(["Allowed", "Fulfilled"] as const)(
  "refuses a pending %s decision after another request revokes authority",
  (decision) =>
    Effect.gen(function* () {
      const { origin, hits } = yield* site;
      const native = yield* nativeBrowser;
      const context = yield* Effect.promise(() => native.newContext());
      const page = yield* Effect.promise(() => context.newPage());
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const browser = yield* Browser.make(
        context,
        { provider: "pending-decision-fixture" },
        {
          requests: {
            patterns: [`${origin}/owned*`],
            decide: ({ url }) =>
              url.endsWith("/owned-revoke")
                ? refuse("requests", "policy failure")
                : Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(
                      decision === "Allowed"
                        ? { _tag: "Allowed" as const }
                        : {
                            _tag: "Fulfilled" as const,
                            status: 200,
                            contentType: "text/plain",
                            body: "too late",
                          },
                    ),
                  ),
          },
        },
      );

      const request = (path: string) =>
        Effect.promise(() =>
          page.evaluate(
            (path) =>
              fetch(path, { method: "POST", body: "private" }).then(
                () => "went",
                () => "blocked",
              ),
            path,
          ),
        );

      yield* Effect.promise(() => page.goto(origin));
      const held = yield* request("/owned-held").pipe(Effect.forkScoped);

      yield* Deferred.await(entered);
      assert.strictEqual(yield* request("/owned-revoke"), "blocked");
      yield* browser.disconnected;
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(held), "blocked");
      assert.deepStrictEqual(
        hits.filter((url) => url.startsWith("/owned")),
        [],
      );
      assert.isTrue(
        (yield* browser.recentEvents).some(
          (event) =>
            event._tag === "RequestRefused" &&
            event.url.endsWith("/owned-held") &&
            event.reason === "request authority has ended",
        ),
      );
    }).pipe(Effect.scoped),
);
