import * as Agent from "@yielded/agent/agent";
import * as AgentRuntime from "@yielded/agent/agent-runtime";
import { Cause, Effect, Option, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import type * as Browser from "effect-browser/browser";
import { ObservedElement } from "effect-browser/browser-data";

import { type GameKind } from "../fixtures/GameCore.ts";
import { enterGame, waitForGame } from "../fixtures/GameDriver.ts";
import { gameSite, type GameSite } from "../fixtures/GameSite.ts";
import { inspectionObservation, inspectionReference } from "../fixtures/Inspection.ts";
import { filming } from "./Backends.ts";
import { answer, call, scripted } from "./Drivers.ts";
import { executionStyle, type StyleOptions } from "./ExecutionStyle.ts";
import { BenchError, type Journal, json, tagOf } from "./Records.ts";

export const gameDrivers = ["dom-twin", "canvas-keys", "canvas-click", "agent-tools"] as const;
export type GameDriver = (typeof gameDrivers)[number];

const Options = Schema.Struct({
  spins: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});

/** Actual maintained tools over the top Page; scripted turns consume their real observations. */
const topPageAgent = Effect.fn("Bench.games.topPageAgent")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  url: string,
) {
  const agent = Agent.make("canvas-game-top-page", {
    input: Schema.String,
    output: Schema.Struct({ done: Schema.Boolean }),
    instructions: BrowserTools.instructions(BrowserTools.toolkit),
    toolkit: BrowserTools.toolkit,
    policy: { ...BrowserTools.policy(), maxTurns: 12, maxToolCalls: 10, maxDuration: "30 seconds" },
  });

  const host = yield* BrowserTools.makeHost(browser, browser.initialPage);
  let controls: ReadonlyArray<string> = [];
  let text = "";

  const driver = scripted(journal, [
    () => call("navigate", "browser_navigate", { url }),
    () => call("cookies", "browser_inspect", {}),
    (request) => call("accept", "browser_click", inspectionReference(request, "Accept")),
    () => call("age", "browser_inspect", {}),
    (request) => call("confirm", "browser_click", inspectionReference(request, "I am 18 or older")),
    () => call("lobby", "browser_inspect", {}),
    (request) => {
      const observation = inspectionObservation(request);
      const control = observation.controls[0];

      if (control === undefined) throw new Error("No observed game entry");

      return call("play", "browser_click", {
        observationId: observation.observationId,
        elementId: control.elementId,
      });
    },
    () => call("game", "browser_inspect", {}),
    (request) => {
      const observation = inspectionObservation(request);

      controls = observation.controls.map((control) => control.label);
      text = observation.text;

      return answer({ done: true });
    },
  ]);

  yield* host.run(
    driver.provide(
      AgentRuntime.run(agent, "Enter the demo game and inspect its controls.", {
        onHistory: driver.history,
      }),
    ),
  );
  const snapshot = yield* host.toolFailures;

  return {
    controls,
    text,
    failures: snapshot.failures.map((failure) => ({
      tag: failure.error._tag,
      operation: failure.error.operation,
      reason: failure.error.reason._tag,
      outcome: failure.error.outcome,
      toolName: failure.toolName,
    })),
  };
});

