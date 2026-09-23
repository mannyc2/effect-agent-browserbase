import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { Tool, Toolkit } from "effect/unstable/ai";
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";

// Tests run Toolkits through a scripted model, which never converts a Tool's parameters into a
// provider's JSON Schema. Providers do, before any request is sent, so every Tool is checked
// here with the same transforms the pinned OpenAI and Anthropic models apply.

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

it("every Tool has an object parameter schema each pinned provider accepts", () => {
  const tools = Object.values(everyTool.tools) as ReadonlyArray<Tool.Any>;

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

it("arguments survive each provider's wire shape and decode as the Toolkit decodes them", () => {
  for (const tool of Object.values(everyTool.tools) as ReadonlyArray<Tool.Any>) {
    const inputs = samples[base(tool.name)];

    if (inputs === undefined) throw new Error(`No sample arguments for ${tool.name}`);
    const decode = Schema.decodeUnknownSync(tool.parametersSchema as Schema.Codec<unknown>);
    const encode = Schema.encodeSync(tool.parametersSchema as Schema.Codec<unknown>);

    for (const input of inputs)
      for (const [provider, transformer] of providers) {
        const expected = decode(input);
        const { codec } = transformer(tool.parametersSchema as Schema.Codec<unknown>);
        // What the model sends: the provider's shape, as JSON.
        const wire: unknown = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(expected)));
        // What the provider hands the Toolkit, and what the Toolkit's own decoding makes of it.
        const received = decode(encode(Schema.decodeUnknownSync(codec)(wire)));

        expect({ tool: tool.name, provider, received }).toEqual({
          tool: tool.name,
          provider,
          received: expected,
        });
      }
  }
});

it("a provider's absent optional fields decode as omitted, not as null", () => {
  const inspect = toCodecOpenAI(
    BrowserTools.toolkit.tools.browser_inspect.parametersSchema as Schema.Codec<unknown>,
  );

  // OpenAI requires every property and sends null for one the model leaves out.
  expect(Schema.decodeSync(inspect.codec)({ find: null, scope: null })).toEqual({});
  expect(Schema.decodeSync(inspect.codec)({ find: "Total", scope: null })).toEqual({
    find: "Total",
  });
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
  expect(described(BrowserTools.formToolkit.tools.browser_fill_form, "submit")).toMatch(/Omit it/);
  expect(described(BrowserTools.formToolkit.tools.browser_fill_form, "fields")).toMatch(/order/);
  expect(described(BrowserTools.selectionToolkit.tools.browser_select_option, "options")).toMatch(
    /selectElementId/,
  );
});
