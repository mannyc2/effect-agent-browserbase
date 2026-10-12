// #278: readiness belongs to the next step, never to acknowledged terminal input.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Exit } from "effect";

import { Browser } from "../src/Browser.ts";
import { Subject } from "../src/BrowserEvent.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Plan from "../src/Plan.ts";

const named = (name: string) => new Subject({ role: "button", name, tag: "button", context: {} });
const settle = { still: "content", quietMillis: 300, timeout: "1 second" } as const;

const site = Effect.fnUntraced(function* () {
  const requests: Array<string> = [];

  const server = createServer((request, response) => {
    const path = request.url ?? "/";

    requests.push(path);
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<title>Settle</title><h1>Settle</h1><p id="status">Ready</p>
      <button id="buy">Buy</button><button id="save">Save</button><script>
      let ticks = 0;
      const live = () => setInterval(() => statusText.textContent = 'Value '+(++ticks), 20);
      const statusText = document.getElementById('status');
      document.getElementById('buy').onclick = () => { fetch('/bought'); live(); };
      document.getElementById('save').onclick = () => {
        statusText.textContent = 'Saving';
        setTimeout(() => fetch('/saved').then(() => statusText.textContent = 'Saved'), 250);
      };
      ${path === "/live" ? "live();" : ""}
      </script>`);
  });

  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return { url: (path: string) => origin + path, requests };
});

const open = Effect.fnUntraced(function* (url?: string) {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(url), (page) => Effect.ignore(page.close));
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(30) })(
  "Plan readiness",
  (it) => {
    it.effect("returns acknowledged final input while the resulting page keeps changing", () =>
      Effect.gen(function* () {
        const fixture = yield* site();
        const page = yield* open();
        const url = fixture.url("/shop");

        const plan = Plan.Plan.new([
          new Plan.Step({ action: "navigate", url, target: url }),
          new Plan.Step({ action: "click", url, subject: named("Buy") }),
        ]);

        yield* Plan.take(page, plan, 0, { settle });
        const result = yield* Plan.take(page, plan, 1, { settle }).pipe(Effect.exit);

        assert.strictEqual(fixture.requests.filter((path) => path === "/bought").length, 1);
        assert.isTrue(Exit.isSuccess(result), "acknowledged input needs its receipt");
        if (Exit.isSuccess(result)) assert.strictEqual(result.value.outcome, "taken");
        const refused = yield* page.ready(settle).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(refused), "the final page remains live");
      }),
    );

    it.effect(
      "opens a live page without a final wait and refuses its next click before input",
      () =>
        Effect.gen(function* () {
          const fixture = yield* site();
          const page = yield* open();
          const url = fixture.url("/live");
          const opening = new Plan.Step({ action: "navigate", url, target: url });
          const receipt = yield* Plan.take(page, Plan.Plan.new([opening]), 0, { settle });

          assert.strictEqual(receipt.outcome, "taken");

          const error = yield* Plan.take(
            page,
            Plan.Plan.new([
              opening,
              new Plan.Step({ action: "click", url, subject: named("Buy") }),
            ]),
            1,
            { settle },
          ).pipe(Effect.flip);

          assert.strictEqual(error.input, "unsent");
          assert.strictEqual(error.reason._tag, "BrowserError");
          assert.isFalse(fixture.requests.includes("/bought"));
        }),
    );

    for (const action of ["navigate", "back", "reload"] as const)
      it.effect(`lets a prior debounced save complete before a later ${action}`, () =>
        Effect.gen(function* () {
          const fixture = yield* site();
          const previous = fixture.url("/previous");
          const form = fixture.url("/form");

          const destination =
            action === "back" ? previous : action === "reload" ? form : fixture.url("/elsewhere");

          const page = yield* open(previous);

          const receipts = yield* Plan.replay(
            page,
            Plan.Plan.new([
              new Plan.Step({ action: "navigate", url: form, target: form }),
              new Plan.Step({ action: "click", url: form, subject: named("Save") }),
              new Plan.Step({ action, url: destination, target: destination }),
            ]),
            { settle },
          );

          assert.deepStrictEqual(
            receipts.map(({ outcome }) => outcome),
            ["taken", "taken", "taken"],
          );
          assert.strictEqual(fixture.requests.filter((path) => path === "/saved").length, 1);
          assert.strictEqual(yield* page.url, destination);
        }),
      );
  },
);
