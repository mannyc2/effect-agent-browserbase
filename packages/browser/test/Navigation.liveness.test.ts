// beta.11's tracked navigation/load waits can strand input authority after their caller times out.
// The requested native regression must keep correction, suspension and a prepared cut live.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, it } from "@effect/vitest";
import { Effect, Exit, Option, Scope } from "effect";

import * as Chromium from "../src/Chromium.ts";
import * as Stage from "../src/Stage.ts";

const site = Effect.gen(function* () {
  const requests: Array<string> = [];

  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        if (request.url === "/hang") return;

        const answer = () => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end('<h1>Known document</h1><a href="/hang">Hang</a><input autofocus>');
        };

        if (request.url === "/slow") setTimeout(answer, 3000).unref();
        else answer();
      });

      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

  const { port } = server.address() as AddressInfo;

  return { url: (path: string) => `http://127.0.0.1:${port}${path}`, requests };
});

for (const operation of ["hanging goto", "slow goto", "hanging click"] as const)
  it.live(`${operation} releases navigation waits without stranding native authority`, () =>
    Effect.gen(function* () {
      const fixture = yield* site;

      const browser = yield* Chromium.open({
        actionTimeout: "300 millis",
        navigationTimeout: "300 millis",
      });

      const page = yield* browser.newPage(fixture.url("/known"));
      const other = yield* browser.newPage(fixture.url("/known"));
      const stage = yield* Stage.make();

      yield* stage.present(page);
      const cue = yield* stage.cue(other);

      yield* cue.ready;
      const path = operation === "slow goto" ? "/slow" : "/hang";
      const [link] = yield* page.find({ role: "link", name: "Hang" });

      const action =
        operation === "hanging click" ? page.click(link?.ref ?? "") : page.goto(fixture.url(path));

      const failure = yield* Effect.flip(action);

      assert.strictEqual(failure.reason._tag, "Timeout");
      assert.isTrue(failure.dispatched);
      assert.strictEqual(fixture.requests.filter((request) => request === path).length, 1);
      if (operation === "hanging click") {
        const blocked = yield* Effect.flip(page.type("blocked"));

        assert.strictEqual(blocked.reason._tag, "Timeout");
        assert.isFalse(blocked.dispatched);
      }
      const holder = yield* Scope.fork(yield* Effect.scope);

      const suspended = yield* browser
        .suspend({ drain: "200 millis" })
        .pipe(Scope.provide(holder), Effect.exit);

      if (Exit.isSuccess(suspended)) {
        assert.strictEqual((yield* Effect.flip(other.press("a"))).reason._tag, "Suspended");
      }
      yield* Scope.close(holder, Exit.void);
      const cut = yield* cue.commit().pipe(Effect.exit);
      const corrected = yield* page.goto(fixture.url("/known")).pipe(Effect.exit);

      assert.deepStrictEqual(
        { suspension: suspended._tag, cut: cut._tag, correction: corrected._tag },
        { suspension: "Success", cut: "Success", correction: "Success" },
      );
      if (Exit.isSuccess(cut)) assert.isBelow(cut.value.latency, 500);
      assert.strictEqual(page.playwright.url(), fixture.url("/known"));
      assert.strictEqual(Option.getOrThrow(yield* stage.current), other);
      yield* page.press("x");
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.locator("input").inputValue()),
        "x",
      );
      assert.isFalse(page.playwright.isClosed());
    }).pipe(Effect.scoped),
  );
