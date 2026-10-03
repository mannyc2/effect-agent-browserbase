import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Tools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import * as AgentRuntime from "effect-agent/agent-runtime";
import type { LanguageModel } from "effect/unstable/ai";

import { run } from "../bench/Backends.ts";
import { answer, call, picture, scripted } from "../bench/Drivers.ts";
import { BenchError, Journal } from "../bench/Records.ts";
import { conditions, understanding, type Condition, type Scene } from "../bench/Understanding.ts";
import { tableSite } from "../fixtures/TableSite.ts";

const journal = (scene: Scene, condition: Condition, answer: "correct" | "wrong") =>
  new Journal({
    version: 1,
    runId: `${scene}-${condition}-${answer}`,
    scene,
    backend: "chromium",
    driver: "scripted",
    sourceRevision: "native-test-fixture",
    sourceDirty: false,
    trial: 0,
    seed: 2,
    viewport: { width: 1280, height: 720 },
    settings: { condition, answer },
    capture: { maxFrames: 180, maxBytes: 24 * 1024 * 1024, quality: 50, maxDurationMillis: 15000 },
  });

const currentImage = (request: LanguageModel.ProviderOptions) => {
  const files = request.prompt.content.flatMap((message) =>
    message.role === "user" ? message.content.filter((part) => part.type === "file") : [],
  );

  expect(files).toHaveLength(1);
  const image = files[0];

  if (image?.type !== "file" || typeof image.data !== "string") throw new Error("PNG data missing");
  const bytes = Buffer.from(image.data, "base64");

  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(16)).toBe(640);
  expect(bytes.readUInt32BE(20)).toBe(360);
  expect(JSON.stringify(request.prompt)).toContain("Multiply pictured coordinates by 2");

  return image.data;
};

it.live(
  "each actual AgentRuntime call receives the current half-size PNG without retaining files in history",
  () =>
    Effect.gen(function* () {
      const site = yield* tableSite(0);
      const record = journal("read-table", "picture", "correct");
      let first = "";
      let second = "";

      const driver = scripted(record, [
        (request) => {
          first = currentImage(request);

          return call("visit", "browser_navigate", { url: site.url });
        },
        (request) => {
          second = currentImage(request);

          return answer({ done: true });
        },
      ]);

      yield* run(record, (browser) =>
        Effect.gen(function* () {
          const host = yield* Tools.makeHost(browser, browser.initialPage);

          const narrator = Agent.make("picture-per-call", {
            input: Schema.String,
            output: Schema.Struct({ done: Schema.Boolean }),
            toolkit: Tools.toolkit,
            instructions: "Visit the requested table, then confirm completion.",
            policy: { ...Tools.policy(), maxTurns: 3, maxToolCalls: 2 },
          });

          const result = yield* host.run(
            driver.provide(
              AgentRuntime.run(narrator, "Visit the table.", {
                onHistory: (history) =>
                  driver.history(history).pipe(
                    Effect.asVoid,
                    Effect.mapError(() =>
                      BenchError.make({
                        operation: "history",
                        message: "Cannot encode picture test history.",
                      }),
                    ),
                  ),
                transientContext: picture(browser.initialPage, { every: "call", scale: 0.5 }),
              }),
            ),
          );

          expect(result.output).toEqual({ done: true });
        }),
      );
      expect(first).not.toBe(second);
      expect(record.snapshot().events.filter((event) => event.kind === "request")).toHaveLength(2);
      expect(
        JSON.stringify(record.snapshot().events.filter((event) => event.kind === "history")),
      ).not.toContain("image/png");
      expect(record.cleanup).toBe("confirmed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const condition of conditions)
  for (const answer of ["correct", "wrong"] as const)
    it.live(
      `read-table ${condition} ${answer} uses structured AgentRuntime output and transient screen evidence`,
      () =>
        Effect.gen(function* () {
          const record = journal("read-table", condition, answer);

          const samples = yield* run(record, (browser) =>
            understanding(record, browser, { condition, scriptedAnswer: answer }),
          );

          const sample = samples[0];

          expect(sample?.grade.correct).toBe(answer === "correct" ? 5 : 0);
          expect(sample?.grade.anyFalseFact).toBe(answer === "wrong");
          expect(sample?.grade.columnConfusion).toBe(answer === "wrong");
          expect(record.cleanup).toBe("confirmed");
          expect(record.ownerClose).toBe("confirmed");
          const events = record.snapshot().events;
          const requests = events.filter((event) => event.kind === "request");
          const request = JSON.stringify(requests);

          expect(requests).toHaveLength(1);
          expect(request).toContain("Final output contract:");
          expect(sample?.callLatencyMillis).toHaveLength(1);
          expect(request).toContain("image/png");
          expect(request).toContain("0.5 scale");
          expect(request.includes("Visible text (")).toBe(condition !== "picture");
          expect(request.includes("Step digest:")).toBe(condition === "digest");
          expect(JSON.stringify(events.filter((event) => event.kind === "history"))).not.toContain(
            "image/png",
          );
          expect(samples.map((value) => value.output.caption)).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

for (const scene of ["read-game", "narrate-walk"] as const)
  for (const answer of ["correct", "wrong"] as const)
    it.live(`${scene} ${answer} grades real fixture outcomes after native actions`, () =>
      Effect.gen(function* () {
        const record = journal(scene, "digest", answer);

        const samples = yield* run(record, (browser) =>
          understanding(record, browser, {
            condition: "digest",
            scriptedAnswer: answer,
            moments: 1,
          }),
        );

        expect(samples).toHaveLength(scene === "read-game" ? 1 : 4);
        expect(samples.every((sample) => sample.grade.anyFalseFact === (answer === "wrong"))).toBe(
          true,
        );
        expect(
          samples.every(
            (sample) => sample.grade.correct === (answer === "correct" ? sample.grade.total : 0),
          ),
        ).toBe(true);
        if (scene === "read-game") {
          expect(samples[0]?.truth.facts).toEqual({
            balance: 1490,
            bet: 10,
            win: 500,
            notable: "big-win",
          });
          expect(samples[0]?.grade.moneyCorrect).toBe(answer === "correct" ? 3 : 0);
        } else
          expect(samples.at(-1)?.truth.facts).toEqual({
            page: "article",
            tab: "Overview",
            item: "Alpha",
            query: "",
          });
        expect(record.cleanup).toBe("confirmed");
        expect(record.ownerClose).toBe("confirmed");
        const histories = record.snapshot().events.filter((event) => event.kind === "history");

        expect(histories.length).toBeGreaterThanOrEqual(samples.length);
        expect(JSON.stringify(histories)).not.toContain("image/png");
        expect(record.recording?.frames.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
