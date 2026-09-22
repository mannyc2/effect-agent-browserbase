import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Schema, SchemaGetter } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import { BrowserError, InitializationError } from "effect-browser/errors";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { CleanupResult } from "effect-browserbase/cleanup";
import type { Frame, Page } from "playwright-core";

import {
  localBrowser,
  localLaunch,
  NativeFixtureError,
  policy,
  withProvider,
} from "../fixtures/LocalBrowser.ts";

const CallResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Returned"), value: Schema.Json }),
  Schema.Struct({
    _tag: Schema.Literal("Rejected"),
    name: Schema.String,
    message: Schema.String,
    stack: Schema.String,
  }),
]);

const rejected = {
  _tag: "Rejected",
  name: "BrowserBindingError",
  message: "Browser binding call rejected",
  stack: "",
};

const native = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => NativeFixtureError.make({ operation, cause }),
  }).pipe(Effect.timeout(5000));

/** Emulates page-authored calls over the owner's existing connection, including invalid JS values. */
const call = (frame: Page | Frame, name: string, argumentsSource: string) =>
  native(`page call ${name}`, () =>
    frame.evaluate<unknown>(`(async () => {
    try {
      return { _tag: "Returned", value: await globalThis[${JSON.stringify(name)}](${argumentsSource}) };
    } catch (error) {
      return { _tag: "Rejected", name: error.name, message: error.message, stack: error.stack };
    }
  })()`),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallResult)));

const pageFor = (fixture: Effect.Success<typeof localBrowser>, sessionId: string) => {
  const pages = fixture.nativePages(sessionId);

  expect(pages).toHaveLength(1);
  const page = pages[0];

  if (page === undefined) throw new Error("The fixture must expose its owned native page");

  return page;
};

const limits = {
  maxConcurrent: 4,
  maxInputBytes: 256,
  maxOutputBytes: 256,
  timeoutMillis: 3000,
  failureMode: "reject-call" as const,
};

class SettingsUnavailable extends Schema.TaggedError<SettingsUnavailable>()(
  "NativeSettingsUnavailable",
  { detail: Schema.String },
) {}

const SettingsValue = Schema.Struct({ revision: Schema.NumberFromString, label: Schema.String });

class Settings extends Context.Service<
  Settings,
  {
    readonly read: (
      revision: number,
    ) => Effect.Effect<typeof SettingsValue.Type, SettingsUnavailable>;
  }
>()("native-bindings/Settings") {}

it.live(
  "real CDP: acquisition captures consumer services and readiness consumes encoded binding replies",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const origin = new URL(fixture.url).origin;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const versions: number[] = [];

        const bootstrap = Bootstrap.combine(
          Bootstrap.binding({
            ...limits,
            name: "getSettings",
            origins: [origin],
            input: Schema.Struct({ revision: Schema.NumberFromString }),
            output: SettingsValue,
            failureMode: "fail-session",
            handle: ({ revision }) =>
              Effect.flatMap(Settings, (settings) => settings.read(revision)),
          }),
          Bootstrap.init({
            id: "settings-ready",
            origins: [origin],
            content: `
          const loaded = new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
          globalThis.__settingsReady = Promise.all([getSettings({ revision: "7" }), loaded]).then(([settings]) => {
            const marker = document.createElement("p");
            marker.id = "settings";
            marker.textContent = settings.label + ":" + settings.revision;
            document.body.append(marker);
            return settings.revision === "7";
          });
        `,
            readiness: {
              expression: "globalThis.__settingsReady",
              timeoutMillis: 3000,
              existingDocuments: "RequireFreshNavigation",
            },
          }),
        );

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const browser = yield* BrowserbaseBrowser;

            const acquisition = yield* browser.acquire(policy, { bootstrap }).pipe(
              Effect.provideService(Settings, {
                read: Effect.fnUntraced(function* (revision: number) {
                  versions.push(revision);
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);

                  return { revision, label: "host settings" };
                }),
              }),
            );

            const session = yield* acquisition.connect;

            const reading = yield* session
              .bind()
              .navigate(NavigateRequest.make({ url: fixture.url }))
              .pipe(
                Effect.andThen(
                  session.bind().readText(ReadTextRequest.make({ selector: "#settings" })),
                ),
                Effect.forkScoped,
              );

            yield* Deferred.await(entered).pipe(Effect.timeout(3000));
            yield* Deferred.succeed(release, undefined);
            expect((yield* Fiber.join(reading)).text).toBe("host settings:7");
            expect(yield* session.ready).toEqual({ _tag: "Ready" });
            expect(versions.length).toBeGreaterThan(0);
            expect(versions.every((version) => version === 7)).toBe(true);

            const diagnostics: Bootstrap.BindingDiagnostics<SettingsUnavailable> =
              yield* session.bindingDiagnostics;

            expect(diagnostics.faulted).toBe(false);
            expect(diagnostics.failures).toEqual([]);
            expect(diagnostics.bindings[0]?.succeeded).toBeGreaterThan(0);
          }),
        );
        expect(fixture.createBodies).toHaveLength(1);
        expect(fixture.connections).toEqual(["session-1"]);
        expect(fixture.releaseIds).toEqual(["session-1"]);
      }),
    ),
);

