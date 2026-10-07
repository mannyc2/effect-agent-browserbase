// The part of Browserbase's published OpenAPI document that effect-browserbase relies on: the
// session and context operations its client calls and its fake answers, each schema with its
// references inlined so it stands alone, and without prose, so only a change of shape shows.
// effect-browserbase's shape test reads a copy, `packages/browserbase/test/browserbase-openapi.json`;
// `bench contract --spec` compares that copy with the document Browserbase publishes now.
import { Effect, Option, Predicate, Schema } from "effect";
import { HttpClient } from "effect/http";
import { parse } from "yaml";

import { BenchError } from "./Budget.ts";

export const source = "https://docs.browserbase.com/reference/api/openapi.v1.yaml";

/** The operations the client calls and the package's fake answers. */
export const operations: ReadonlyArray<string> = [
  "Sessions_list",
  "Sessions_create",
  "Sessions_get",
  "Sessions_update",
  "Contexts_create",
  "Contexts_get",
  "Contexts_delete",
];

// Prose that changes with the documentation, not with the shapes.
const prose: ReadonlySet<string> = new Set([
  "description",
  "summary",
  "example",
  "examples",
  "externalDocs",
]);

const componentSchema = "#/components/schemas/";

/** `value` with every component schema reference replaced by its schema, and no prose. */
const inline = (value: unknown, components: Readonly<Record<string, unknown>>): unknown => {
  if (Array.isArray(value)) return value.map((item) => inline(item, components));
  if (!Predicate.isObject(value)) return value;

  const ref = Reflect.get(value, "$ref");

  if (typeof ref === "string" && ref.startsWith(componentSchema))
    return inline(components[ref.slice(componentSchema.length)], components);

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !prose.has(key))
      .map(([key, item]) => [key, inline(item, components)]),
  );
};

/** A request or response body, of which only the JSON schema counts. */
const Body = Schema.Struct({
  content: Schema.optional(
    Schema.Struct({
      "application/json": Schema.optional(
        Schema.Struct({ schema: Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
});

const Operation = Schema.Struct({
  operationId: Schema.String,
  parameters: Schema.optional(Schema.Array(Schema.Unknown)),
  requestBody: Schema.optional(Body),
  responses: Schema.Record(Schema.String, Body),
});

const Document = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Unknown) }),
});

const schemaOf = (body: typeof Body.Type | undefined) =>
  body?.content?.["application/json"]?.schema ?? null;

/** Each operation the package relies on, as `document` describes it. */
export const extract = (document: typeof Document.Type) => {
  const components = document.components.schemas;

  // A path's entries other than its operations, such as shared parameters, do not decode.
  const found = Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, entry]) =>
      Option.match(Schema.decodeUnknownOption(Operation)(entry), {
        onNone: () => [],
        onSome: (operation) =>
          operations.includes(operation.operationId)
            ? [
                [
                  operation.operationId,
                  {
                    method,
                    path,
                    parameters: inline(operation.parameters ?? [], components),
                    requestBody: inline(schemaOf(operation.requestBody), components),
                    responses: Object.fromEntries(
                      Object.entries(operation.responses).map(([code, response]) => [
                        code,
                        inline(schemaOf(response), components),
                      ]),
                    ),
                  },
                ] as const,
              ]
            : [],
      }),
    ),
  );

  return {
    source,
    operations: Object.fromEntries(found.toSorted(([left], [right]) => left.localeCompare(right))),
  };
};

/** What `extract` gives, as the shape test's copy keeps it. */
export const Copy = Schema.Struct({
  source: Schema.String,
  operations: Schema.Record(Schema.String, Schema.Unknown),
});

/** The document Browserbase publishes now, as `extract` reads it. */
export const published = HttpClient.get(source).pipe(
  Effect.flatMap((response) => response.text),
  Effect.flatMap((text) => Effect.try((): unknown => parse(text))),
  Effect.flatMap(Schema.decodeUnknownEffect(Document)),
  Effect.map(extract),
  Effect.mapError(
    (error) => new BenchError({ message: `could not read ${source}: ${error.message}` }),
  ),
);

/** `value` as JSON with every object's keys in order, so equal shapes print the same. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    Predicate.isObject(item) && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );
