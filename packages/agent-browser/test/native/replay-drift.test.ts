import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Browser from "effect-browser/browser";
import {
  BrowserPolicy,
  Observation,
  ObservedElement,
  type InputReceipt,
} from "effect-browser/browser-data";
import { Chromium, type ChromiumCleanupResult } from "effect-browser/chromium";
import * as Plan from "effect-browser/plan";
import { Toolkit } from "effect/ai";

import { Journal } from "../bench/Records.ts";
import { matrix } from "../bench/Replay.ts";
import { replayContention } from "../bench/ReplayScenes.ts";
import { driftSite } from "../fixtures/DriftSite.ts";

// fe6e26d reused a cacheable redirect and had no independently observable decoy destination.
it.live(
  "fresh navigation leaves redirect drift and an adversarial decoy has distinct host truth",
  () =>
    Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 50, maxElapsedMillis: 30000 })),
      (browser) =>
        Effect.gen(function* () {
          const site = yield* driftSite;
          const first = yield* browser.createPage();

          site.configure("redirect", 1, "redirect-first");
          expect((yield* first.navigate({ url: `${site.url}/portal` })).url).toBe(
            `${site.url}/new-portal`,
          );
          yield* first.close();
          site.configure("duplicate", 1, "decoy-next");
          const next = yield* browser.createPage();

          expect((yield* next.navigate({ url: `${site.url}/portal` })).url).toBe(
            `${site.url}/portal`,
          );
          const observation = yield* next.observe({ scope: "document" });

          expect(observation.controls.filter((item) => item.label === "Markets")).toHaveLength(3);
          yield* next.click({ selector: '[data-page="decoy"]' });
          for (
            let attempt = 0;
            attempt < 100 && site.truth("decoy-next")?.page !== "decoy";
            attempt++
          )
            yield* Effect.sleep(10);
          expect(site.truth("decoy-next")).toMatchObject({ page: "decoy" });
          yield* next.close();
        }),
    ).pipe(
      Effect.provide(
        Chromium.layer({
          launch: { chromiumSandbox: false },
        }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    ),
);

// Requested replay seam: indistinguishable destinations must refuse both actual recording paths.
it.live.each(["page", "tools"] as const)(
  "%s recording refuses identical candidates on a fresh Page without visiting the decoy",
  (path) => {
    const cleanup: ChromiumCleanupResult[] = [];

    return Effect.scoped(
      Effect.gen(function* () {
        const site = yield* driftSite;

        yield* Browser.scoped(
          Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 50, maxElapsedMillis: 30000 })),
          (browser) =>
            Effect.gen(function* () {
              site.configure("none", 0, `${path}-baseline`);
              const baseline = yield* browser.createPage();

              const recorded = yield* Effect.gen(function* () {
                if (path === "page")
                  return yield* baseline
                    .run(
                      {
                        version: 1,
                        steps: [
                          {
                            id: "navigate",
                            action: { _tag: "Navigate", url: `${site.url}/portal` },
                          },
                          {
                            id: "markets",
                            action: {
                              _tag: "Click",
                              target: {
                                _tag: "Descriptor",
                                descriptor: { kind: "link", label: "Markets" },
                              },
                            },
                          },
                        ],
                      },
                      { within: 10000 },
                    )
                    .pipe(Effect.flatMap(Plan.recorded));

                const host = yield* BrowserTools.makeHost(browser, baseline);

                yield* host.run(
                  Effect.gen(function* () {
                    const tools = yield* BrowserTools.toolkit;

                    expect(
                      yield* Stream.runCollect(
                        yield* tools.handle("browser_navigate", { url: `${site.url}/portal` }),
                      ),
                    ).toMatchObject([{ isFailure: false }]);

                    const observation = yield* baseline.observe({
                      scope: "document",
                      match: "Markets",
                    });

                    expect(observation.controls).toHaveLength(1);

                    const reference = ObservedElement.make({
                      observationId: observation.observationId,
                      elementId: observation.controls[0]?.elementId ?? "",
                    });

                    expect(
                      yield* Stream.runCollect(yield* tools.handle("browser_click", reference)),
                    ).toMatchObject([{ isFailure: false }]);
                  }),
                );
                const snapshot = yield* host.receipts;

                expect(snapshot.dropped).toBe(0);
                expect(snapshot.receipts.map((receipt) => receipt._tag)).toEqual([
                  "Navigation",
                  "Run",
                ]);

                const parts = yield* Effect.forEach(snapshot.receipts, (receipt) =>
                  receipt._tag === "Navigation"
                    ? Plan.recordedNavigation(receipt.operation)
                    : receipt._tag === "Run"
                      ? receipt.operation.completed.pipe(Effect.flatMap(Plan.recorded))
                      : Effect.die("Baseline tool unexpectedly refused"),
                );

                return yield* Plan.decode({
                  version: 1,
                  steps: parts
                    .flatMap((part) => part.steps)
                    .map((step, index) => ({ ...step, id: `recorded-${index}` })),
                });
              });

              const click = recorded.steps[1]?.action;

              expect(click).toMatchObject({
                _tag: "Click",
                target: {
                  _tag: "Descriptor",
                  descriptor: {
                    kind: "link",
                    label: "Markets",
                    destination: `${site.url}/markets`,
                  },
                },
              });
              if (click?._tag === "Click") expect(click.target.descriptor.ordinal).toBeUndefined();
              yield* baseline.close();

              const run = `${path}-identical`;

              site.configure("duplicate", 1, run);
              const page = yield* browser.createPage();
              const decoded = yield* Plan.decode(yield* Plan.encode(recorded));
              const outcome = yield* page.run(decoded, { within: 10000 }).pipe(Effect.result);

              expect(outcome).toMatchObject({
                _tag: "Failure",
                failure: {
                  _tag: "StepFailed",
                  error: { reason: { _tag: "Ambiguous", count: 2 }, outcome: "undispatched" },
                },
              });
              if (outcome._tag === "Failure") expect(outcome.failure.completed).toHaveLength(1);
              expect((yield* page.status).phase).toBe("open");
              const observation = yield* page.observe({ scope: "document", match: "Markets" });

              expect(observation.target.pageId).toBe(page.identity.pageId);
              expect(observation.url).toBe(`${site.url}/portal`);
              expect(observation.controls).toHaveLength(3);
              for (let attempt = 0; attempt < 100 && site.truth(run) === undefined; attempt++)
                yield* Effect.sleep(10);
              expect(site.truth(run)).toEqual({
                page: "portal",
                tab: "Overview",
                item: "",
                query: "",
              });
              expect(
                site
                  .events()
                  .filter((event) => event.run === run)
                  .every((event) => event.truth.page === "portal"),
              ).toBe(true);
              expect(site.lost()).toBe(0);
              yield* page.close();
            }),
        ).pipe(
          Effect.provide(
            Chromium.layer({
              launch: { chromiumSandbox: false },
              onCleanup: (result) => Effect.sync(() => cleanup.push(result)),
            }).pipe(Layer.provide(NodeCrypto.layer)),
          ),
        );
        expect(cleanup).toMatchObject([
          { ownership: "owned", connection: "closed", process: "terminated", issues: [] },
        ]);
      }),
    );
  },
);

it.live(
  "fresh-page replay uses actual Page and ToolHost recordings and retains typed drift failures and complete navigation readiness timing",
  () =>
    Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 500, maxElapsedMillis: 60000 })),
      (browser) =>
        Effect.gen(function* () {
          const result = yield* matrix(browser, {
            walkIds: ["prices-hover"],
            operators: ["reorder", "overlay", "slow"],
            seeds: [2],
          });

          expect(result.cells).toHaveLength(6);
          for (const cell of result.cells) {
            if (cell.operator === "overlay")
              // fe6e26d labelled the uncertain dispatched timeout as a typed refusal.
              expect(cell).toMatchObject({
                outcome: "unknown",
                dispatch: "unknown",
                pagePhase: "closed",
              });
            else expect(cell.outcome).toBe("replayed");
            if (cell.operator === "slow")
              expect(
                cell.stepMillis.slice(0, 2).reduce((sum, millis) => sum + millis, 0),
              ).toBeGreaterThanOrEqual(1000);
          }
          expect(result.cells.every((cell) => cell.outcome !== "wrong-place")).toBe(true);
          expect(result.lostTruthEvents).toBe(0);
        }),
    ).pipe(
      Effect.provide(
        Chromium.layer({
          actionTimeoutMillis: 5000,
          launch: {
            ...(process.env.BROWSERBASE_CHROMIUM === undefined
              ? {}
              : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            chromiumSandbox: false,
          },
        }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    ),
  60000,
);

it.live(
  "replay contention retains the exact on-air interval and independent host truth",
  () => {
    const journal = new Journal({
      version: 1,
      runId: "native-replay-contention",
      scene: "replay-contention",
      backend: "chromium",
      driver: "scripted",
      sourceRevision: "native",
      sourceDirty: false,
      trial: 0,
      seed: 2,
      viewport: { width: 1280, height: 720 },
      settings: {},
      capture: {
        maxFrames: 2000,
        maxBytes: 16 * 1024 * 1024,
        quality: 30,
        maxDurationMillis: 30000,
      },
    });

    return Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 500, maxElapsedMillis: 60000 })),
      (browser) =>
        Effect.gen(function* () {
          const result = yield* replayContention(journal, browser, {
            walkIds: ["overview-article"],
            operators: ["reorder"],
            seeds: [2],
            beforeAfterMillis: 500,
          });

          expect(result.cells).toHaveLength(2);
          expect(result.cells.every((cell) => cell.outcome === "replayed")).toBe(true);
          expect(journal.recording?.summary).toMatchObject({
            target: { pageId: browser.initialPage.identity.pageId },
          });
          expect(journal.recording?.nativeStop).toBe("confirmed");
          expect(journal.recording?.limitReached).toBeNull();
          expect(journal.metrics).toMatchObject({
            replay: { lostSteps: 0, additionalLostSteps: null },
            picture: [{ phase: "before" }, { phase: "during" }, { phase: "after" }],
          });
          expect(result.lostTruthEvents).toBe(0);
        }),
    ).pipe(
      Effect.provide(
        Chromium.layer({
          actionTimeoutMillis: 5000,
          viewport: journal.manifest.viewport,
          launch: {
            ...(process.env.BROWSERBASE_CHROMIUM === undefined
              ? {}
              : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            chromiumSandbox: false,
          },
        }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    );
  },
  60000,
);

it.live(
  "retention cutoff leaves later contention windows unmeasured",
  () => {
    const journal = new Journal({
      version: 1,
      runId: "native-replay-retention",
      scene: "replay-contention",
      backend: "chromium",
      driver: "scripted",
      sourceRevision: "native",
      sourceDirty: false,
      trial: 0,
      seed: 2,
      viewport: { width: 1280, height: 720 },
      settings: {},
      capture: { maxFrames: 10, maxBytes: 16 * 1024 * 1024, quality: 30, maxDurationMillis: 30000 },
    });

    return Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 500, maxElapsedMillis: 60000 })),
      (browser) =>
        Effect.gen(function* () {
          yield* replayContention(journal, browser, {
            walkIds: ["overview-article"],
            operators: ["reorder"],
            seeds: [2],
            paths: ["page"],
            beforeAfterMillis: 1000,
          });

          expect(journal.recording?.limitReached).toBe("frames");
          expect(journal.recording?.frames).toHaveLength(10);
          expect(journal.metrics).toMatchObject({
            picture: [
              { phase: "before" },
              { phase: "during" },
              { phase: "after", measurement: "unmeasured", cadence: null, freezes: null },
            ],
          });
        }),
    ).pipe(
      Effect.provide(
        Chromium.layer({
          actionTimeoutMillis: 5000,
          viewport: journal.manifest.viewport,
          launch: {
            ...(process.env.BROWSERBASE_CHROMIUM === undefined
              ? {}
              : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            chromiumSandbox: false,
          },
        }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    );
  },
  60000,
);

// Fixture list links keep distinct hit areas so a seeded performed hover reaches the intended node.
it.live("baseline portal permits a seeded exact-node hover without adjacent link overlap", () => {
  const cleanup: ChromiumCleanupResult[] = [];

  return Effect.scoped(
    Effect.gen(function* () {
      const site = yield* driftSite;
      const run = "native-baseline-hover";

      site.configure("none", 0, run);
      yield* Browser.scoped(
        Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 50, maxElapsedMillis: 30000 })),
        (browser) =>
          Effect.gen(function* () {
            const page = browser.initialPage;

            yield* page.navigate({ url: `${site.url}/portal` });
            const inputs: InputReceipt[] = [];

            const host = yield* BrowserTools.makeHost(browser, page, {
              execution: { style: { seed: 18 }, within: 10000 },
              onInput: ({ receipt }) => Effect.sync(() => inputs.push(receipt)),
            });

            const tools = yield* Toolkit.merge(
              BrowserTools.toolkit,
              BrowserTools.nativeToolkit,
            ).pipe(Effect.provide(Layer.merge(host.handlers, host.nativeHandlers)));

            const inspect = Effect.fnUntraced(function* () {
              const result = yield* Stream.runCollect(yield* tools.handle("browser_inspect", {}));

              return yield* Schema.decodeUnknownEffect(Observation)(result[0]?.result);
            });

            const reference = (observation: Observation, label: string) => {
              const matches = observation.controls.filter((control) => control.label === label);

              expect(matches).toHaveLength(1);

              return ObservedElement.make({
                observationId: observation.observationId,
                elementId: matches[0]?.elementId ?? "",
              });
            };

            const portal = yield* inspect();

            expect(
              yield* Stream.runCollect(
                yield* tools.handle("browser_click", reference(portal, "Markets")),
              ),
            ).toMatchObject([{ isFailure: false }]);
            const markets = yield* inspect();

            expect(
              yield* Stream.runCollect(
                yield* tools.handle("browser_click", reference(markets, "Prices")),
              ),
            ).toMatchObject([{ isFailure: false }]);
            expect(
              yield* Stream.runCollect(
                yield* tools.handle("browser_wheel", {
                  deltaX: 0,
                  deltaY: 120,
                  at: { x: 400, y: 400 },
                }),
              ),
            ).toMatchObject([{ isFailure: false }]);
            const afterWheel = yield* inspect();
            const beta = reference(afterWheel, "Beta article");
            const gamma = reference(afterWheel, "Gamma article");
            const betaFacts = yield* page.controlFacts(beta);
            const gammaFacts = yield* page.controlFacts(gamma);

            // The center remains reachable; the performed input must also pass the unchanged exact-node hit check.
            expect(betaFacts.hitTest).toBe("self");

            const hovered = yield* Stream.runCollect(
              yield* tools.handle("browser_hover", beta, "baseline-hover"),
            );

            console.log(
              "Native baseline hover geometry",
              JSON.stringify({
                beta: betaFacts.box,
                gamma: gammaFacts.box,
                documentScroll: afterWheel.viewport?.documentScroll,
                hovered,
                failures: (yield* host.toolFailures).failures,
              }),
            );
            expect(hovered).toMatchObject([
              { isFailure: false, encodedResult: { dispatched: true } },
            ]);
            expect(betaFacts.box.y + betaFacts.box.height).toBeLessThanOrEqual(gammaFacts.box.y);
            expect(inputs.filter((input) => input.kind === "hover")).toHaveLength(1);
            const refreshed = yield* inspect();

            expect(
              yield* Stream.runCollect(
                yield* tools.handle("browser_click", reference(refreshed, "Beta article")),
              ),
            ).toMatchObject([{ isFailure: false }]);
            for (let attempt = 0; attempt < 100 && site.truth(run)?.page !== "article"; attempt++)
              yield* Effect.sleep(10);
            expect(site.truth(run)).toMatchObject({ page: "article", tab: "Prices", item: "Beta" });
            expect(site.lost()).toBe(0);
            expect((yield* host.toolFailures).failures).toEqual([]);
          }),
      ).pipe(
        Effect.provide(
          Chromium.layer({
            viewport: { width: 1280, height: 720 },
            launch: {
              chromiumSandbox: false,
              startupTimeoutMillis: 25000,
              ...(process.env.BROWSERBASE_CHROMIUM === undefined
                ? {}
                : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            },
            onCleanup: (result) =>
              Effect.sync(() => {
                cleanup.push(result);
                console.log("Native baseline owner cleanup", result);
              }),
          }).pipe(Layer.provide(NodeCrypto.layer)),
        ),
      );
      expect(cleanup).toMatchObject([
        { ownership: "owned", connection: "closed", process: "terminated", issues: [] },
      ]);
    }),
  );
});