it.live(
  "real CDP: native origins isolate dynamic frames and same-URL popups, including opaque documents",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const first = new URL(fixture.url).origin;
        const second = first.replace("127.0.0.1", "localhost");
        const publicCalls: string[] = [];
        const privateCalls: string[] = [];
        const privateDecodes: string[] = [];
        const input = Schema.Struct({ label: Schema.String, claimedOrigin: Schema.String });

        const authorizedInput = input.pipe(
          Schema.decodeTo(input, {
            decode: SchemaGetter.transformEffect<typeof input.Type, typeof input.Type>((value) =>
              Effect.promise(async () => {
                privateDecodes.push(value.label);

                return value;
              }),
            ),
            encode: SchemaGetter.passthrough<typeof input.Type>(),
          }),
        );

        const bootstrap = Bootstrap.combine(
          Bootstrap.binding({
            ...limits,
            name: "echo",
            origins: [first, second],
            input,
            output: Schema.String,
            handle: ({ label }) =>
              Effect.sync(() => {
                publicCalls.push(label);

                return label;
              }),
          }),
          Bootstrap.binding({
            ...limits,
            name: "privateSettings",
            origins: [first],
            input: authorizedInput,
            output: Schema.String,
            handle: ({ label }) =>
              Effect.sync(() => {
                privateCalls.push(label);

                return "private";
              }),
          }),
        );

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy, { bootstrap });

            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            const page = pageFor(fixture, session.reference.sessionId);
            const args = (label: string) => JSON.stringify({ label, claimedOrigin: first });

            expect(yield* call(page, "echo", args("main"))).toEqual({
              _tag: "Returned",
              value: "main",
            });
            expect(yield* call(page, "privateSettings", args("main"))).toEqual({
              _tag: "Returned",
              value: "private",
            });
            const child = page.frame({ name: "child" });

            if (child === null) throw new Error("Missing existing fixture frame");
            expect(yield* call(child, "echo", args("child"))).toEqual({
              _tag: "Returned",
              value: "child",
            });

            yield* native("create cross-origin and opaque fixture frames", () =>
              page.evaluate(
                async ({ first, second }) => {
                  await Promise.all(
                    [
                      { name: "cross", url: second + "/frame", opaque: false },
                      { name: "opaque", url: first + "/frame", opaque: true },
                    ].map(
                      ({ name, url, opaque }) =>
                        new Promise<void>((resolve) => {
                          const frame = document.createElement("iframe");

                          frame.name = name;
                          if (opaque) frame.setAttribute("sandbox", "allow-scripts");
                          frame.addEventListener("load", () => resolve(), { once: true });
                          frame.src = url;
                          document.body.append(frame);
                        }),
                    ),
                  );
                },
                { first, second },
              ),
            );
            const cross = page.frame({ name: "cross" });
            const opaque = page.frame({ name: "opaque" });

            if (cross === null || opaque === null)
              throw new Error("Dynamic frames were not attached");
            expect(yield* call(cross, "echo", args("cross"))).toEqual({
              _tag: "Returned",
              value: "cross",
            });
            expect(yield* call(cross, "privateSettings", args("forged-origin"))).toEqual(rejected);
            // Its URL is allowed, but the browser assigned this sandboxed document an opaque origin.
            expect(opaque.url()).toBe(first + "/frame");
            expect(yield* call(opaque, "privateSettings", args("opaque-origin"))).toEqual(rejected);

            const popup = yield* native("open a popup at the same URL", async () => {
              const [popup] = await Promise.all([
                page.waitForEvent("popup", { timeout: 3000 }),
                page.evaluate((url) => {
                  window.open(url);
                }, fixture.url),
              ]);

              await popup.waitForLoadState("load", { timeout: 3000 });

              return popup;
            });

            expect(popup).not.toBe(page);
            expect(popup.url()).toBe(page.url());
            expect(yield* call(popup, "echo", args("popup"))).toEqual({
              _tag: "Returned",
              value: "popup",
            });
            expect(yield* call(popup, "privateSettings", args("popup"))).toEqual({
              _tag: "Returned",
              value: "private",
            });
            expect(publicCalls).toEqual(["main", "child", "cross", "popup"]);
            expect(privateCalls).toEqual(["main", "popup"]);
            expect(privateDecodes).toEqual(["main", "popup"]);
            expect((yield* session.bindingDiagnostics).faulted).toBe(false);
          }),
        );
        expect(fixture.connections).toEqual(["session-1"]);
      }),
    ),
);

