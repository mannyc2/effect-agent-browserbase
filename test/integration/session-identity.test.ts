import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vite-plus/test";

import * as Bootstrap from "../../packages/browser/src/Bootstrap.ts";
import * as BrowserRuntime from "../../packages/browser/src/BrowserRuntime.ts";
import * as Capture from "../../packages/browser/src/Capture.ts";
import { makeBindings } from "../../packages/browser/src/internal/browser/Bindings.ts";
import { makeSession } from "../../packages/browser/src/internal/browser/PublicSession.ts";
import * as PageControl from "../../packages/browser/src/PageControl.ts";
import { fixture } from "./fixtures/ScriptedProvider.ts";

it.effect(
  "copied and foreign sessions remain unregistered while a local disabled capability remains unsupported",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0;

        const f = yield* fixture({
          captureSource: {
            start: async () => {
              starts++;
            },
            stop: async () => {},
          },
        });

        const acquisition = yield* f.acquisition;
        const controls = yield* acquisition.rawConnect;
        const bindings = yield* makeBindings(Bootstrap.empty);
        const session = makeSession(controls, bindings);
        const page = (yield* session.pages)[0];

        assert.ok(page);
        const disabled = yield* PageControl.state(session, page).pipe(Effect.flip);

        assert.equal(disabled.reason, "unsupported");
        assert.equal(disabled.outcome, "undispatched");

        const unissued: ReadonlyArray<typeof session> = [
          { ...session },
          Object.create(Object.getPrototypeOf(session), Object.getOwnPropertyDescriptors(session)),
          Object.create(null),
        ];

        const receipt = { pageId: page.pageId, targetId: page.targetId, suspensionId: "unissued" };

        for (const value of unissued) {
          for (const action of [
            Capture.start(value).pipe(Effect.asVoid),
            PageControl.state(value, page).pipe(Effect.asVoid),
            PageControl.suspend(value, page).pipe(Effect.asVoid),
            PageControl.resume(value, receipt),
          ]) {
            const error = yield* action.pipe(Effect.flip);

            assert.equal(error.reason, "unregistered-session");
            assert.equal(error.outcome, "undispatched");
          }
        }
        assert.equal(starts, 0);

        // A second evaluation has its own real issuance registries, without another connection.
        vi.resetModules();

        const foreign = yield* Effect.promise(async () => ({
          capture: await import("../../packages/browser/src/Capture.ts"),
          control: await import("../../packages/browser/src/PageControl.ts"),
          runtime: await import("../../packages/browser/src/BrowserRuntime.ts"),
        }));

        assert.notEqual(foreign.capture.start, Capture.start);
        const binding = BrowserRuntime.playwright();

        for (const action of [
          foreign.capture.start(session).pipe(Effect.asVoid),
          foreign.control.state(session, page).pipe(Effect.asVoid),
          foreign.runtime.make({ implementation: "foreign-test", binding }).pipe(Effect.asVoid),
        ]) {
          const error = yield* action.pipe(Effect.flip);

          assert.equal(error.reason, "unregistered-session");
          assert.equal(error.outcome, "undispatched");
        }
        assert.equal(starts, 0);
        assert.equal(f.state.connects, 1);

        const interval = yield* Capture.start(session);

        yield* interval.stop;
        assert.equal(starts, 1);
        assert.equal((yield* session.readText({})).text, "initial");
      }),
    ),
);
