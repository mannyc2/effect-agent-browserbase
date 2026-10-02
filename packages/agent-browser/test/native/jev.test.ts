import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/unstable/http";

import { allowance, measuredManifest, plan } from "../evaluation/Campaign.ts";
import { navigationAnswer } from "../evaluation/Cases.ts";
import { Journal, save } from "../evaluation/Evidence.ts";
import { grade } from "../evaluation/Grading.ts";
import { measured } from "../evaluation/Jev.ts";
import { replay } from "../evaluation/Replay.ts";
import { Ledger } from "../evaluation/Spend.ts";
import { run } from "../evaluation/Tasks.ts";

const Body = Schema.fromJsonString(
  Schema.Struct({
    questions: Schema.Struct({
      next: Schema.Struct({ criteria: Schema.Record(Schema.String, Schema.String) }),
    }),
  }),
);

/** A scripted decision response calibrates the bridge; it measures no real Jev accuracy. */
const wire = (confidence: number, refuse: boolean) => {
  const sent: string[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON body");
        sent.push(request.url);
        if (refuse)
          return HttpClientResponse.fromWeb(
            request,
            HttpServerResponse.toWeb(
              HttpServerResponse.jsonUnsafe({ message: "PRIVATE-PROVIDER-BODY" }, { status: 429 }),
            ),
          );
        const body = yield* Schema.decodeEffect(Body)(new TextDecoder().decode(request.body.body));
        const criteria = body.questions.next.criteria;
        const descriptions = Object.entries(criteria);

        const desired = [
          "Finish by returning this observed text line verbatim: Field note:",
          "Follow observed link: Marsh survey report",
          "Follow observed link: Library",
          "Open the supplied starting address",
          "Read fresh bounded text",
        ];

        const choice = desired.flatMap((prefix) =>
          descriptions
            .filter(([, description]) => description.startsWith(prefix))
            .map(([id]) => id),
        )[0];

        if (choice === undefined) return yield* Effect.die("No scripted decision candidate");

        return HttpClientResponse.fromWeb(
          request,
          HttpServerResponse.toWeb(
            HttpServerResponse.jsonUnsafe({
              model: "jev-1.13.0",
              answers: {
                next: {
                  type: "choice",
                  choice,
                  probabilities: Object.fromEntries(
                    descriptions.map(([id]) => [id, id === choice ? 1 : 0]),
                  ),
                  confidence,
                },
              },
              usage: { input_tokens: 1000, output_tokens: 6 },
            }),
          ),
        );
      }).pipe(Effect.orDie),
    ),
  );

  return { layer, sent };
};

const evaluate = (composition: "base" | "observed", confidence = 1, refuse = false) =>
  Effect.gen(function* () {
    const campaign = yield* plan({
      version: 1,
      name: "jev-offline-calibration",
      models: [
        {
          id: "jev",
          provider: "typesafe",
          gateway: "direct",
          model: "jev-1.13.0",
          maxOutputTokens: 0,
          reasoningEffort: null,
          decisionThreshold: 0.8,
          rates: {
            inputUsdPerMillion: 0.042,
            cacheReadUsdPerMillion: 0,
            cacheWriteUsdPerMillion: 0,
            outputUsdPerMillion: 0,
            source: "https://docs.typesafe.ai/models",
            retrieved: "2026-09-30",
          },
        },
      ],
      backends: ["chromium"],
      toolkits: [composition],
      tasks: ["navigation"],
      trials: 1,
      budget: { perRunUsd: 0.1, campaignUsd: 0.1, maxRunSeconds: 60 },
      judges: "disabled",
    });

    const entry = campaign.runs[0];
    const subject = campaign.subjects[0];

    if (entry === undefined || subject === undefined)
      return yield* Effect.die("Missing calibration entry");

    const journal = new Journal(
      measuredManifest(campaign, entry, process.env.EVALUATION_SOURCE_REVISION ?? "unavailable"),
    );

    const http = wire(confidence, refuse);
    const ledger = new Ledger(campaign.budget.campaignMicrousd);

    const driver = measured({
      subject,
      allowance: allowance(ledger, campaign, subject),
      apiKey: Redacted.make("offline-only"),
      journal,
      transport: http.layer,
    });

    yield* run(journal, driver).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          const evidence = journal.snapshot();

          return save(
            evidence,
            grade(evidence),
            `${process.env.EVALUATION_EVIDENCE_DIR ?? "results/evaluation"}/jev-${process.pid}/${composition}-${confidence}-${refuse}`,
          ).pipe(Effect.orDie);
        }),
      ),
    );

    return { evidence: journal.snapshot(), sent: http.sent };
  });