it.live(
  "real CDP: cross-origin frame replacement retires held replies and repeated OOPIF closure cleans up",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const first = new URL(fixture.url).origin;
        const second = first.replace("127.0.0.1", "localhost");
        const entered = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        let release!: (value: string) => void;

        const pending = new Promise<string>((resolve) => {
          release = resolve;
        });

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "frameReply",
          origins: [first, second],
          input: Schema.String,
          output: Schema.String,
          handle: (input) =>
            input === "old"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.promise(() => pending)),
                  Effect.ensuring(Deferred.succeed(finalized, undefined)),
                )
              : Effect.succeed(input),
        });

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy, { bootstrap });

            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            const page = pageFor(fixture, session.reference.sessionId);

            yield* native("wait for the fixture child document", () =>
              page.waitForLoadState("load", { timeout: 3000 }),
            );
            const child = page.frame({ name: "child" });

            if (child === null) throw new Error("The fixture must have a child frame");

            const old = yield* call(child, "frameReply", '"old"').pipe(
              Effect.exit,
              Effect.forkScoped,
            );

            yield* Deferred.await(entered).pipe(Effect.timeout(3000));
            yield* native("move the calling frame to a different origin", () =>
              child.goto(second + "/frame", { timeout: 3000 }),
            );
            expect(page.frame({ name: "child" })).toBe(child);
            expect(child.url()).toBe(second + "/frame");
            expect(yield* call(child, "frameReply", '"new-origin"')).toEqual({
              _tag: "Returned",
              value: "new-origin",
            });
            release("retired-frame-secret");
            yield* Deferred.await(finalized).pipe(Effect.timeout(3000));
            const oldResult = yield* Fiber.join(old).pipe(Effect.timeout(3000));

            if (Exit.isSuccess(oldResult)) expect(oldResult.value).toEqual(rejected);
            else {
              const failed = yield* Effect.failCause(oldResult.cause).pipe(Effect.result);

              if (failed._tag === "Failure")
                expect(Schema.is(NativeFixtureError)(failed.failure)).toBe(true);
            }

            // Each removed cross-origin frame has successfully called the binding first, proving
            // its native target was attached. Cleanup must not retain those closed CDP sessions.
            for (const name of ["first-retirement", "second-retirement"]) {
              yield* native("create another cross-origin frame", () =>
                page.evaluate(
                  async ({ name, url }) => {
                    const frame = document.createElement("iframe");

                    frame.name = name;

                    const loaded = new Promise<void>((resolve) =>
                      frame.addEventListener("load", () => resolve(), { once: true }),
                    );

                    frame.src = url;
                    document.body.append(frame);
                    await loaded;
                  },
                  { name, url: second + "/frame" },
                ),
              );
              const retiring = page.frame({ name });

              if (retiring === null)
                throw new Error("The cross-origin fixture frame was not attached");
              expect(yield* call(retiring, "frameReply", JSON.stringify(name))).toEqual({
                _tag: "Returned",
                value: name,
              });
              yield* native("remove a bound cross-origin target", () =>
                Promise.all([
                  page.waitForEvent("framedetached", {
                    predicate: (frame) => frame === retiring,
                    timeout: 3000,
                  }),
                  page.evaluate((name) => {
                    document.getElementsByName(name)[0]?.remove();
                  }, name),
                ]),
              );
              expect(retiring.isDetached()).toBe(true);
            }
            expect((yield* session.observe()).url).toBe(fixture.url);
            expect(yield* call(child, "frameReply", '"still-current"')).toEqual({
              _tag: "Returned",
              value: "still-current",
            });
            const report = yield* session.close;

            expect(report.local).toBe("closed");
            expect(report.remote).toBe("confirmed");
            expect(report.issues).toEqual([]);
            const diagnostics = yield* session.bindingDiagnostics;

            expect(diagnostics.faulted).toBe(false);
            expect(diagnostics.bindings[0]).toMatchObject({
              inFlight: 0,
              pendingNative: 0,
              retired: 0,
              succeeded: 4,
            });
          }).pipe(Effect.ensuring(Effect.sync(() => release("cleanup")))),
        );
        expect(fixture.releaseIds).toEqual(["session-1"]);
      }),
    ),
);

