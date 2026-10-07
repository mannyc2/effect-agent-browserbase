// What `contract --spec` takes from Browserbase's OpenAPI document for effect-browserbase's shape
// test, and how it compares two copies. Free, with no network.
import { assert, describe, it } from "@effect/vitest";

import * as OpenApi from "../OpenApi.ts";

const json = (schema: unknown) => ({ content: { "application/json": { schema } } });

const document = {
  paths: {
    "/v1/sessions/{id}": {
      // Shared by the path's operations, so it is no operation itself.
      parameters: [{ name: "x-trace", in: "header" }],
      get: {
        operationId: "Sessions_get",
        summary: "Get a session",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The session", ...json({ $ref: "#/components/schemas/Session" }) },
        },
      },
      // An operation the package does not rely on.
      delete: { operationId: "Sessions_delete", responses: { "204": { description: "Gone" } } },
    },
  },
  components: {
    schemas: {
      Session: {
        type: "object",
        description: "A browser session",
        required: ["id"],
        properties: {
          id: { type: "string", example: "a-session" },
          region: { $ref: "#/components/schemas/Region" },
        },
      },
      Region: { type: "string", enum: ["us-west-2", "eu-central-1"] },
    },
  },
};

describe("extract", () => {
  it("keeps the operations relied on, with references inlined and prose left out", () => {
    assert.deepStrictEqual(OpenApi.extract(document), {
      source: OpenApi.source,
      operations: {
        Sessions_get: {
          method: "get",
          path: "/v1/sessions/{id}",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: null,
          responses: {
            "200": {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string" },
                region: { type: "string", enum: ["us-west-2", "eu-central-1"] },
              },
            },
          },
        },
      },
    });
  });
});

describe("canonical", () => {
  it("prints equal shapes the same, whatever their keys' order", () => {
    assert.strictEqual(
      OpenApi.canonical({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } }),
      OpenApi.canonical({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }),
    );
    // Order within an array is part of a shape, as in an enum's or a tuple's.
    assert.notStrictEqual(OpenApi.canonical({ a: [1, 2] }), OpenApi.canonical({ a: [2, 1] }));
  });
});