/** One independent matrix cell per run, graded from the fixture ledger rather than an agent answer. */
export const gamesOperability = Effect.fn("Bench.gamesOperability")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: StyleOptions & {
    readonly spins?: number;
    readonly site?: GameSite;
  } = {},
) {
  const config = yield* Schema.decodeEffect(Options)({ spins: options.spins ?? 10 });
  const driver = journal.manifest.driver;

  if (!gameDrivers.some((candidate) => candidate === driver))
    return yield* new BenchError({
      operation: "games driver",
      message: "Choose dom-twin, canvas-keys, canvas-click or agent-tools.",
    });
  if (journal.manifest.backend !== "chromium" && options.site === undefined)
    return yield* new BenchError({
      operation: "games fixture",
      message: "Cross-site hosted games need two separately reachable fixture origins.",
    });
  const kind: GameKind = driver === "dom-twin" ? "reels-dom" : "reels";
  const site = options.site ?? (yield* gameSite({ seed: journal.manifest.seed }));
  const page = browser.initialPage;

  const timings: Array<{
    spin: number;
    actionMillis: number;
    totalMillis: number;
    startedAt: number;
    completedAt: number;
  }> = [];

  const typedFailures: Array<{
    tag: string;
    operation: string;
    reason: string | null;
    outcome: string | null;
  }> = [];

  let reachedGame = false;
  let step = "lobby";
  let blockedStep: string | null = null;
  let gap: string | null = null;
  let observedControls: ReadonlyArray<string> = [];
  let observedText = "";
  let finalBalanceText: string | null = null;

  yield* filming(
    journal,
    page,
    Effect.gen(function* () {
      let frame: Browser.Frame | undefined;

      if (driver === "agent-tools") {
        const observation = yield* topPageAgent(journal, browser, site.url);

        observedControls = observation.controls;
        observedText = observation.text;
        typedFailures.push(...observation.failures);
        yield* waitForGame(site, kind, (state) => state.ready, "agent reached game");
        reachedGame = true;
        blockedStep = "top-page-observation";
        gap = "Top Page observations do not include the child Frame's controls or text.";

        return;
      }
      frame = yield* enterGame(page, site, kind);
      reachedGame = true;
      step = "frame-observation";
      const observation = yield* frame.observe();

      observedControls = observation.controls.map((control) => control.label);
      observedText = observation.text;
      for (let spin = 1; spin <= config.spins; spin++) {
        step = `spin-${spin}`;
        const startedAt = journal.elapsedMillis();

        if (driver === "dom-twin") {
          const reading = yield* frame.observe();
          const button = reading.controls.find((control) => control.label === "SPIN");

          if (button === undefined)
            return yield* new BenchError({
              operation: "spin",
              message: "No observed SPIN control in HTML twin.",
            });
          yield* frame.clickElement(
            ObservedElement.make({
              observationId: reading.observationId,
              elementId: button.elementId,
            }),
          );
        } else if (driver === "canvas-click") {
          const at = { x: (journal.manifest.viewport.width - 960) / 2 + 815, y: 570 };

          if (options.style === "performed")
            yield* page.run(
              { version: 1, steps: [{ id: `spin-${spin}`, action: { _tag: "PointerClick", at } }] },
              {
                style: yield* executionStyle(options, journal.manifest.seed + spin),
                within: 15000,
              },
            );
          else yield* page.pointerClick(at);
        } else yield* frame.press({ key: " ", into: "#game-canvas" });
        const actionMillis = journal.elapsedMillis() - startedAt;

        yield* waitForGame(
          site,
          kind,
          (state) => state.spin === spin && state.phase === "idle",
          `spin ${spin} complete`,
        );
        const completedAt = journal.elapsedMillis();

        const timing = {
          spin,
          actionMillis,
          totalMillis: completedAt - startedAt,
          startedAt,
          completedAt,
        };

        timings.push(timing);
        journal.append({ kind: "host", turn: null, value: json({ driver, ...timing }) });
      }
      if (driver === "dom-twin")
        finalBalanceText = (yield* frame.readText({ selector: "#balance" })).text;
      step = "complete";
    }).pipe(
      Effect.catchCause((cause) => {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));

        const checked = Schema.is(
          Schema.Struct({
            operation: Schema.String,
            reason: Schema.Struct({ _tag: Schema.String }),
            outcome: Schema.String,
          }),
        )(failure)
          ? failure
          : undefined;

        blockedStep = step;
        typedFailures.push({
          tag: tagOf(cause),
          operation: checked?.operation ?? step,
          reason: checked?.reason._tag ?? null,
          outcome: checked?.outcome ?? null,
        });

        return Effect.failCause(cause);
      }),
      Effect.ensuring(
        Effect.sync(() => {
          const receipts = site.events();
          const state = site.state(kind);

          const results = receipts.filter(
            (receipt) => receipt.kind === kind && receipt.event.tag === "result",
          );

          for (const receipt of receipts)
            journal.append({ kind: "truth", turn: null, value: json(receipt) });
          journal.truth = json({
            seed: site.seed,
            credits: site.credits,
            kind,
            events: receipts,
            state,
            deliveryFailures: site.failures(),
            receivedEvents: site.receivedEvents(),
          });
          journal.metrics = json({
            driver,
            reachedGame,
            blockedStep,
            gap,
            spinsRequested: config.spins,
            spinsCompleted: results.length,
            spinTimings: timings,
            finalBalance: state.balance,
            finalBalanceText,
            observedControls,
            observedText,
            typedFailures,
          });
        }),
      ),
    ),
  );
});
