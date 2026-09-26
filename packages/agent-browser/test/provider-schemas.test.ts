import { expect, it } from "@effect/vitest";
import { Predicate, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { Tool, Toolkit } from "effect/unstable/ai";
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";

// Tests run Toolkits through a scripted model, which never converts a Tool's parameters into a
// provider's JSON Schema. Providers do, before any request is sent, so every Tool is checked
// here with the same transforms the pinned OpenAI and Anthropic models apply. Both make every
// key required and nullable, so a model sends null for each parameter it leaves out, and Effect
// Agent decodes what it sends with the Tool's own parameter schema, never the provider's codec.

const everyTool = Toolkit.merge(
  BrowserTools.toolkit,
  BrowserTools.readingToolkit,
  BrowserTools.nativeToolkit,
  BrowserTools.keyboardToolkit,
  BrowserTools.selectionToolkit,
  BrowserTools.waitToolkit,
  BrowserTools.formToolkit,
  BrowserTools.observedToolkit,
  BrowserTools.observedNativeToolkit,
  BrowserTools.observedKeyboardToolkit,
  BrowserTools.observedSelectionToolkit,
  BrowserTools.observedFormToolkit,
);

const tools = Object.values(everyTool.tools) as ReadonlyArray<Tool.Any>;

const reference = { observationId: "observation-1", elementId: "element-2" };

/** Representative arguments for every Tool, with optional fields both present and absent. */
const samples: Record<string, ReadonlyArray<unknown>> = {
  browser_navigate: [{ url: "https://example.test/" }],
  browser_inspect: [
    {},
    { find: "Sign in" },
    { scope: "document" },
    { find: "Total", scope: "viewport" },
  ],
  browser_read_more: [{ observationId: "observation-1" }],
  browser_click: [reference],
  browser_fill: [{ reference, value: "ada@example.test" }],
  browser_scroll: [{ deltaX: 0, deltaY: 400 }],
  browser_pointer_move: [{ to: { x: 10, y: 20 } }],
  browser_hover: [reference],
  browser_wheel: [
    { deltaX: 0, deltaY: 120 },
    { deltaX: 0, deltaY: 120, at: { x: 5, y: 5 } },
  ],
  browser_press: [
    { reference, key: "Enter" },
    { reference, key: "a", modifiers: ["Control"] },
  ],
  browser_type: [{ reference, text: "hello" }],
  browser_select_option: [{ reference, options: ["element-3"] }],
  browser_wait_for: [
    { reference, state: "visible" },
    { reference, state: "hidden", timeoutMillis: 500 },
  ],
  browser_fill_form: [
    {
      observationId: "observation-1",
      fields: [
        { elementId: "element-2", value: "ada@example.test" },
        { elementId: "element-3", checked: true },
        { elementId: "element-4", options: ["element-5"] },
      ],
      submit: "element-6",
    },
    { observationId: "observation-1", fields: [{ elementId: "element-2", value: "" }] },
  ],
};

const base = (name: string) => name.replace(/_and_inspect$/, "");

const providers = [
  ["openai", toCodecOpenAI],
  ["anthropic", toCodecAnthropic],
] as const;

/** How Effect Agent reads a model's arguments: with the Tool's own parameter schema. */
const decodeWith = (tool: Tool.Any) =>
  Schema.decodeUnknownSync(tool.parametersSchema as Schema.Codec<unknown>);

/** The decoded request, or the refusal a model would read instead. */
const outcome = (tool: Tool.Any, input: unknown): unknown => {
  try {
    return decodeWith(tool)(input);
  } catch (error) {
    return error instanceof Error ? error.message : error;
  }
};

/** Every description in a JSON Schema, at any depth. */
const descriptionsIn = (schema: unknown): ReadonlyArray<string> =>
  Array.isArray(schema)
    ? schema.flatMap(descriptionsIn)
    : Predicate.isObject(schema)
      ? [
          ...(typeof schema.description === "string" ? [schema.description] : []),
          ...Object.values(schema).flatMap(descriptionsIn),
        ]
      : [];

/** Every property in a JSON Schema, at any depth, named by its path. */
const propertiesIn = (schema: unknown, path: string): ReadonlyArray<readonly [string, unknown]> =>
  Array.isArray(schema)
    ? schema.flatMap((member) => propertiesIn(member, path))
    : Predicate.isObject(schema)
      ? Object.entries(schema).flatMap(([key, value]) =>
          key === "properties" && Predicate.isObject(value)
            ? Object.entries(value).flatMap(([name, property]) => [
                [`${path}.${name}`, property] as const,
                ...propertiesIn(property, `${path}.${name}`),
              ])
            : propertiesIn(value, path),
        )
      : [];

it("every Tool has an object parameter schema each pinned provider accepts", () => {
  expect(tools.length).toBe(BrowserTools.toolNames.size);
  for (const tool of tools)
    for (const [provider, transformer] of providers) {
      const schema = Tool.getJsonSchema(tool, { transformer });

      expect({ tool: tool.name, provider, type: schema.type }).toEqual({
        tool: tool.name,
        provider,
        type: "object",
      });
      expect({ tool: tool.name, provider, anyOf: schema.anyOf }).toEqual({
        tool: tool.name,
        provider,
        anyOf: undefined,
      });
    }
});

it("arguments in each provider's wire shape decode with the Tool's own schema", () => {
  for (const tool of tools) {
    const inputs = samples[base(tool.name)];

    if (inputs === undefined) throw new Error(`No sample arguments for ${tool.name}`);
    const decode = decodeWith(tool);

    for (const input of inputs)
      for (const [provider, transformer] of providers) {
        const expected = decode(input);
        const { codec } = transformer(tool.parametersSchema as Schema.Codec<unknown>);
        // What the model sends: the provider's shape as JSON, every key present and null for none.
        const wire: unknown = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(expected)));

        expect({ tool: tool.name, provider, received: outcome(tool, wire) }).toEqual({
          tool: tool.name,
          provider,
          received: expected,
        });
      }
  }
});

