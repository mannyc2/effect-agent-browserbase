import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { Page } from "playwright-core";

import { localBrowser, policy, settle, withProvider } from "../fixtures/LocalBrowser.ts";

const gate = () => {
  let resolve: () => void = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve: () => resolve() };
};

const popupPage = (page: Page) =>
  Effect.promise(() =>
    page.setContent(`<!doctype html>
  <button id=popup onclick="count.textContent=Number(count.textContent)+1;window.open('/next')">Open</button>
  <button id=next onclick="count.textContent=Number(count.textContent)+1">Next</button><span id=count>0</span>`),
  );

for (const maxPages of [1, 2]) {
  it.live(
    `real CDP: close policy with maxPages=${maxPages} closes once and preserves the original page`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* localBrowser;

          yield* withProvider(
            f,
            Effect.gen(function* () {
              const session = yield* BrowserbaseBrowser.open(policy);

              yield* session.navigate({ url: `${f.url}viewport` });
              const [native] = f.nativePages(session.reference.sessionId);

              assert.ok(native);
              yield* popupPage(native);
              const initial = yield* session.status;
              const nativeClosed = gate();
              let closeCalls = 0;

              const pageOpened = (page: Page) => {
                const close = page.close.bind(page);

                page.close = async (options) => {
                  closeCalls++;
                  await close(options);
                  nativeClosed.resolve();
                };
              };

              native.context().on("page", pageOpened);
              try {
                yield* session.click({ selector: "#popup" });
                yield* Effect.promise(() => nativeClosed.promise);
                const state = yield* settle(session.status, (status) => !status.busy);

                expect(state).toMatchObject({
                  phase: "open",
                  generation: initial.generation,
                  unresolvedDispatch: false,
                });
                expect((yield* session.readText({ selector: "#count" })).text).toBe("1");
                expect(yield* session.pages).toHaveLength(1);
                const diagnostics = yield* session.diagnostics;

                const records = diagnostics.records.filter(
                  (record) => record.reason === "popup-overflow",
                );

                expect(records.map((record) => record.disposition)).toEqual(
                  maxPages === 1 ? ["pending", "confirmed"] : [],
                );
                expect(closeCalls).toBe(1);
                yield* session.click({ selector: "#next" });
                expect((yield* session.readText({ selector: "#count" })).text).toBe("2");
              } finally {
                native.context().off("page", pageOpened);
              }
            }),
            { maxPages, popupPolicy: "close" },
          );
          expect(f.releaseIds).toEqual(["session-1"]);
        }),
      ),
  );
}

for (const acknowledge of [true, false]) {
  it.live(
    `real CDP: popup cleanup ${acknowledge ? "acknowledgement releases quarantine" : "timeout remains fenced after a late acknowledgement"}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* localBrowser;
          const ack = gate();
          const closed = gate();
          let calls = 0;

          yield* withProvider(
            f,
            Effect.gen(function* () {
              const session = yield* BrowserbaseBrowser.open(policy);

              yield* session.navigate({ url: `${f.url}viewport` });
              const [native] = f.nativePages(session.reference.sessionId);

              assert.ok(native);
              yield* popupPage(native);
              const initial = yield* session.status;

              const pageOpened = (page: Page) => {
                const close = page.close.bind(page);

                page.close = async (options) => {
                  calls++;
                  await close(options);
                  closed.resolve();
                  await ack.promise;
                };
              };

              native.context().on("page", pageOpened);
              try {
                yield* session.click({ selector: "#popup" });
                yield* Effect.promise(() => closed.promise);
                expect(yield* session.status).toMatchObject({
                  phase: "open",
                  busy: true,
                  generation: initial.generation,
                });
                const blocked = yield* session.click({ selector: "#next" }).pipe(Effect.result);

                expect(blocked).toMatchObject({
                  _tag: "Failure",
                  failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
                });
                expect(yield* Effect.promise(() => native.locator("#count").textContent())).toBe(
                  "1",
                );
                if (!acknowledge) {
                  const state = yield* settle(
                    session.status,
                    (status) => status.phase === "uncertain",
                    4000,
                  );

                  expect(state).toMatchObject({
                    phase: "uncertain",
                    reason: "popup-overflow",
                    unresolvedDispatch: true,
                  });
                  const diagnostics = yield* session.diagnostics;

                  expect(
                    diagnostics.records
                      .filter((record) => record.reason === "popup-overflow")
                      .map((record) => record.disposition),
                  ).toEqual(["pending", "unknown"]);
                }
                ack.resolve();

                const diagnostics = yield* settle(session.diagnostics, (snapshot) =>
                  snapshot.records.some(
                    (record) =>
                      record.reason === "popup-overflow" && record.disposition === "confirmed",
                  ),
                );

                expect(diagnostics.records.map((record) => record.disposition)).toEqual(
                  acknowledge ? ["pending", "confirmed"] : ["pending", "unknown", "confirmed"],
                );
                if (acknowledge) {
                  expect(yield* session.status).toMatchObject({
                    phase: "open",
                    busy: false,
                    generation: initial.generation,
                  });
                  yield* session.click({ selector: "#next" });
                } else {
                  expect(yield* session.status).toMatchObject({
                    phase: "uncertain",
                    reason: "popup-overflow",
                  });
                  expect(
                    yield* session.click({ selector: "#next" }).pipe(Effect.result),
                  ).toMatchObject({
                    _tag: "Failure",
                    failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
                  });
                }
                expect(calls).toBe(1);
              } finally {
                ack.resolve();
                native.context().off("page", pageOpened);
              }
            }),
            { maxPages: 1, popupPolicy: "close" },
          );
          expect(calls).toBe(1);
          expect(f.releaseIds).toEqual(["session-1"]);
        }),
      ),
  );
}

it.live(
  "real CDP: the ninth paused dialog is dismissed once while the original pause is preserved",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;
        const evaluations: Array<Promise<unknown>> = [];

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* BrowserbaseBrowser.open(policy);

            for (let i = 0; i < 8; i++) yield* session.createPage;
            const pages = f.nativePages(session.reference.sessionId);

            expect(pages).toHaveLength(9);
            let dismissals = 0;

            for (const page of pages) {
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    page.once("dialog", (dialog) => {
                      const dismiss = dialog.dismiss.bind(dialog);

                      dialog.dismiss = async () => {
                        dismissals++;
                        await dismiss();
                      };
                      resolve();
                    });
                    const evaluation = page.evaluate("alert('private fixture message')");

                    // Keep every native evaluation observed while its dialog is deliberately paused.
                    evaluations.push(evaluation.catch(() => {}));
                  }),
              );
            }

            const diagnostics = yield* settle(session.diagnostics, (snapshot) =>
              snapshot.records.some(
                (record) =>
                  record.reason === "dialog-overflow" && record.disposition === "confirmed",
              ),
            );

            expect(
              diagnostics.records
                .filter((record) => record.reason === "dialog-overflow")
                .map((record) => record.disposition),
            ).toEqual(["pending", "confirmed"]);
            expect(dismissals).toBe(1);
            expect(yield* session.status).toMatchObject({
              phase: "paused",
              reason: "dialog-policy",
              unresolvedDispatch: false,
            });
            expect(
              JSON.stringify(diagnostics, (_key, value: unknown) =>
                typeof value === "bigint" ? String(value) : value,
              ),
            ).not.toContain("private fixture message");
            yield* session.close;
            expect(dismissals).toBe(9);
            yield* Effect.promise(() => Promise.all(evaluations));
          }),
          { maxPages: 9, dialogPolicy: "pause" },
        );
        expect(f.releaseIds).toEqual(["session-1"]);
      }),
    ),
);
