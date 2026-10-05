import { createHash } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as P from "../Perception.ts";

const data = new Uint8Array([255, 216, 255, 217]);

const image: P.Image = {
  data,
  mimeType: "image/jpeg",
  sha256: createHash("sha256").update(data).digest("hex"),
  width: 1280,
  height: 720,
  page: "page-1",
  at: 123.5,
};

const observation: P.Observation = {
  sha256: image.sha256,
  width: image.width,
  height: image.height,
  page: image.page,
  at: image.at,
};

const runtime = {
  python: "3.12.3",
  torch: "2.11.0",
  transformers: "4.49.0",
  ocr: "tesseract 5.3.4",
};

const parseProvenance: P.ParsedFrame["provenance"] = {
  modelId: "microsoft/OmniParser-v2.0",
  revision: P.omniRevision,
  captionProcessorRevision: P.captionProcessorRevision,
  captionCodeRevision: P.captionCodeRevision,
  ocrDataSha256: P.ocrDataSha256,
  preprocessing: P.parsePreprocessing,
  device: "cpu",
  runtime,
};

const groundProvenance: P.GroundedPoint["provenance"] = {
  modelId: "Hcompany/Holo2-4B",
  revision: P.holoRevision,
  preprocessing: P.groundPreprocessing,
  device: "cuda",
  runtime: { ...runtime, transformers: "5.9.0", ocr: "unavailable" },
};

const parsed: P.ParsedFrame = {
  observation,
  provenance: parseProvenance,
  elements: [
    {
      id: 1,
      bbox: { x0: 100, y0: 30, x1: 200, y1: 70 },
      kind: "icon",
      text: "Submit",
      interactable: true,
    },
  ],
};

const point: P.GroundedPoint = { observation, provenance: groundProvenance, x: 640, y: 360 };

const responseClient = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

const run = <A>(
  body: unknown,
  fn: (service: P.Perception["Service"]) => Effect.Effect<A, P.PerceptionError>,
  status = 200,
) =>
  P.make({ origin: "http://127.0.0.1:8789" }).pipe(
    Effect.flatMap(fn),
    Effect.provideService(HttpClient.HttpClient, responseClient(body, status)),
  );

const reason = <A>(effect: Effect.Effect<A, P.PerceptionError>) =>
  effect.pipe(
    Effect.map(() => "success"),
    Effect.catchTag("PerceptionError", (error) => Effect.succeed(error.reason)),
  );

describe("local perception protocol", () => {
  it.effect("accepts bounded complete results with exact observation and pinned provenance", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(parsed, (service) => service.parse(image)), parsed);
      assert.deepStrictEqual(
        yield* run(point, (service) => service.ground(image, "Submit")),
        point,
      );

      const status: P.Status = {
        mode: "ground",
        ready: false,
        reason: "GpuCapacity",
        provenance: groundProvenance,
        requiredFreeMiB: 16384,
        gpuFreeMiB: 3478,
      };

      assert.deepStrictEqual(yield* run(status, (service) => service.status), status);
    }),
  );

  it.effect("rejects stale identities, wrong models and invalid coordinates without guesses", () =>
    Effect.gen(function* () {
      for (const changed of [
        { ...observation, page: "page-2" },
        { ...observation, at: observation.at + 1 },
        { ...observation, sha256: "0".repeat(64) },
        { ...observation, width: 1279 },
      ]) {
        assert.strictEqual(
          yield* reason(
            run({ ...parsed, observation: changed }, (service) => service.parse(image)),
          ),
          "IdentityMismatch",
        );
      }
      for (const element of [
        { ...parsed.elements[0], id: 2 },
        { ...parsed.elements[0], bbox: { x0: 100, y0: 30, x1: 1281, y1: 70 } },
        { ...parsed.elements[0], bbox: { x0: 100, y0: 30, x1: 100, y1: 70 } },
        { ...parsed.elements[0], text: "" },
        { ...parsed.elements[0], interactable: false },
      ]) {
        assert.strictEqual(
          yield* reason(run({ ...parsed, elements: [element] }, (service) => service.parse(image))),
          "InvalidOutput",
        );
      }
      assert.strictEqual(
        yield* reason(
          run({ ...parsed, provenance: { ...parseProvenance, revision: "main" } }, (service) =>
            service.parse(image),
          ),
        ),
        "InvalidOutput",
      );
      assert.strictEqual(
        yield* reason(
          run({ ...point, x: image.width }, (service) => service.ground(image, "Submit")),
        ),
        "InvalidOutput",
      );
      assert.strictEqual(
        yield* reason(run({ ...point, y: -1 }, (service) => service.ground(image, "Submit"))),
        "InvalidOutput",
      );
      assert.strictEqual(
        yield* reason(
          run({ ...point, extra: "partial decode" }, (service) => service.ground(image, "Submit")),
        ),
        "InvalidOutput",
      );
      assert.strictEqual(
        yield* reason(
          run(
            { ...parsed, elements: Array.from({ length: 257 }, () => parsed.elements[0]) },
            (service) => service.parse(image),
          ),
        ),
        "InvalidOutput",
      );
    }),
  );

  it.effect(
    "checks the copied input hash before transport and confines the endpoint to loopback",
    () =>
      Effect.gen(function* () {
        let calls = 0;

        const client = HttpClient.make((request) => {
          calls++;

          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify(parsed))),
          );
        });

        const service = yield* P.make({ origin: "http://127.0.0.1:8789" }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );

        assert.strictEqual(
          yield* reason(service.parse({ ...image, sha256: "0".repeat(64) })),
          "IdentityMismatch",
        );
        assert.strictEqual(yield* reason(service.ground(image, " ")), "InvalidOutput");
        for (const origin of [
          "https://127.0.0.1:8789",
          "http://example.com",
          "http://user@127.0.0.1",
          "http://127.0.0.1/prefix",
          "http://127.0.0.1?secret=1",
        ]) {
          assert.strictEqual(
            yield* reason(
              P.make({ origin }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
            ),
            "Unavailable",
          );
        }
        assert.strictEqual(calls, 0);
      }),
  );

  it.effect("preserves typed prerequisites, rejects broken UTF-8 and limits response bytes", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* reason(
          run(
            new P.PerceptionError({ reason: "MissingWeights" }),
            (service) => service.parse(image),
            503,
          ),
        ),
        "MissingWeights",
      );
      for (const [body, expected] of [
        [new Uint8Array([255]), "InvalidOutput"],
        [new Uint8Array(256 * 1024 + 1), "LimitExceeded"],
      ] as const) {
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body))),
        );

        const actual = yield* reason(
          P.make({ origin: "http://127.0.0.1:8789" }).pipe(
            Effect.flatMap((service) => service.parse(image)),
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        );

        assert.strictEqual(actual, expected);
      }
    }),
  );

  it("interrupts a timed-out request without retrying", async () => {
    let calls = 0;
    let interrupted = false;

    const client = HttpClient.make(() => {
      calls++;

      return Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
    });

    const actual = await Effect.runPromise(
      reason(
        P.make({
          origin: "http://127.0.0.1:8789",
          timeoutMs: 5,
        }).pipe(
          Effect.flatMap((service) => service.parse(image)),
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ),
    );

    assert.strictEqual(actual, "Timeout");
    assert.strictEqual(calls, 1);
    assert.isTrue(interrupted);
  });
});