it.live(
  "real CDP: an existing global rejects registration with a typed error and releases its allocation once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const cleanup: CleanupResult[] = [];
        let handlerCalls = 0;

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "Array",
          origins: [new URL(fixture.url).origin],
          input: Schema.Null,
          output: Schema.String,
          handle: () =>
            Effect.sync(() => {
              handlerCalls++;

              return "unreachable";
            }),
        });

        const result = yield* withProvider(
          fixture,
          Effect.gen(function* () {
            return yield* (yield* BrowserbaseBrowser)
              .open(policy, { bootstrap })
              .pipe(Effect.result);
          }),
          {
            onCleanup: (report) =>
              Effect.sync(() => {
                cleanup.push(report);
              }),
          },
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(Schema.is(InitializationError)(result.failure)).toBe(true);
          expect(result.failure).toMatchObject({
            operation: "register",
            step: "bindings",
            reason: "configuration",
          });
        }
        expect(handlerCalls).toBe(0);
        expect(fixture.createBodies).toHaveLength(1);
        expect(fixture.connections).toEqual(["session-1"]);
        expect(fixture.releaseIds).toEqual(["session-1"]);
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0]).toMatchObject({
          ownership: "owned",
          remote: "confirmed",
          releaseRequested: true,
        });
        expect(cleanup[0]?.reference.sessionId).toBe("session-1");
      }),
    ),
);

it.live("duplicate binding names reject open and acquire before allocation or connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* localBrowser;

      const single = Bootstrap.binding({
        ...limits,
        name: "duplicate",
        origins: [new URL(fixture.url).origin],
        input: Schema.String,
        output: Schema.String,
        handle: Effect.succeed,
      });

      const bootstrap = Bootstrap.combine(single, single);

      yield* withProvider(
        fixture,
        Effect.gen(function* () {
          const browser = yield* BrowserbaseBrowser;
          const opened = yield* browser.open(policy, { bootstrap }).pipe(Effect.result);
          const acquired = yield* browser.acquire(policy, { bootstrap }).pipe(Effect.result);

          for (const result of [opened, acquired]) {
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(Schema.is(BrowserError)(result.failure)).toBe(true);
              expect(result.failure).toMatchObject({
                operation: "configure",
                reason: "configuration",
              });
            }
          }
        }),
      );
      expect(fixture.createBodies).toEqual([]);
      expect(fixture.connections).toEqual([]);
      expect(fixture.releaseIds).toEqual([]);
    }),
  ),
);

it.live(
  "real CDP: dynamic registration failure interrupts a waiting workflow with a sanitized typed cause",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const cleanup: CleanupResult[] = [];
        let failedNativeRegistration = false;
        let finalized = false;

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "popupSettings",
          origins: [new URL(fixture.url).origin],
          input: Schema.String,
          output: Schema.String,
          handle: Effect.succeed,
        });

        const result = yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const browser = yield* BrowserbaseBrowser;

            return yield* browser
              .withBrowser(policy, { bootstrap }, (session) =>
                Effect.gen(function* () {
                  yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
                  const page = pageFor(fixture, session.reference.sessionId);
                  const context = page.context();
                  const original = context.newCDPSession;

                  // One instance-local transport failpoint, after genuine successful initialization.
                  // No global Playwright replacement or second connection is involved in this failure.
                  yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      context.newCDPSession = async (subject) => {
                        if ("context" in subject && subject !== page && !failedNativeRegistration) {
                          failedNativeRegistration = true;
                          throw new Error("PRIVATE-NATIVE-REGISTRATION-CAUSE");
                        }

                        return original.call(context, subject);
                      };
                    }),
                    () =>
                      Effect.sync(() => {
                        context.newCDPSession = original;
                        finalized = true;
                      }),
                  );
                  yield* native("open failing popup", () =>
                    page.evaluate("void window.open('about:blank')"),
                  );

                  return yield* Effect.never;
                }),
              )
              .pipe(Effect.result, Effect.timeout(5000));
          }),
          {
            // The popup pauses action admission synchronously, but it is still this live connection.
            // Registration supervision must not mistake paused for retired.
            popupPolicy: "pause",
            onCleanup: (report) =>
              Effect.sync(() => {
                cleanup.push(report);
              }),
          },
        );

        expect(failedNativeRegistration).toBe(true);
        expect(finalized).toBe(true);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(Schema.is(InitializationError)(result.failure)).toBe(true);
          expect(result.failure).toMatchObject({
            operation: "register",
            step: "bindings",
            reason: "native",
          });
          expect(JSON.stringify(result.failure)).not.toContain("PRIVATE-NATIVE-REGISTRATION-CAUSE");
        }
        expect(fixture.createBodies).toHaveLength(1);
        expect(fixture.connections).toEqual(["session-1"]);
        expect(fixture.releaseIds).toEqual(["session-1"]);
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0]).toMatchObject({ local: "closed", remote: "confirmed", issues: [] });
      }),
    ),
);

it.live(
  "real CDP: malformed or oversized values and host failures have one sanitized rejection and recover",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const handled: string[] = [];
        const secret = SettingsUnavailable.make({ detail: "host-only-secret-and-stack" });

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "boundedEcho",
          origins: [new URL(fixture.url).origin],
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.NonEmptyString,
          maxInputBytes: 64,
          maxOutputBytes: 64,
          handle: ({ value }) =>
            Effect.suspend(() => {
              handled.push(value);
              if (value === "host-failure") return Effect.fail(secret);
              if (value === "defect") return Effect.die(new Error("host-only-secret-and-stack"));

              return Effect.succeed(
                value === "invalid-output" ? "" : value === "large-output" ? "é".repeat(40) : value,
              );
            }),
        });

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy, { bootstrap });

            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            const page = pageFor(fixture, session.reference.sessionId);

            for (const source of [
              "",
              "undefined",
              "{ value: 42 }",
              '{ value: "ok" }, { extra: true }',
              '{ value: "ok", extra: () => 1 }',
              '{ value: "ok", extra: 1n }',
              '{ value: "ok", extra: NaN }',
              '(() => { const value = { value: "ok" }; value.self = value; return value; })()',
              '{ value: "é".repeat(40) }',
              '{ value: "x".repeat(53) }',
            ])
              expect(yield* call(page, "boundedEcho", source)).toEqual(rejected);
            expect(handled).toEqual([]);

            // {"value":""} occupies 12 bytes; this input exactly fills its 64-byte allowance.
            expect(yield* call(page, "boundedEcho", '{ value: "x".repeat(52) }')).toEqual({
              _tag: "Returned",
              value: "x".repeat(52),
            });
            for (const value of ["host-failure", "defect", "invalid-output", "large-output"])
              expect(yield* call(page, "boundedEcho", JSON.stringify({ value }))).toEqual(rejected);
            expect(yield* call(page, "boundedEcho", '{ value: "healthy" }')).toEqual({
              _tag: "Returned",
              value: "healthy",
            });
            const diagnostics = yield* session.bindingDiagnostics;

            expect(diagnostics.faulted).toBe(false);
            expect(diagnostics.bindings[0]).toMatchObject({
              name: "boundedEcho",
              inFlight: 0,
              succeeded: 2,
            });
            expect(diagnostics.failures.length).toBeGreaterThanOrEqual(4);
            expect(handled).toEqual([
              "x".repeat(52),
              "host-failure",
              "defect",
              "invalid-output",
              "large-output",
              "healthy",
            ]);
            expect((yield* session.observe()).url).toBe(fixture.url);
          }),
        );
      }),
    ),
);