for (const composition of ["base", "observed"] as const)
  it.live(
    `the Jev bridge drives real navigation and replays ${composition} evidence without HTTP`,
    () =>
      Effect.gen(function* () {
        const { evidence, sent } = yield* evaluate(composition);

        expect(grade(evidence)).toMatchObject({
          task: "pass",
          output: "valid",
          outputProvenance: "decision-policy",
          cleanup: "confirmed",
          calibration: { agrees: null },
        });
        expect(evidence.facts.output).toEqual({ status: "done", answer: navigationAnswer });
        expect(evidence.facts.applicationWrites).toBe(0);
        expect(evidence.events.filter((event) => event.kind === "decision")).toHaveLength(
          composition === "base" ? 7 : 4,
        );
        expect(sent).toHaveLength(composition === "base" ? 7 : 4);
        expect(sent.every((url) => url === "https://api.typesafe.ai/v1/systemone")).toBe(true);
        expect(evidence.facts.usage).toMatchObject({
          admitted: sent.length,
          settled: sent.length,
          inputTokens: 1000 * sent.length,
          outputTokens: 6 * sent.length,
          overrun: false,
          retainedMicrousd: 0,
        });
        expect((yield* replay(evidence)).output).toEqual(evidence.facts.output);
        expect(JSON.stringify(evidence)).not.toContain("offline-only");
      }),
  );

it.live("a frozen Jev confidence threshold abstains before any browser action", () =>
  Effect.gen(function* () {
    const { evidence, sent } = yield* evaluate("base", 0.7);
    const report = grade(evidence);

    expect(sent).toHaveLength(1);
    expect(evidence.facts.output).toEqual({ status: "unresolved", answer: null });
    expect(report).toMatchObject({
      task: "fail",
      toolCalls: 0,
      termination: "completed",
      cleanup: "confirmed",
      outputProvenance: "decision-policy",
    });
    expect(evidence.events.find((event) => event.kind === "decision")?.value).toMatchObject({
      disposition: "abstained",
      response: { confidence: 0.7 },
    });
  }),
);

it.live(
  "a failed Jev request retains its decision input and reservation without retry or raw provider text",
  () =>
    Effect.gen(function* () {
      const { evidence, sent } = yield* evaluate("base", 1, true);

      expect(sent).toHaveLength(1);
      expect(evidence.events.filter((event) => event.kind === "decision-request")).toHaveLength(1);
      expect(
        evidence.events.find((event) => event.kind === "decision-request")?.value,
      ).toMatchObject({
        policy: "observed-links-and-text-lines-v1",
        request: {
          model: "jev-1.13.0",
          criteria: { start: "Open the supplied starting address to begin the goal." },
        },
      });
      expect(evidence.events.find((event) => event.kind === "decision")?.value).toMatchObject({
        disposition: "failed",
        reason: "provider",
        status: 429,
      });
      expect(evidence.facts.usage).toMatchObject({
        admitted: 1,
        settled: 0,
        refused: null,
        status: "includes-retained-reservations",
      });
      expect(grade(evidence)).toMatchObject({
        termination: "infrastructure-failure",
        toolCalls: 0,
        cleanup: "confirmed",
      });
      expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE-PROVIDER-BODY|offline-only/);
    }),
);
