import { describe, expect, it as test } from "@effect/vitest";
// The Try page: away from a visitor's machine it shows how to get the local runner; on it, it
// records a take within the visitor's cap and follows it until the replay is packed.
import * as Scene from "foldkit/scene";
import { Command, given, message, model, story } from "foldkit/story";

import { TakeState } from "../src/local.ts";
import {
  CopyPrompt,
  init,
  Message,
  type Model,
  PollTake,
  Runner,
  StartTake,
  Take,
  update,
  view,
} from "../src/page/try.ts";

const status = (missing: ReadonlyArray<string> = []) => ({
  missing,
  defaults: { model: "openai/gpt-6-luna", maxUsd: 0.5 },
});

const local = (missing: ReadonlyArray<string> = []): Model =>
  update(init().model, Message.SucceededLoadStatus({ status: status(missing) })).model;

describe("update", () => {
  test("no local runner means the page is not running on the visitor's machine", () => {
    story(
      update,
      given(init().model),
      message(Message.FailedLoadStatus()),
      model((model) => expect(model.runner).toEqual(Runner.Remote())),
    );
  });

  test("a take starts with the runner's defaults and follows the runner until it is packed", () => {
    story(
      update,
      given(local()),
      model((model) => {
        expect(model.modelInput).toBe("openai/gpt-6-luna");
        expect(model.maxUsdInput).toBe("0.50");
      }),
      message(Message.SubmittedTake()),
      Command.resolve(
        StartTake({ model: "openai/gpt-6-luna", maxUsd: 0.5 }),
        Message.SucceededStartTake({ id: "polymarket-20261011170000" }),
      ),
      Command.resolve(
        PollTake,
        Message.SucceededPollTake({ state: TakeState.cases.Running.make({ log: ["recording"] }) }),
      ),
      model((model) =>
        expect(model.take).toEqual(
          Take.Recording({ id: "polymarket-20261011170000", log: ["recording"] }),
        ),
      ),
      message(Message.TickedPoll()),
      Command.resolve(
        PollTake,
        Message.SucceededPollTake({
          state: TakeState.cases.Packed.make({
            log: ["recording", "packed"],
            replay: "polymarket-20261011170000",
          }),
        }),
      ),
      model((model) =>
        expect(model.take).toEqual(
          Take.Packed({ replay: "polymarket-20261011170000", log: ["recording", "packed"] }),
        ),
      ),
    );
  });

  test("a cap outside $0 to $5 is refused before anything starts", () => {
    story(
      update,
      given(local()),
      message(Message.UpdatedMaxUsdInput({ value: "9" })),
      message(Message.SubmittedTake()),
      Command.expectNone(),
      model((model) => expect(model.take._tag).toBe("Failed")),
    );
  });
});

describe("view", () => {
  test("away from the visitor's machine it gives the commands and a prompt for their agent", () => {
    Scene.scene(
      { update, view },
      Scene.given(update(init().model, Message.FailedLoadStatus()).model),
      Scene.expect(Scene.text("bun run dev", { exact: false })).toExist(),
      Scene.click(Scene.role("button", { name: "Copy prompt for your coding agent" })),
      Scene.Command.resolve(CopyPrompt, Message.CompletedCopyPrompt({ copied: true })),
      Scene.expect(Scene.text("Copied.")).toExist(),
    );
  });

  test("on the visitor's machine it lists what a take still needs and holds the button", () => {
    Scene.scene(
      { update, view },
      Scene.given(local(["OPENROUTER_API_KEY: the agent, narrator and voice run on it"])),
      Scene.expect(Scene.text("Before a take can start:")).toExist(),
      Scene.expect(Scene.role("button", { name: "Record a take" })).toBeDisabled(),
    );
  });

  test("a packed take links to its replay", () => {
    Scene.scene(
      { update, view },
      Scene.given({ ...local(), take: Take.Packed({ replay: "polymarket-1", log: ["packed"] }) }),
      Scene.expect(Scene.role("link", { name: "Watch it" })).toHaveAttr(
        "href",
        "/replay/polymarket-1",
      ),
    );
  });
});
