import { createServer } from "node:http";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { Browser as PlaywrightBrowser } from "playwright-core";

import { CursorSample } from "../bench/Clip.ts";
import {
  openOperatorOnlyReference,
  openReference,
  operatorOnlyReference,
  reference,
} from "../bench/HumanReference.ts";
import { makeInputLog } from "../bench/InputLog.ts";
import { BenchError, Journal } from "../bench/Records.ts";
import { localAgentBrowser, withGenericAgentBrowser } from "../fixtures/AgentBrowser.ts";

const movingSite = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const server = createServer((request, response) => {
        if (request.url === "/broken") {
          response.destroy();

          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>Operator protocol fixture</title>
<style>@keyframes move{from{transform:translateX(0)}to{transform:translateX(450px)}}#moving{width:80px;height:80px;background:#258d76;animation:move 1s linear infinite alternate}body{font:22px sans-serif}</style>
<h1>Operator protocol fixture</h1><div id="moving"></div><p>CSS keeps painting without synthetic input.</p>`);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();

      if (address === null || typeof address === "string")
        throw new Error("Moving site port missing");

      return {
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
      };
    },
    catch: () =>
      BenchError.make({ operation: "moving site", message: "Cannot open protocol fixture." }),
  }),
  (site) => Effect.promise(site.close),
);

/** Only the provider's debug reply is scripted; the owner still opens the original real Chromium once. */
const liveViewFixture = (fixture: Effect.Success<typeof localAgentBrowser>) => ({
  ...fixture,
  fetch: (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin === "https://api.browserbase.com" && url.pathname.endsWith("/debug"))
      return Response.json({
        debuggerFullscreenUrl:
          "https://www.browserbase.com/devtools/session?token=unpaid-live-view-fixture",
        pages: [],
      });

    return fixture.fetch(input, init);
  }) satisfies typeof globalThis.fetch,
});

const journal = (id: string) =>
  new Journal({
    version: 1,
    runId: id,
    scene: "human-reference",
    backend: "browserbase",
    driver: "operator-protocol-fixture",
    sourceRevision: "native-test-fixture",
    sourceDirty: false,
    trial: 0,
    seed: 0,
    viewport: { width: 640, height: 480 },
    settings: { humanEvidence: false },
    capture: { maxFrames: 100, maxBytes: 16 * 1024 * 1024, quality: 60, maxDurationMillis: 6000 },
  });

it.live(
  "handoff stops exact on-air capture and requires operator release before fresh authority on the original connection",
  () =>
    Effect.gen(function* () {
      const site = yield* movingSite;
      const fixture = yield* localAgentBrowser;
      const record = journal("handoff-gap");
      const log = yield* makeInputLog({ origins: [new URL(site.url).origin], maxEvents: 128 });
      const shown = yield* Deferred.make<void>();
      const release = yield* Deferred.make<unknown>();
      let freshGeneration: number | undefined;

      yield* withGenericAgentBrowser(
        liveViewFixture(fixture),
        Effect.gen(function* () {
          const browser = yield* BrowserbaseBrowser.open(
            BrowserPolicy.unrestricted({ maxElapsedMillis: 30000 }),
            { bootstrap: log.bootstrap },
          );

          const old = browser.initialPage;

          yield* old.navigate({ url: site.url });

          const referenceRun = yield* reference(record, browser, {
            onAir: old,
            inputLog: log,
            durationMillis: 5000,
            provenance: "unpaid-operator-protocol-fixture",
            operator: {
              showLiveView: (view) =>
                Effect.gen(function* () {
                  expect(Redacted.value(view.session)).toContain("unpaid-live-view-fixture");
                  expect(JSON.stringify(view)).not.toContain("unpaid-live-view-fixture");
                  yield* Deferred.succeed(shown, undefined);
                }),
              waitReleased: Deferred.await(release),
            },
            afterResume: (pages) =>
              Effect.gen(function* () {
                const page = pages[0];

                if (page === undefined)
                  return yield* BenchError.make({
                    operation: "resume",
                    message: "Fresh fixture page missing.",
                  });
                freshGeneration = page.identity.generation;
                expect((yield* page.readText({ selector: "body" })).text).toContain(
                  "Operator protocol fixture",
                );
                expect((yield* old.readText({ selector: "body" }).pipe(Effect.exit))._tag).toBe(
                  "Failure",
                );
              }),
          }).pipe(Effect.forkScoped);

          yield* Effect.raceFirst(Deferred.await(shown), Fiber.join(referenceRun));
          expect((yield* browser.status).phase).toBe("paused");
          yield* Effect.sleep("100 millis");
          const stoppedFrames = record.recording?.frames.length ?? 0;

          expect(stoppedFrames).toBeGreaterThan(0);
          yield* Effect.sleep("400 millis");
          expect(record.recording?.frames.length).toBe(stoppedFrames);
          expect((yield* browser.status).phase).toBe("paused");
          expect(freshGeneration).toBeUndefined();
          yield* Deferred.succeed(release, { operatorReleasedControl: true });
          const inventory = yield* Fiber.join(referenceRun);

          expect(inventory.generation).toBeGreaterThan(old.identity.generation);
          expect(freshGeneration).toBe(inventory.generation);
          expect((yield* browser.status).phase).toBe("closed");
        }),
      );
      expect(fixture.connectionIds).toHaveLength(1);
      expect(fixture.releaseIds).toHaveLength(1);
      expect(record.ownerClose).toBe("confirmed");
      expect(record.cleanup).toBe("confirmed");
      expect(record.metrics).toMatchObject({
        handedOff: true,
        operatorReleased: true,
        resumed: true,
        capture: "stopped-before-handoff",
        humanFootage: "unavailable",
        panelEligible: false,
        provenance: "unpaid-operator-protocol-fixture",
        inputEvents: 0,
      });
      expect(record.recording?.nativeStop).toBe("confirmed");
      expect(JSON.stringify(record.snapshot())).not.toContain("unpaid-live-view-fixture");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "a reference timeout closes the original owner without claiming operator release or resuming",
  () =>
    Effect.gen(function* () {
      const site = yield* movingSite;
      const fixture = yield* localAgentBrowser;
      const record = journal("handoff-timeout");
      let shown = false;

      const outcome = yield* withGenericAgentBrowser(
        liveViewFixture(fixture),
        openReference(record, {
          url: site.url,
          origins: [new URL(site.url).origin],
          durationMillis: 1000,
          provenance: "unpaid-operator-protocol-fixture",
          operator: {
            showLiveView: () =>
              Effect.sync(() => {
                shown = true;
              }),
            waitReleased: Effect.never,
          },
        }),
      ).pipe(Effect.exit);

      expect(outcome._tag).toBe("Failure");
      expect(shown, JSON.stringify(outcome)).toBe(true);
      expect(record.metrics).toMatchObject({
        handedOff: true,
        operatorReleased: false,
        resumed: false,
        humanFootage: "unavailable",
        panelEligible: false,
      });
      expect(record.failure).toBe("TimeoutError");
      expect(record.cleanup).toBe("confirmed");
      expect(record.ownerClose).toBe("confirmed");
      expect(fixture.connectionIds).toHaveLength(1);
      expect(fixture.releaseIds).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "a false release message is refused before resume and still receives checked provider cleanup",
  () =>
    Effect.gen(function* () {
      const site = yield* movingSite;
      const fixture = yield* localAgentBrowser;
      const record = journal("handoff-refused-release");

      const outcome = yield* withGenericAgentBrowser(
        liveViewFixture(fixture),
        openReference(record, {
          url: site.url,
          origins: [new URL(site.url).origin],
          durationMillis: 3000,
          provenance: "unpaid-operator-protocol-fixture",
          operator: {
            showLiveView: () => Effect.void,
            waitReleased: Effect.succeed({ operatorReleasedControl: false }),
          },
        }),
      ).pipe(Effect.exit);

      expect(outcome._tag).toBe("Failure");
      expect(record.metrics).toMatchObject({
        operatorReleased: false,
        resumed: false,
        panelEligible: false,
      });
      expect(record.failure, JSON.stringify(outcome)).toBe("SchemaError");
      expect(record.ownerClose).toBe("confirmed");
      expect(record.cleanup).toBe("confirmed");
      expect(fixture.connectionIds).toHaveLength(1);
      expect(fixture.releaseIds).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("invalid duration is refused before allocating any provider session", () =>
  Effect.gen(function* () {
    const fixture = yield* localAgentBrowser;
    const record = journal("invalid-reference-duration");

    const outcome = yield* withGenericAgentBrowser(
      liveViewFixture(fixture),
      openReference(record, {
        url: "https://example.com/",
        origins: ["https://example.com"],
        durationMillis: 900001,
        operator: {
          showLiveView: () => Effect.void,
          waitReleased: Effect.succeed({ operatorReleasedControl: true }),
        },
      }),
    ).pipe(Effect.exit);

    expect(outcome._tag).toBe("Failure");
    expect(fixture.connectionIds).toHaveLength(0);
    expect(fixture.releaseIds).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "operator-only Live View retains exact-page pictures and real input on its original connection",
  () =>
    Effect.gen(function* () {
      const site = yield* movingSite;
      const fixture = yield* localAgentBrowser;

      const record = journal("operator-only-continuity");
      const log = yield* makeInputLog({ origins: [new URL(site.url).origin], maxEvents: 128 });
      const shown = yield* Deferred.make<void>();
      const release = yield* Deferred.make<unknown>();

      yield* withGenericAgentBrowser(
        liveViewFixture(fixture),
        Effect.gen(function* () {
          const browser = yield* BrowserbaseBrowser.open(
            BrowserPolicy.unrestricted({ maxActions: 1, maxElapsedMillis: 30000 }),
            { bootstrap: log.bootstrap },
          );

          const onAir = browser.initialPage;

          yield* onAir.navigate({ url: site.url });

          const referenceRun = yield* operatorOnlyReference(record, browser, {
            onAir,
            inputLog: log,
            durationMillis: 5000,
            provenance: "unpaid-operator-protocol-fixture",
            operator: {
              showLiveView: (view) =>
                Effect.gen(function* () {
                  expect(Redacted.value(view.session)).toContain("unpaid-live-view-fixture");
                  expect(JSON.stringify(view)).not.toContain("unpaid-live-view-fixture");
                  yield* Deferred.succeed(shown, undefined);
                }),
              waitReleased: Deferred.await(release),
            },
          }).pipe(Effect.forkScoped);

          yield* Effect.raceFirst(Deferred.await(shown), Fiber.join(referenceRun));
          expect((yield* browser.status).phase).toBe("open");
          const framesAtShow = record.recording?.frames.length ?? 0;

          // The public instrumentation hook supplies the maintained existing connection.
          const native = fixture.nativeConnection() as PlaywrightBrowser | undefined;

          const operatorPage = native
            ?.contexts()[0]
            ?.pages()
            .find((page) => page.url() === site.url);

          if (operatorPage === undefined)
            return yield* BenchError.make({
              operation: "operator fixture",
              message: "Original native Page missing.",
            });
          // Only this fixture actor drives the already-connected native Page, like Live View input.
          yield* Effect.tryPromise({
            try: async () => {
              await operatorPage.mouse.move(80, 120);
              await operatorPage.mouse.click(80, 120);
              await operatorPage.mouse.wheel(0, 120);
              await operatorPage.keyboard.press("a");
            },
            catch: () =>
              BenchError.make({
                operation: "operator fixture",
                message: "Native operator input failed.",
              }),
          });
          yield* Effect.sleep("400 millis");
          const inputs = log.snapshot();
          const frames = record.recording?.frames ?? [];

          expect(frames.length).toBeGreaterThan(framesAtShow + 1);
          expect(
            Buffer.compare(
              frames[framesAtShow]?.bytes ?? Buffer.alloc(0),
              frames.at(-1)?.bytes ?? Buffer.alloc(0),
            ),
          ).not.toBe(0);
          for (const kind of [
            "pointermove",
            "pointerdown",
            "pointerup",
            "wheel",
            "keydown",
            "keyup",
          ])
            expect(inputs.events.some((event) => event.kind === kind && event.trusted)).toBe(true);
          expect(inputs.lost).toBe(0);
          expect(
            inputs.events.every((event) => event.sourceOrigin === new URL(site.url).origin),
          ).toBe(true);
          expect((yield* browser.status).actions.used).toBe(1);
          expect(fixture.releaseIds).toHaveLength(0);
          yield* Deferred.succeed(release, { operatorReleasedControl: true });
          yield* Fiber.join(referenceRun);
          expect((yield* browser.status).phase).toBe("closed");
        }),
      );
      expect(fixture.connectionIds).toHaveLength(1);
      expect(fixture.releaseIds).toHaveLength(1);
      expect(record.ownerClose).toBe("confirmed");
      expect(record.cleanup).toBe("confirmed");
      expect(record.recording?.nativeStop).toBe("confirmed");
      expect(record.metrics).toMatchObject({
        mode: "operator-only-live-view",
        operatorReleased: true,
        capture: "active-through-operator-interval",
        operatorInputDelivery: "binding-active",
        humanFootage: "protocol-fixture-only",
        panelEligible: false,
      });

      const cursors = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ cursorSamples: Schema.Array(CursorSample) }),
      )(record.truth);

      expect(
        cursors.cursorSamples.some(
          (sample) =>
            sample.kind === "press" &&
            sample.qualification === "native-input" &&
            sample.point.x === 80 &&
            sample.point.y === 120 &&
            sample.atMillis > 0 &&
            sample.atMillis < 5000,
        ),
      ).toBe(true);
      expect(record.truth).toMatchObject({
        cursorClock: {
          qualification: "browser-reported-shared-unix-epoch",
          videoStartSourceMillis: record.recording?.frames[0]?.sourceTimeMillis,
        },
      });
      expect(record.snapshot().events.filter((event) => event.kind === "request")).toHaveLength(0);
      expect(JSON.stringify(record.snapshot())).not.toContain("unpaid-live-view-fixture");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const stop of ["timeout", "cancel"] as const)
  it.live(
    `operator-only ${stop} stops capture and checks the original owner without claiming release`,
    () =>
      Effect.gen(function* () {
        const site = yield* movingSite;
        const fixture = yield* localAgentBrowser;
        const record = journal(`operator-only-${stop}`);
        const log = yield* makeInputLog({ origins: [new URL(site.url).origin], maxEvents: 128 });
        const shown = yield* Deferred.make<void>();

        yield* withGenericAgentBrowser(
          liveViewFixture(fixture),
          Effect.gen(function* () {
            const browser = yield* BrowserbaseBrowser.open(
              BrowserPolicy.unrestricted({ maxActions: 1, maxElapsedMillis: 30000 }),
              { bootstrap: log.bootstrap },
            );

            yield* browser.initialPage.navigate({ url: site.url });

            const running = yield* operatorOnlyReference(record, browser, {
              onAir: browser.initialPage,
              inputLog: log,
              durationMillis: stop === "timeout" ? 1000 : 5000,
              provenance: "unpaid-operator-protocol-fixture",
              operator: {
                showLiveView: () => Deferred.succeed(shown, undefined).pipe(Effect.asVoid),
                waitReleased: Effect.never,
              },
            }).pipe(Effect.forkScoped);

            yield* Effect.raceFirst(Deferred.await(shown), Fiber.join(running));
            expect((yield* browser.status).phase).toBe("open");
            expect(fixture.releaseIds).toHaveLength(0);
            if (stop === "cancel") {
              yield* Effect.sleep("200 millis");
              yield* Fiber.interrupt(running);
            } else {
              expect((yield* Fiber.await(running))._tag).toBe("Failure");
            }
            expect((yield* browser.status).phase).toBe("closed");
          }),
        );
        expect(fixture.connectionIds).toHaveLength(1);
        expect(fixture.releaseIds).toHaveLength(1);
        expect(record.failure).toBe(stop === "timeout" ? "TimeoutError" : "Interrupt");
        expect(record.ownerClose).toBe("confirmed");
        expect(record.cleanup).toBe("confirmed");
        expect(record.recording?.nativeStop).toBe("confirmed");
        expect(record.metrics).toMatchObject({
          mode: "operator-only-live-view",
          operatorReleased: false,
          capture: "operator-release-not-received",
          panelEligible: false,
        });
        expect(JSON.stringify(record.snapshot())).not.toContain("unpaid-live-view-fixture");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

it.live("operator-only false release is refused before checked cleanup", () =>
  Effect.gen(function* () {
    const site = yield* movingSite;
    const fixture = yield* localAgentBrowser;
    const record = journal("operator-only-refused-release");

    const outcome = yield* withGenericAgentBrowser(
      liveViewFixture(fixture),
      openOperatorOnlyReference(record, {
        url: site.url,
        origins: [new URL(site.url).origin],
        durationMillis: 3000,
        provenance: "unpaid-operator-protocol-fixture",
        operator: {
          showLiveView: () => Effect.void,
          waitReleased: Effect.succeed({ operatorReleasedControl: false }),
        },
      }),
    ).pipe(Effect.exit);

    expect(outcome._tag).toBe("Failure");
    expect(record.failure).toBe("SchemaError");
    expect(record.metrics).toMatchObject({
      mode: "operator-only-live-view",
      operatorReleased: false,
      panelEligible: false,
    });
    expect(record.ownerClose).toBe("confirmed");
    expect(record.cleanup).toBe("confirmed");
    expect(record.recording?.nativeStop).toBe("confirmed");
    expect(fixture.connectionIds).toHaveLength(1);
    expect(fixture.releaseIds).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("operator-only options are checked before provider allocation", () =>
  Effect.gen(function* () {
    const fixture = yield* localAgentBrowser;

    for (const options of [
      { url: "https://example.com/", origins: ["https://example.com"], durationMillis: 900001 },
      { url: "https://example.com/", origins: ["https://example.com"], durationMillis: 6001 },
      { url: "malformed", origins: ["https://example.com"], durationMillis: 1000 },
      { url: "https://example.com/", origins: ["https://another.example"], durationMillis: 1000 },
    ]) {
      const outcome = yield* withGenericAgentBrowser(
        liveViewFixture(fixture),
        openOperatorOnlyReference(journal("operator-only-invalid-options"), {
          ...options,
          operator: {
            showLiveView: () => Effect.void,
            waitReleased: Effect.succeed({ operatorReleasedControl: true }),
          },
        }),
      ).pipe(Effect.exit);

      expect(outcome._tag).toBe("Failure");
    }
    expect(fixture.createBodies).toHaveLength(0);
    expect(fixture.connectionIds).toHaveLength(0);
    expect(fixture.releaseIds).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("operator-only capture bounds qualify a released interval as incomplete", () =>
  Effect.gen(function* () {
    const site = yield* movingSite;
    const fixture = yield* localAgentBrowser;
    const original = journal("operator-only-capture-bound");

    const record = new Journal({
      ...original.manifest,
      capture: { ...original.manifest.capture, maxFrames: 2 },
    });

    yield* withGenericAgentBrowser(
      liveViewFixture(fixture),
      openOperatorOnlyReference(record, {
        url: site.url,
        origins: [new URL(site.url).origin],
        durationMillis: 3000,
        provenance: "unpaid-operator-protocol-fixture",
        operator: {
          showLiveView: () => Effect.void,
          waitReleased: Effect.sleep("400 millis").pipe(
            Effect.as({ operatorReleasedControl: true }),
          ),
        },
      }),
    );
    expect(record.recording?.limitReached).toBe("frames");
    expect(record.recording?.nativeStop).toBe("confirmed");
    expect(record.metrics).toMatchObject({
      mode: "operator-only-live-view",
      operatorReleased: true,
      capture: "operator-interval-incomplete",
      humanFootage: "protocol-fixture-only",
      panelEligible: false,
    });
    expect(record.ownerClose).toBe("confirmed");
    expect(record.cleanup).toBe("confirmed");
    expect(fixture.connectionIds).toHaveLength(1);
    expect(fixture.releaseIds).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "operator-only startup navigation failure retains checked cleanup and never offers Live View",
  () =>
    Effect.gen(function* () {
      const site = yield* movingSite;
      const fixture = yield* localAgentBrowser;
      const record = journal("operator-only-startup-failure");
      let shown = false;

      const outcome = yield* withGenericAgentBrowser(
        liveViewFixture(fixture),
        openOperatorOnlyReference(record, {
          url: new URL("/broken", site.url).href,
          origins: [new URL(site.url).origin],
          durationMillis: 1000,
          provenance: "unpaid-operator-protocol-fixture",
          operator: {
            showLiveView: () =>
              Effect.sync(() => {
                shown = true;
              }),
            waitReleased: Effect.succeed({ operatorReleasedControl: true }),
          },
        }),
      ).pipe(Effect.exit);

      expect(outcome._tag).toBe("Failure");
      expect(shown).toBe(false);
      expect(record.recording).toBeUndefined();
      expect(record.failure).toBe("BrowserError");
      expect(record.ownerClose).toBe("confirmed");
      expect(record.cleanup).toBe("confirmed");
      expect(fixture.connectionIds).toHaveLength(1);
      expect(fixture.releaseIds).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
