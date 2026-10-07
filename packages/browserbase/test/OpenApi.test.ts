// The in-memory Browserbase's answers and the client's requests, held to the shapes Browserbase
// publishes: the part of its OpenAPI document this package relies on (browserbase-openapi.json,
// with references inlined), which `bun run bench contract --spec` keeps current. It checks shapes;
// BrowserbaseContract checks behaviour.
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, JsonSchema, Layer, Redacted, Schema, SchemaRepresentation } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { BrowserbaseClient, layer as clientLayer } from "../src/BrowserbaseClient.ts";
import * as BrowserbaseContract from "../src/testing/BrowserbaseContract.ts";
import * as TestBrowserbase from "../src/testing/TestBrowserbase.ts";

const Shape = Schema.Record(Schema.String, Schema.Unknown);

const Operation = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  parameters: Schema.Array(
    Schema.Struct({ name: Schema.String, in: Schema.String, schema: Schema.optional(Shape) }),
  ),
  requestBody: Schema.NullOr(Shape),
  responses: Schema.Record(Schema.String, Schema.NullOr(Shape)),
});

const spec = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ source: Schema.String, operations: Schema.Record(Schema.String, Operation) }),
  ),
)(readFileSync(new URL("browserbase-openapi.json", import.meta.url), "utf8"));

/** One request the client sent, and what it was answered. */
interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
  /** The parsed JSON body, or undefined for none. */
  readonly sent: unknown;
  readonly status: number;
  readonly answered: unknown;
}

const parsed = (text: string): unknown => (text === "" ? undefined : JSON.parse(text));

/** The real client over the fake, keeping every exchange it has with it. */
const recorded = (script: TestBrowserbase.Script = {}) =>
  Effect.gen(function* () {
    const { http } = yield* TestBrowserbase.make(script);
    const exchanges: Array<Exchange> = [];

    const keeping = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const response = yield* http.execute(request);
        const text = yield* response.text;

        exchanges.push({
          method: request.method,
          path: url.pathname,
          query: [...url.searchParams],
          sent:
            request.body._tag === "Uint8Array"
              ? parsed(new TextDecoder().decode(request.body.body))
              : undefined,
          status: response.status,
          answered: parsed(text),
        });

        // The body was read here, so the client gets a fresh answer with the same content.
        return HttpClientResponse.fromWeb(
          request,
          new Response(text === "" ? null : text, {
            status: response.status,
            headers: response.headers,
          }),
        );
      }),
    );

    const client = clientLayer({
      apiKey: Redacted.make(TestBrowserbase.apiKey),
      baseUrl: "https://api.browserbase.test",
    }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, keeping)));

    return { client, exchanges };
  });

const decoders = new Map<object, (value: unknown) => ReadonlyArray<string>>();

/** What of `value` does not fit `shape`, as the document's own JSON Schema importer reads it. */
const fits = (
  label: string,
  shape: typeof Shape.Type,
  value: unknown,
  strict: boolean,
): ReadonlyArray<string> => {
  const decode =
    decoders.get(shape) ??
    (() => {
      const schema = Schema.make<Schema.Codec<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaOpenApi3_0(shape), {
          // The document is a reviewed copy, so its patterns are applied.
          patterns: "apply",
        }).ast,
      );

      const made = (input: unknown) =>
        Exit.match(
          Schema.decodeUnknownExit(schema, {
            errors: "all",
            ...(strict ? { onExcessProperty: "error" } : {}),
          })(input),
          {
            onSuccess: () => [],
            onFailure: (cause) => [String(cause).replace(/\s*\n\s*/g, " ")],
          },
        );

      decoders.set(shape, made);

      return made;
    })();

  return decode(value).map((problem) => `${label}: ${problem}`);
};

