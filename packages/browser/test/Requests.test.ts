// Requested audit stage 6: browser-wide policy reaches redirect hops and new tabs, failing closed.
import { createServer } from "node:http";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Chromium from "../src/providers/Chromium.ts";

it.live("guards every redirect hop and records a redacted refusal", () =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const instance = createServer((request, response) => {
          seen.push(request.url ?? "");
          if (request.url === "/start") {
            response.writeHead(302, { location: "/blocked?token=private" });
            response.end();
          } else {
            response.setHeader("Set-Cookie", "sessionid=never-disclosed; Path=/; HttpOnly");
            response.end("<h1>arrived</h1>");
          }
        });

        instance.listen(0, "127.0.0.1", () => resume(Effect.succeed(instance)));
      }),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
    );

    const address = server.address();

    assert.isNotNull(address);
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const browser = yield* Chromium.open({
      requests: {
        patterns: ["*blocked*"],
        decide: () =>
          Effect.succeed({
            _tag: "Refused",
            reason: "refused http://fixture.invalid/?token=private",
          }),
      },
      viewport: { width: 900, height: 600 },
    });

    const page = yield* browser.newPage();

    yield* Effect.result(page.goto(`http://127.0.0.1:${port}/start`));
    assert.deepStrictEqual(seen, ["/start"]);

    const refused = (yield* browser.recentEvents).filter(
      (event) => event._tag === "RequestRefused",
    );

    assert.strictEqual(refused.length, 1);
    assert.notInclude(JSON.stringify(refused), "private");
    const second = yield* browser.newPage();

    assert.deepStrictEqual(yield* second.viewport, { width: 900, height: 600 });
    const url = `http://127.0.0.1:${port}/cookies`;

    assert.isFalse(yield* browser.hasCookie({ name: "sessionid", url }));
    yield* second.goto(url);
    assert.isTrue(yield* browser.hasCookie({ name: "sessionid", url }));
    assert.isFalse(yield* browser.hasCookie({ name: "other", url }));
    assert.notInclude(JSON.stringify(yield* browser.recentEvents), "never-disclosed");
  }).pipe(Effect.scoped),
);
