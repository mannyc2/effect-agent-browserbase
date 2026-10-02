import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Plan from "../src/Plan.ts";
import * as Testing from "../src/Testing.ts";

const origin = "https://record.test";

const script: Testing.Script = {
  documents: [
    {
      url: `${origin}/`,
      title: "Sign in",
      text: "Sign in.",
      controls: [{ id: "name", kind: "input", label: "Name", inputType: "text" }],
    },
  ],
};

it.effect("a recorded plan names its input slots, so it replays without the literal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      yield* page.navigate({ url: `${origin}/` });

      const ran = yield* page.run({
        version: 1,
        steps: [
          {
            id: "name",
            action: {
              _tag: "Fill",
              target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Name" } },
              value: { _tag: "Literal", value: "secret-literal" },
            },
          },
        ],
      });

      const recorded = yield* Plan.recorded(ran);
      const slots = Plan.inputSlots(recorded);

      expect(slots).toEqual([
        { name: expect.any(String), stepId: "name", path: ["value"], kind: "value" },
      ]);
      expect(JSON.stringify(yield* Plan.encode(recorded))).not.toContain("secret-literal");

      const [slot] = slots;

      if (slot === undefined) return;
      yield* page.run(recorded, { inputs: { [slot.name]: "replayed" } });
      expect((yield* browser.control.document.values).get("name")).toBe("replayed");
    }),
  ),
);