const operationOf = (exchange: Exchange) =>
  Object.entries(spec.operations).find(
    ([, operation]) =>
      operation.method.toUpperCase() === exchange.method &&
      new RegExp(`^${operation.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(exchange.path),
  );

/** What of each exchange does not fit the shapes Browserbase publishes, a line for each. */
const misfits = (exchanges: ReadonlyArray<Exchange>): ReadonlyArray<string> =>
  exchanges.flatMap((exchange) => {
    const found = operationOf(exchange);

    if (found === undefined)
      return [`${exchange.method} ${exchange.path} is no operation of the document`];
    const [id, operation] = found;

    const query = exchange.query.flatMap(([name, value]) => {
      const declared = operation.parameters.find(
        (parameter) => parameter.in === "query" && parameter.name === name,
      );

      return declared === undefined
        ? [`${id} sends the query ${name}, which the document doesn't declare`]
        : declared.schema === undefined
          ? []
          : fits(`${id} query ${name}`, declared.schema, value, true);
    });

    // The client's requests are held to the document strictly, so a misnamed field shows.
    const sent =
      operation.requestBody === null
        ? exchange.sent === undefined
          ? []
          : [`${id} sends a body, which the document has none for`]
        : fits(`${id} request`, operation.requestBody, exchange.sent, true);

    // Browserbase documents only the answers that succeed.
    if (exchange.status >= 300) return [...query, ...sent];
    const documented = operation.responses[String(exchange.status)];

    const answered =
      documented === undefined
        ? [`${id} answers ${exchange.status}, which the document doesn't list`]
        : documented === null
          ? exchange.answered === undefined
            ? []
            : [`${id} answers ${exchange.status} with a body, which the document has none for`]
          : fits(`${id} ${exchange.status}`, documented, exchange.answered, false);

    return [...query, ...sent, ...answered];
  });

// Browserbase hands out a DevTools address with every session it makes.
const connectUrl = "wss://connect.browserbase.test/devtools";

describe("the in-memory Browserbase, against the shapes Browserbase publishes", () => {
  it("covers every operation the client and the fake share", () => {
    assert.deepStrictEqual(Object.keys(spec.operations).toSorted(), [
      "Contexts_create",
      "Contexts_delete",
      "Contexts_get",
      "Sessions_create",
      "Sessions_get",
      "Sessions_list",
      "Sessions_update",
    ]);
  });

  it.live("answers the contract's calls in the shapes Browserbase publishes", () =>
    Effect.gen(function* () {
      const { client, exchanges } = yield* recorded({ connectUrl });

      for (const check of BrowserbaseContract.checks.filter(({ clock }) => !clock))
        yield* check.run.pipe(Effect.provide(client));

      const operations = new Set(exchanges.map((exchange) => operationOf(exchange)?.[0]));

      assert.deepStrictEqual(misfits(exchanges), []);
      // Every operation was exercised, so none passes for want of a call.
      assert.deepStrictEqual(
        Object.keys(spec.operations).filter((id) => !operations.has(id)),
        [],
      );
    }),
  );

  it.live("sends every create option in the shape Browserbase publishes", () =>
    Effect.gen(function* () {
      const { client, exchanges } = yield* recorded({ connectUrl });

      yield* Effect.gen(function* () {
        const api = yield* BrowserbaseClient;
        const context = yield* api.createContext();

        const session = yield* api.createSession({
          projectId: "test-project",
          extensionId: "an-extension",
          timeout: 600,
          keepAlive: true,
          region: "eu-central-1",
          proxies: [
            {
              type: "browserbase",
              geolocation: { country: "US", state: "NY", city: "New York" },
              domainPattern: ".*\\.example\\.com",
            },
            {
              type: "external",
              server: "http://proxy.example:8080",
              username: "user",
              password: "secret",
            },
            { type: "none", domainPattern: "internal\\.example" },
          ],
          userMetadata: { run: "shapes", nested: { trial: 1 } },
          browserSettings: {
            context: { id: context.id, persist: true },
            viewport: { width: 1280, height: 720 },
            blockAds: true,
            solveCaptchas: false,
            recordSession: false,
            logSession: false,
            verified: false,
            os: "linux",
            allowedDomains: ["example.com"],
            ignoreCertificateErrors: true,
          },
        });

        yield* api.releaseSession(session.id);
      }).pipe(Effect.provide(client));

      assert.deepStrictEqual(misfits(exchanges), []);
    }),
  );
});