it.live(
  "real CDP: capacity is finite, timeout interrupts the handler, and snapshots remain independent",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "boundedWork",
          origins: [new URL(fixture.url).origin],
          input: Schema.Literals(["hold", "hang", "healthy"]),
          output: Schema.String,
          maxConcurrent: 1,
          timeoutMillis: 1000,
          handle: Effect.fnUntraced(function* (input) {
            if (input === "hold") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            if (input === "hang")
              return yield* Effect.never.pipe(
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              );

            return input;
          }),
        });

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy, { bootstrap });

            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            const page = pageFor(fixture, session.reference.sessionId);
            const held = yield* call(page, "boundedWork", '"hold"').pipe(Effect.forkScoped);

            yield* Deferred.await(entered).pipe(Effect.timeout(3000));
            const before = yield* session.bindingDiagnostics;

            expect(before.bindings[0]).toMatchObject({ inFlight: 1, accepted: 1, succeeded: 0 });
            expect(yield* call(page, "boundedWork", '"healthy"')).toEqual(rejected);
            yield* Deferred.succeed(release, undefined);
            expect(yield* Fiber.join(held)).toEqual({ _tag: "Returned", value: "hold" });
            expect(yield* call(page, "boundedWork", '"hang"')).toEqual(rejected);
            yield* Deferred.await(interrupted).pipe(Effect.timeout(3000));
            expect(yield* call(page, "boundedWork", '"healthy"')).toEqual({
              _tag: "Returned",
              value: "healthy",
            });
            const after = yield* session.bindingDiagnostics;

            expect(after.faulted).toBe(false);
            expect(after.bindings[0]).toMatchObject({ inFlight: 0, accepted: 3, succeeded: 2 });
            expect(before.bindings[0]).toMatchObject({ inFlight: 1, accepted: 1, succeeded: 0 });
            expect(before.bindings).not.toBe(after.bindings);
          }),
        );
      }),
    ),
);

it.live(
  "real CDP: fail-session preserves the consumer error and withBrowser supervises scope cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const secret = SettingsUnavailable.make({ detail: "private service failure" });

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "fatalSettings",
          origins: [new URL(fixture.url).origin],
          input: Schema.Null,
          output: Schema.String,
          failureMode: "fail-session",
          handle: () => Effect.fail(secret),
        });

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const browser = yield* BrowserbaseBrowser;
            const session = yield* browser.open(policy, { bootstrap });

            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            const failed = yield* session.failure.pipe(Effect.result, Effect.forkScoped);

            expect(
              yield* call(pageFor(fixture, session.reference.sessionId), "fatalSettings", "null"),
            ).toEqual(rejected);
            const result = yield* Fiber.join(failed).pipe(Effect.timeout(3000));

            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") expect(result.failure).toBe(secret);

            const diagnostics: Bootstrap.BindingDiagnostics<SettingsUnavailable> =
              yield* session.bindingDiagnostics;

            expect(diagnostics.faulted).toBe(true);
            const failure = diagnostics.failures[0];

            expect(failure).toBeDefined();
            if (failure !== undefined) {
              expect(failure.mode).toBe("fail-session");
              const retained = yield* Effect.failCause(failure.cause).pipe(Effect.result);

              expect(retained._tag).toBe("Failure");
              if (retained._tag === "Failure") expect(retained.failure).toBe(secret);
            }
            expect((yield* session.observe().pipe(Effect.result))._tag).toBe("Failure");
            yield* session.close;

            const supervised = yield* browser
              .withBrowser(policy, { bootstrap }, (owned) =>
                Effect.gen(function* () {
                  yield* owned.bind().navigate(NavigateRequest.make({ url: fixture.url }));
                  yield* call(pageFor(fixture, owned.reference.sessionId), "fatalSettings", "null");

                  return yield* Effect.never;
                }),
              )
              .pipe(Effect.result, Effect.timeout(5000));

            expect(supervised._tag).toBe("Failure");
            if (supervised._tag === "Failure") expect(supervised.failure).toBe(secret);
            expect(fixture.releaseIds).toEqual(["session-1", "session-2"]);
          }),
        );
      }),
    ),
);

