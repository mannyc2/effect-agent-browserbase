import { Context, Effect, Schema, Stream } from "effect";
// Installed-package workflow for a consumer that owns a real browser.
//
// It runs as an ordinary program on the pinned Node and Bun against a local
// Chromium process over real CDP, using only the installed package's public
// exports. The provider control plane is scripted; the browser is not.
import * as Bootstrap from "effect-browser/bootstrap";
import { InlineFile, NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import type { InitializationError } from "effect-browser/errors";
import { BrowserbaseBrowser } from "effect-browserbase/browser";

import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const PublicSettings = Schema.Struct({ label: Schema.String, revision: Schema.NumberFromString });

class SettingsUnavailable extends Schema.TaggedError<SettingsUnavailable>()(
  "ConsumerSettingsUnavailable",
  { reason: Schema.String },
) {}

class ConsumerSettings extends Context.Service<
  ConsumerSettings,
  {
    readonly read: (
      revision: number,
    ) => Effect.Effect<typeof PublicSettings.Type, SettingsUnavailable>;
  }
>()("consumer/Settings") {}

/** Consumer services are supplied where the session is acquired, after the browser Layer exists. */
const bootstrap = (origin: string) =>
  Bootstrap.combine(
    Bootstrap.binding({
      name: "getConsumerSettings",
      origins: [origin],
      input: Schema.Struct({ revision: Schema.NumberFromString }),
      output: PublicSettings,
      maxConcurrent: 4,
      maxInputBytes: 128,
      maxOutputBytes: 256,
      timeoutMillis: 3000,
      failureMode: "fail-session",
      handle: ({ revision }) =>
        Effect.flatMap(ConsumerSettings, (settings) => settings.read(revision)),
    }),
    Bootstrap.init({
      id: "consumer-marker",
      origins: [origin],
      content: `
      const consumerDocument = new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
      });
      globalThis.__installed = Promise.all([
        globalThis.getConsumerSettings({ revision: "7" }), consumerDocument,
      ]).then(([settings]) => {
        const marker = document.createElement("p");
        marker.id = "marker";
        marker.textContent = settings.label;
        marker.dataset.revision = settings.revision;
        document.body.append(marker);
        return settings.revision === "7";
      });
    `,
      readiness: {
        expression: "globalThis.__installed",
        timeoutMillis: 5000,
        existingDocuments: "AcceptAlreadyRunning",
      },
    }),
  );

const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`Consumer assertion failed: ${message}`);
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const fixture = yield* localBrowser;

    return yield* withProvider(
      fixture,
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser;

        const workflow = browser.withBrowser(
          policy,
          { bootstrap: bootstrap(new URL(fixture.url).origin) },
          (session) =>
            Effect.gen(function* () {
              const failureType: Same<
                Effect.Error<typeof session.failure>,
                SettingsUnavailable | InitializationError
              > = true;

              expect(failureType, "the session failure channel retains the consumer error type");

              yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
              const observation = yield* session.observe({ maxTextBytes: 4096, maxControls: 8 });

              expect(
                observation.text.includes("Local browser fixture"),
                "real page text is observed",
              );
              expect(observation.controls.length > 0, "real controls are observed");

              const captured = yield* Effect.scoped(
                Effect.gen(function* () {
                  const interval = yield* Capture.start(session, {
                    maxFrames: 4,
                    maxDurationMillis: 5000,
                    size: { width: 320, height: 240 },
                  });

                  const frames = yield* Stream.runCollect(interval.frames.pipe(Stream.take(1)));

                  expect(frames.length === 1, "live capture delivers a frame from the owned page");
                  expect(
                    Schema.is(Capture.CapturedFrame)(frames[0]),
                    "a delivered frame is the public CapturedFrame value",
                  );

                  return yield* interval.stop;
                }),
              );

              expect(captured.dropped === 0, "no frame is dropped inside the bounded window");
              expect(captured.duplicates === 0, "no frame is delivered twice");

              // The registered bundle ran on the document this consumer navigated to.
              const ready = yield* session.ready;

              expect(ready._tag === "Ready", "the current document satisfied its readiness");
              expect(
                (yield* session.bind().readText(ReadTextRequest.make({ selector: "#marker" })))
                  .text === "installed by the consumer",
                "the init bundle reached the page before the consumer read it",
              );

              const diagnostics: Bootstrap.BindingDiagnostics<SettingsUnavailable> =
                yield* session.bindingDiagnostics;

              const settings = diagnostics.bindings.find(
                (binding) => binding.name === "getConsumerSettings",
              );

              expect(
                diagnostics.faulted === false && diagnostics.failures.length === 0,
                "binding supervision is healthy",
              );
              expect(
                settings !== undefined && settings.succeeded > 0,
                "the page consumed an encoded host-service reply",
              );

              // Small file selection needs no provisioning of any kind.
              yield* session.selectFiles({
                selector: "#file",
                selection: {
                  _tag: "Inline",
                  files: [
                    InlineFile.make({
                      name: "notes.txt",
                      mediaType: "text/plain",
                      bytes: new TextEncoder().encode("consumer bytes"),
                    }),
                  ],
                },
              });

              expect(
                (yield* session.bind().readText(ReadTextRequest.make({ selector: "#chosen" })))
                  .text === "notes.txt:14",
                "the page received the selected file",
              );

              // A second owner borrows the same session and closes without releasing it.
              const pages = yield* session.pages;
              const selected = pages.find((page) => page.selected);

              if (selected === undefined) throw new Error("The owned session has no selected page");

              const borrowed = yield* withProvider(
                fixture,
                Effect.gen(function* () {
                  const attached = yield* (yield* BrowserbaseBrowser).attach(session.reference, {
                    policy,
                    target: { targetId: selected.targetId },
                  });

                  return yield* attached.close;
                }),
              );

              expect(
                borrowed.ownership === "borrowed",
                "a borrowed scope reports borrowed cleanup",
              );
              expect(borrowed.releaseRequested === false, "a borrowed scope requests no release");
              expect(fixture.releaseIds.length === 0, "the borrowed scope released nothing");

              const cleanup = yield* session.close;

              expect(cleanup.ownership === "owned", "this consumer owned the session");
              expect(cleanup.local === "closed", "the local connection is closed");
              expect(cleanup.remote === "confirmed", "release is confirmed by a terminal read");
              expect(cleanup.issues.length === 0, "cleanup reports no issue");
              expect(fixture.releaseIds.length === 1, "exactly one release was requested");

              return {
                reference: cleanup.reference.sessionId,
                text: observation.text.length,
                delivered: captured.delivered,
                nativeStop: captured.nativeStop,
                borrowed: borrowed.remote,
                bindingReplies: settings?.succeeded,
              };
            }),
        );

        const requirements: Same<Requirements<typeof workflow>, ConsumerSettings> = true;

        const errors: Same<
          Extract<Effect.Error<typeof workflow>, SettingsUnavailable>,
          SettingsUnavailable
        > = true;

        expect(requirements && errors, "withBrowser preserves consumer E/R and discharges Scope");

        return yield* workflow.pipe(
          Effect.provideService(ConsumerSettings, {
            read: (revision) => Effect.succeed({ label: "installed by the consumer", revision }),
          }),
        );
      }),
    );
  }),
);

const result = await Effect.runPromise(program);

console.log(JSON.stringify({ profile: "generic", ...result }));