it("a model's null for none decodes as the parameter it leaves out", () => {
  const inspect = BrowserTools.toolkit.tools.browser_inspect;

  // The provider's own shape for a reading with neither parameter.
  expect(
    Schema.encodeSync(toCodecOpenAI(inspect.parametersSchema as Schema.Codec<unknown>).codec)({}),
  ).toEqual({ find: null, scope: null });

  // Calls OpenAI models make, beside the same calls with the null keys left out.
  const calls: ReadonlyArray<readonly [Tool.Any, unknown, unknown]> = [
    [inspect, { find: null, scope: null }, {}],
    [inspect, { find: "XRP", scope: null }, { find: "XRP" }],
    [inspect, { find: null, scope: "document" }, { scope: "document" }],
    [
      BrowserTools.observedFormToolkit.tools.browser_fill_form_and_inspect,
      {
        observationId: "o1",
        fields: [
          { elementId: "e3", value: "gm", checked: null, options: null },
          { elementId: "e4", value: null, checked: true, options: null },
          { elementId: "e5", value: null, checked: null, options: ["e6"] },
        ],
        submit: null,
      },
      {
        observationId: "o1",
        fields: [
          { elementId: "e3", value: "gm" },
          { elementId: "e4", checked: true },
          { elementId: "e5", options: ["e6"] },
        ],
      },
    ],
    [
      BrowserTools.observedFormToolkit.tools.browser_fill_form_and_inspect,
      {
        observationId: "o1",
        fields: [{ elementId: "e3", value: "gm", checked: null, options: null }],
        submit: "e9",
      },
      { observationId: "o1", fields: [{ elementId: "e3", value: "gm" }], submit: "e9" },
    ],
    [
      BrowserTools.observedKeyboardToolkit.tools.browser_press_and_inspect,
      { reference, key: "Enter", modifiers: null },
      { reference, key: "Enter" },
    ],
    [
      BrowserTools.nativeToolkit.tools.browser_wheel,
      { deltaX: 0, deltaY: 120, at: null },
      { deltaX: 0, deltaY: 120 },
    ],
    [
      BrowserTools.waitToolkit.tools.browser_wait_for,
      { reference, state: "visible", timeoutMillis: null },
      { reference, state: "visible" },
    ],
  ];

  expect(calls.map(([tool, sent]) => ({ tool: tool.name, decoded: outcome(tool, sent) }))).toEqual(
    calls.map(([tool, , omitted]) => ({ tool: tool.name, decoded: decodeWith(tool)(omitted) })),
  );
});

it("every parameter a provider makes nullable says what null means", () => {
  const unexplained = tools.flatMap((tool) =>
    providers.flatMap(([provider, transformer]) =>
      propertiesIn(Tool.getJsonSchema(tool, { transformer }), tool.name)
        .filter(
          ([, property]) =>
            Predicate.isObject(property) &&
            Array.isArray(property.anyOf) &&
            property.anyOf.some((member) => Predicate.isObject(member) && member.type === "null") &&
            !descriptionsIn(property).some((description) => /\bnull\b/.test(description)),
        )
        .map(([path]) => `${provider} ${path}`),
    ),
  );

  expect(unexplained).toEqual([]);
});

it("parameter fields tell the model what they mean", () => {
  const described = (tool: Tool.Any, field: string) => {
    const schema = Tool.getJsonSchema(tool) as {
      readonly properties?: Record<string, { readonly description?: string }>;
    };

    return schema.properties?.[field]?.description;
  };

  expect(described(BrowserTools.toolkit.tools.browser_click, "observationId")).toMatch(
    /latest observation/,
  );
  expect(described(BrowserTools.toolkit.tools.browser_inspect, "find")).toMatch(/Case-insensitive/);
  expect(described(BrowserTools.toolkit.tools.browser_fill, "value")).toMatch(/replaces/);
  expect(described(BrowserTools.formToolkit.tools.browser_fill_form, "submit")).toMatch(
    /null leaves the form unsent/,
  );
  expect(described(BrowserTools.formToolkit.tools.browser_fill_form, "fields")).toMatch(/order/);
  expect(described(BrowserTools.selectionToolkit.tools.browser_select_option, "options")).toMatch(
    /selectElementId/,
  );
});