it.live(
  "real CDP: same-URL navigation retires a pending reply without authorizing the replacement document",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;
        const entered = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        let release!: (value: string) => void;

        const pending = new Promise<string>((resolve) => {
          release = resolve;
        });

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "documentReply",
          origins: [new URL(fixture.url).origin],
          input: Schema.String,
          output: Schema.String,
          handle: (input) =>
            input === "old"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.promise(() => pending)),
                  Effect.ensuring(Deferred.succeed(finalized, undefined)),
                )
              : Effect.succeed(input),
        });

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy, { bootstrap });

            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            const page = pageFor(fixture, session.reference.sessionId);
            const frame = page.mainFrame();

            const old = yield* call(page, "documentReply", '"old"').pipe(
              Effect.exit,
              Effect.forkScoped,
            );

            yield* Deferred.await(entered).pipe(Effect.timeout(3000));
            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            expect(page.mainFrame()).toBe(frame);
            expect(page.url()).toBe(fixture.url);
            expect(yield* call(page, "documentReply", '"new"')).toEqual({
              _tag: "Returned",
              value: "new",
            });
            release("retired-document-secret");
            yield* Deferred.await(finalized).pipe(Effect.timeout(3000));
            const oldResult = yield* Fiber.join(old).pipe(Effect.timeout(3000));

            if (Exit.isSuccess(oldResult)) expect(oldResult.value).toEqual(rejected);
            else {
              const failed = yield* Effect.failCause(oldResult.cause).pipe(Effect.result);

              if (failed._tag === "Failure")
                expect(Schema.is(NativeFixtureError)(failed.failure)).toBe(true);
            }
            expect(yield* call(page, "documentReply", '"still-new"')).toEqual({
              _tag: "Returned",
              value: "still-new",
            });
            const diagnostics = yield* session.bindingDiagnostics;

            expect(diagnostics.faulted).toBe(false);
            expect(diagnostics.bindings[0]).toMatchObject({ inFlight: 0, succeeded: 2 });
          }).pipe(Effect.ensuring(Effect.sync(() => release("cleanup")))),
        );
      }),
    ),
);

for (const transition of ["close", "reconnect"] as const) {
  it.live(
    `real CDP: ${transition} cancels handlers and rejects late results from the retired connection`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* localBrowser;
          const entered = yield* Deferred.make<void>();
          const finalized = yield* Deferred.make<void>();
          let release!: (value: string) => void;

          const pending = new Promise<string>((resolve) => {
            release = resolve;
          });

          const bootstrap = Bootstrap.binding({
            ...limits,
            name: "connectionReply",
            origins: [new URL(fixture.url).origin],
            input: Schema.String,
            output: Schema.String,
            handle: (input) =>
              input === "old"
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.promise(() => pending)),
                    Effect.ensuring(Deferred.succeed(finalized, undefined)),
                  )
                : Effect.succeed(input),
          });

          yield* withProvider(
            fixture,
            Effect.gen(function* () {
              const session = yield* (yield* BrowserbaseBrowser).open(policy, { bootstrap });

              yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
              const page = pageFor(fixture, session.reference.sessionId);

              const old = yield* call(page, "connectionReply", '"old"').pipe(
                Effect.exit,
                Effect.forkScoped,
              );

              yield* Deferred.await(entered).pipe(Effect.timeout(3000));
              if (transition === "close") yield* session.close;
              else yield* session.detach;
              yield* Deferred.await(finalized).pipe(Effect.timeout(3000));
              if (transition === "reconnect") {
                yield* session.reconnect(true);
                yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
                expect(
                  yield* call(
                    pageFor(fixture, session.reference.sessionId),
                    "connectionReply",
                    '"new"',
                  ),
                ).toEqual({ _tag: "Returned", value: "new" });
              }
              release("retired-connection-secret");
              const oldResult = yield* Fiber.join(old).pipe(Effect.timeout(3000));

              if (Exit.isSuccess(oldResult)) expect(oldResult.value).toEqual(rejected);
              else {
                const failed = yield* Effect.failCause(oldResult.cause).pipe(Effect.result);

                if (failed._tag === "Failure")
                  expect(Schema.is(NativeFixtureError)(failed.failure)).toBe(true);
              }
              const diagnostics = yield* session.bindingDiagnostics;

              expect(diagnostics.faulted).toBe(false);
              expect(
                diagnostics.bindings.every(
                  (binding) =>
                    binding.inFlight === 0 && binding.pendingNative === 0 && binding.retired === 0,
                ),
              ).toBe(true);
              if (transition === "reconnect")
                expect(fixture.connections).toEqual(["session-1", "session-1"]);
            }).pipe(Effect.ensuring(Effect.sync(() => release("cleanup")))),
            {
              launch: { ...localLaunch, keepAlive: true },
            },
          );
          expect(fixture.releaseIds).toEqual(["session-1"]);
        }),
      ),
  );
}

