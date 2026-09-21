import assert from "node:assert/strict";

import * as Bootstrap from "@effect-agent/browserbase/bootstrap";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Schema, Scope } from "effect";

import type { BrowserError } from "../src/Errors.ts";
import {
  type ConnectionBindings,
  makeBindings,
  preparePlan,
} from "../src/internal/browser/Bindings.ts";
import type { SessionControls } from "../src/internal/browser/Session.ts";
import { fixture } from "./fixtures/ScriptedProvider.ts";

for (const strategy of ["sequential", "parallel"] as const) {
  it.effect(
    `natural ${strategy} parent shutdown fences the browser before a binding finalizer`,
    () =>
      Effect.gen(function* () {
        const parent = yield* Scope.make(strategy);
        // Match BrowserbaseBrowser's private sequential acquisition scope; the application may
        // choose parallel finalizers outside it without changing the browser's cleanup protocol.
        const acquisition = yield* Scope.fork(parent, "sequential");
        const entered = yield* Deferred.make<void>();
        const order: string[] = [];

        const state: {
          connection?: ConnectionBindings;
          controls?: SessionControls;
          finalizerError?: BrowserError;
          finalizerSucceeded: boolean;
        } = { finalizerSucceeded: false };

        const { scripted, reply } = yield* Effect.gen(function* () {
          const plan = Bootstrap.binding({
            name: "holdUntilClosed",
            origins: ["https://example.test"],
            input: Schema.String,
            output: Schema.String,
            maxConcurrent: 1,
            maxInputBytes: 128,
            maxOutputBytes: 128,
            timeoutMillis: 5000,
            failureMode: "reject-call",
            handle: () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    order.push("callback-finalizer");
                    assert.ok(state.controls);

                    const result = yield* state.controls
                      .bind()
                      .click("#button")
                      .pipe(Effect.result);

                    if (result._tag === "Success") state.finalizerSucceeded = true;
                    else state.finalizerError = result.failure;
                  }),
                );
                yield* Deferred.succeed(entered, undefined);

                return yield* Effect.never;
              }),
          });

          const bindings = yield* makeBindings(yield* preparePlan(plan));

          const scripted = yield* fixture({
            connectBindings: (fault, active) =>
              bindings.connect(fault, active).pipe(
                Effect.tap((connection) =>
                  Effect.sync(() => {
                    state.connection = connection;
                  }),
                ),
              ),
            onConnect: async (driver) => ({
              ...driver,
              fenceInitialization: () => {
                order.push("fence");
              },
              disposeInitialization: async () => {
                order.push("registrations-disposed");
              },
            }),
            onDisconnect: () => {
              order.push("disconnected");
            },
          });

          const acquired = yield* scripted.acquisition;

          state.controls = yield* acquired.connect;
          const binding = state.connection?.bindings[0];

          assert.ok(binding);

          const reply = binding
            .invoke({
              read: async () => '"held"',
              check: async () => {},
              dispose: async () => {},
            })
            .then(
              () => "returned",
              () => "rejected",
            );

          yield* Deferred.await(entered);

          return { scripted, reply };
        }).pipe(Scope.provide(acquisition));

        order.push("parent-closing");
        yield* Scope.close(parent, Exit.void);
        assert.equal(yield* Effect.promise(() => reply), "rejected");
        assert.equal(state.finalizerSucceeded, false);
        assert.equal(state.finalizerError?.reason, "closed");
        assert.equal(state.finalizerError?.outcome, "undispatched");
        assert.equal(scripted.state.clicks, 0);
        assert.ok(order.indexOf("fence") < order.indexOf("callback-finalizer"));
        assert.ok(order.indexOf("callback-finalizer") < order.indexOf("registrations-disposed"));
        assert.ok(order.indexOf("registrations-disposed") < order.indexOf("disconnected"));
        assert.equal(scripted.state.releases, 1);
        assert.equal(scripted.state.localCloses, 1);
        assert.equal(scripted.reports.length, 1);
        assert.equal(scripted.reports[0]?.remote, "confirmed");
        assert.equal(scripted.reports[0]?.local, "closed");
        assert.deepEqual(scripted.reports[0]?.issues, []);
      }),
  );
}