it.live(
  "real CDP: a borrowed acquisition installs its bindings and leaves remote release to the owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;

        const bootstrap = Bootstrap.binding({
          ...limits,
          name: "borrowedReply",
          origins: [new URL(fixture.url).origin],
          input: Schema.NumberFromString,
          output: Schema.NumberFromString,
          handle: (value) => Effect.succeed(value + 1),
        });

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const browser = yield* BrowserbaseBrowser;
            const owner = yield* browser.open(policy);

            yield* owner.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            const detached = yield* owner.detach;

            yield* Effect.scoped(
              Effect.gen(function* () {
                const attached = yield* browser.attach(owner.reference, {
                  policy,
                  bootstrap,
                  target: { targetId: detached.targetId },
                });

                yield* attached.bind().navigate(NavigateRequest.make({ url: fixture.url }));
                expect(
                  yield* call(
                    pageFor(fixture, attached.reference.sessionId),
                    "borrowedReply",
                    '"41"',
                  ),
                ).toEqual({ _tag: "Returned", value: "42" });
                const cleanup = yield* attached.close;

                expect(cleanup).toMatchObject({
                  ownership: "borrowed",
                  remote: "not-owned",
                  releaseRequested: false,
                });
              }),
            );
            expect(fixture.releaseIds).toEqual([]);
            yield* owner.close;
          }),
          { launch: { ...localLaunch, keepAlive: true } },
        );
        expect(fixture.releaseIds).toEqual(["session-1"]);
      }),
    ),
);

it.live(
  "real CDP: a reentrant browser read rejects busy before queuing behind its own readiness permit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;

        let reentrant: Effect.Effect<
          { readonly reason: string; readonly outcome: string },
          BrowserError
        > = Effect.never;

        const bootstrap = Bootstrap.combine(
          Bootstrap.binding({
            ...limits,
            name: "reentrantRead",
            origins: [new URL(fixture.url).origin],
            input: Schema.Null,
            output: Schema.Struct({ reason: Schema.String, outcome: Schema.String }),
            handle: () => reentrant,
          }),
          Bootstrap.init({
            id: "reentrant-check",
            origins: [new URL(fixture.url).origin],
            content: "globalThis.__checkReentrant = () => reentrantRead(null);",
            readiness: {
              expression:
                "globalThis.__checkReentrant().then((reply) => reply.reason === 'busy' && reply.outcome === 'undispatched')",
              timeoutMillis: 2000,
              existingDocuments: "RequireFreshNavigation",
            },
          }),
        );

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy, { bootstrap });

            reentrant = session.observe().pipe(
              Effect.result,
              Effect.map((result) => {
                if (result._tag === "Success")
                  return { reason: "unexpected-success", outcome: "dispatched" };

                return {
                  reason: result.failure.reason,
                  outcome: result.failure.outcome ?? "missing",
                };
              }),
            );
            yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
            expect(yield* session.ready).toEqual({ _tag: "Ready" });
            expect((yield* session.observe()).url).toBe(fixture.url);
            expect((yield* session.bindingDiagnostics).faulted).toBe(false);
          }),
        );
      }),
    ),
);
