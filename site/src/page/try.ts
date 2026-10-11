// The Try page. Served by `bun run dev` on a visitor's own machine, it finds the local runner and
// records a take of the demo there: the visitor's model key, their Chromium, their spending cap.
// Anywhere else it finds no runner and shows how to get one, for a person or their coding agent.
import { Duration, Effect, Option, Schema, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import { Command, Http, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { defineView } from "foldkit/submodel";

import { ExampleTab, exampleView } from "../example.ts";
import { LocalApi, RunnerStatus, TakeState } from "../local.ts";
import { site } from "../pages.ts";

// MODEL

export const Take = defineTaggedUnion({
  Idle: {},
  Starting: {},
  Recording: { id: Schema.String, log: Schema.Array(Schema.String) },
  Packed: { replay: Schema.String, log: Schema.Array(Schema.String) },
  Failed: { reason: Schema.String, log: Schema.Array(Schema.String) },
});

export type Take = typeof Take.Type;

export const Runner = defineTaggedUnion({
  Checking: {},
  Remote: {},
  Local: { status: RunnerStatus },
});

export type Runner = typeof Runner.Type;

export const Model = Schema.Struct({
  runner: Runner,
  modelInput: Schema.String,
  maxUsdInput: Schema.String,
  take: Take,
  copy: Schema.Literals(["Idle", "Copied", "Failed"]),
  setup: ExampleTab,
});

export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadStatus: { status: RunnerStatus },
  FailedLoadStatus: {},
  UpdatedModelInput: { value: Schema.String },
  UpdatedMaxUsdInput: { value: Schema.String },
  SubmittedTake: {},
  SucceededStartTake: { id: Schema.String },
  FailedStartTake: { reason: Schema.String },
  TickedPoll: {},
  SucceededPollTake: { state: TakeState },
  FailedPollTake: { reason: Schema.String },
  ClickedCopyPrompt: {},
  CompletedCopyPrompt: { copied: Schema.Boolean },
  SelectedSetupTab: { tab: ExampleTab },
  ClickedCopySetup: {},
  CompletedCopySetup: {},
});

export type Message = typeof Message.Type;

// COMMAND

const client = HttpApiClient.make(LocalApi, { baseUrl: "" });

export const LoadStatus = Command.define("LoadStatus", {
  messages: [Message.SucceededLoadStatus, Message.FailedLoadStatus],
  execute: client.pipe(
    Effect.flatMap((api) => api.LocalRunner.status()),
    Effect.map((status) => Message.SucceededLoadStatus({ status })),
    Effect.orElseSucceed(() => Message.FailedLoadStatus()),
    Effect.provide(Http.layer),
  ),
});

export const StartTake = Command.define("StartTake", {
  args: { model: Schema.String, maxUsd: Schema.Finite },
  messages: [Message.SucceededStartTake, Message.FailedStartTake],
  execute: (take) =>
    client.pipe(
      Effect.flatMap((api) => api.LocalRunner.start({ payload: take })),
      Effect.map(({ id }) => Message.SucceededStartTake({ id })),
      Effect.orElseSucceed(() =>
        Message.FailedStartTake({ reason: "The local runner refused the take" }),
      ),
      Effect.provide(Http.layer),
    ),
});

export const PollTake = Command.define("PollTake", {
  args: { id: Schema.String },
  messages: [Message.SucceededPollTake, Message.FailedPollTake],
  execute: ({ id }) =>
    client.pipe(
      Effect.flatMap((api) => api.LocalRunner.take({ params: { id } })),
      Effect.map((state) => Message.SucceededPollTake({ state })),
      Effect.orElseSucceed(() => Message.FailedPollTake({ reason: "Lost the local runner" })),
      Effect.provide(Http.layer),
    ),
});

/** What a visitor hands their coding agent to record a take on their machine. */
export const agentPrompt = [
  `Clone ${site.repository} and read site/AGENTS.md.`,
  "Install with `bun install`, then `./node_modules/.bin/playwright-core install chromium`.",
  "Ask me for an OpenRouter API key, export it as OPENROUTER_API_KEY with EFFECT_BROWSER_BENCH_LIVE=1, and confirm the spending cap with me before recording.",
  "Then run `bun run dev` in site/, open http://localhost:5173/try and record a take of the Polymarket demo.",
].join(" ");

/** The commands that start a local runner, and what they printed when run on 11 October 2026. */
const setup = {
  commands: [
    `git clone ${site.repository}`,
    "cd effect-agent-browserbase",
    "bun install",
    "./node_modules/.bin/playwright-core install chromium",
    "export OPENROUTER_API_KEY=…  EFFECT_BROWSER_BENCH_LIVE=1",
    "cd site && bun run dev",
  ].join("\n"),
  caption:
    "Run on Linux with Bun 1.4.2 on 11 October 2026. The install's tool patches, which print each binary's full path, are left out, and the download paths are shortened. Then open http://localhost:5173/try.",
  output:
    "Cloning into 'effect-agent-browserbase'...\nbun install v1.4.2 (744846f84)\n\n$ bun run patch:tsgo\n$ effect-tsgo patch --typescript --oxlint\n\n+ @effect/tsgo@0.51.0\n+ @stylistic/eslint-plugin@5.10.0\n+ @types/node@26.1.2\n+ effect@4.0.0\n+ oxfmt@0.72.0\n+ oxlint@1.82.0\n+ oxlint-tsgolint@7.0.2001\n+ playwright-core@1.63.0\n+ typescript@7.0.2\n+ vite@1.1.0\n+ vite-plus@1.1.0\n+ vitest@5.0.3\n\n450 packages installed [8.48s]\nDownloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243) from https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-linux64.zip\nChrome for Testing 153.0.8010.12 (playwright chromium v1243) downloaded to ~/.cache/ms-playwright/chromium-1243\nDownloading FFmpeg (playwright ffmpeg v1011) from https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-linux.zip\nFFmpeg (playwright ffmpeg v1011) downloaded to ~/.cache/ms-playwright/ffmpeg-1011\nDownloading Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243) from https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip\nChrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243) downloaded to ~/.cache/ms-playwright/chromium_headless_shell-1243\n$ vp dev\n[foldkit:devTools] MCP relay listening at ws://localhost:5173/__foldkit/devtools-mcp\n\n  VITE+ v1.1.0  \n\n  \u279c  Local:   http://localhost:5173/\n  \u279c  Network: use --host to expose\n",
};

export const CopySetup = Command.define("CopySetup", {
  messages: [Message.CompletedCopySetup],
  execute: Effect.tryPromise(() => navigator.clipboard.writeText(setup.commands)).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedCopySetup()),
  ),
});

export const CopyPrompt = Command.define("CopyPrompt", {
  messages: [Message.CompletedCopyPrompt],
  execute: Effect.tryPromise(() => navigator.clipboard.writeText(agentPrompt)).pipe(
    Effect.as(Message.CompletedCopyPrompt({ copied: true })),
    Effect.orElseSucceed(() => Message.CompletedCopyPrompt({ copied: false })),
  ),
});

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: {
    runner: Runner.Checking(),
    modelInput: "",
    maxUsdInput: "0.50",
    take: Take.Idle(),
    copy: "Idle",
    setup: "Code",
  },
  commands: [LoadStatus()],
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

const logOf = (take: Take) =>
  Take.match(take, {
    Idle: () => [],
    Starting: () => [],
    Recording: ({ log }) => log,
    Packed: ({ log }) => log,
    Failed: ({ log }) => log,
  });

const settle = (id: string, state: TakeState): Take =>
  TakeState.match(state, {
    Running: ({ log }): Take => Take.Recording({ id, log }),
    Packed: ({ log, replay }): Take => Take.Packed({ replay, log }),
    Failed: ({ log, reason }): Take => Take.Failed({ reason, log }),
  });

const parsedUsd = (input: string) => {
  const value = Number(input);

  return Number.isFinite(value) && value > 0 && value <= 5 ? Option.some(value) : Option.none();
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededLoadStatus: ({ status }) => ({
      model: modifyFields(model, {
        runner: () => Runner.Local({ status }),
        modelInput: () => status.defaults.model,
        maxUsdInput: () => status.defaults.maxUsd.toFixed(2),
      }),
    }),
    FailedLoadStatus: () => ({ model: modifyFields(model, { runner: () => Runner.Remote() }) }),
    UpdatedModelInput: ({ value }) => ({ model: modifyFields(model, { modelInput: () => value }) }),
    UpdatedMaxUsdInput: ({ value }) => ({
      model: modifyFields(model, { maxUsdInput: () => value }),
    }),
    SubmittedTake: () =>
      Option.match(parsedUsd(model.maxUsdInput), {
        onNone: () => ({
          model: modifyFields(model, {
            take: () => Take.Failed({ reason: "The cap must be between $0 and $5", log: [] }),
          }),
        }),
        onSome: (maxUsd) => ({
          model: modifyFields(model, { take: () => Take.Starting() }),
          commands: [StartTake({ model: model.modelInput.trim(), maxUsd })],
        }),
      }),
    SucceededStartTake: ({ id }) => ({
      model: modifyFields(model, { take: () => Take.Recording({ id, log: [] }) }),
      commands: [PollTake({ id })],
    }),
    FailedStartTake: ({ reason }) => ({
      model: modifyFields(model, { take: () => Take.Failed({ reason, log: [] }) }),
    }),
    TickedPoll: () =>
      model.take._tag === "Recording"
        ? { model, commands: [PollTake({ id: model.take.id })] }
        : { model },
    SucceededPollTake: ({ state }) => {
      const { take } = model;

      return take._tag === "Recording"
        ? { model: modifyFields(model, { take: () => settle(take.id, state) }) }
        : { model };
    },
    FailedPollTake: ({ reason }) => ({
      model: modifyFields(model, {
        take: (take) => Take.Failed({ reason, log: logOf(take) }),
      }),
    }),
    ClickedCopyPrompt: () => ({ model, commands: [CopyPrompt()] }),
    SelectedSetupTab: ({ tab }) => ({ model: modifyFields(model, { setup: () => tab }) }),
    ClickedCopySetup: () => ({ model, commands: [CopySetup()] }),
    CompletedCopySetup: () => ({ model }),
    CompletedCopyPrompt: ({ copied }) => ({
      model: modifyFields(model, { copy: () => (copied ? "Copied" : "Failed") }),
    }),
  });

// SUBSCRIPTION

export const pollStream = (recording: boolean) =>
  Stream.when(
    Stream.tick(Duration.seconds(1)).pipe(
      Stream.drop(1),
      Stream.map(() => Message.TickedPoll()),
    ),
    Effect.sync(() => recording),
  );

// VIEW

type H = HtmlBuilder<Message>;

const pre = (h: H, text: string, tone: string) =>
  h.pre(
    [h.Class(`overflow-x-auto px-4 py-3.5 font-mono text-[0.8125rem] leading-relaxed ${tone}`)],
    [h.code([], [text])],
  );

const remoteView = (model: Model, h: H): Html =>
  h.div(
    [h.Class("flex flex-col gap-5")],
    [
      h.p(
        [],
        [
          "A take runs where the site runs. Start it on your machine and this page finds the local runner there, records a narrated take and opens it in the player.",
        ],
      ),
      exampleView(
        {
          id: "try-setup",
          tab: model.setup,
          select: (tab) => Message.SelectedSetupTab({ tab }),
          source: setup.commands,
          copy: () => Message.ClickedCopySetup(),
          code: pre(h, setup.commands, "text-stone-100"),
          result: [h.p([], [setup.caption]), pre(h, setup.output, "text-stone-300")],
        },
        h,
      ),
      h.div(
        [
          h.Class(
            "flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900",
          ),
        ],
        [
          h.p(
            [h.Class("text-sm")],
            [
              h.strong([], ["Or hand it to your coding agent. "]),
              "The prompt points it at site/AGENTS.md, which says how to install, which key to ask you for and how to record.",
            ],
          ),
          h.blockquote(
            [
              h.Class(
                "border-l-2 border-amber-500 pl-3 text-sm text-stone-600 italic dark:text-stone-400",
              ),
            ],
            [agentPrompt],
          ),
          h.div(
            [h.Class("flex items-center gap-3")],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class(
                    "rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900",
                  ),
                  h.OnClick(Message.ClickedCopyPrompt()),
                ],
                ["Copy prompt for your coding agent"],
              ),
              h.span(
                [h.Class("text-xs text-stone-500"), h.AriaLive("polite")],
                [
                  model.copy === "Copied"
                    ? "Copied."
                    : model.copy === "Failed"
                      ? "Copying was blocked; select the text above."
                      : "",
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );

const logView = (h: H, log: ReadonlyArray<string>) =>
  log.length === 0
    ? h.empty
    : h.pre(
        [
          h.Class(
            "max-h-72 overflow-auto rounded-lg bg-stone-950 px-4 py-3 font-mono text-xs leading-relaxed text-stone-200",
          ),
        ],
        [h.code([], [log.join("\n")])],
      );

const takeView = (model: Model, h: H): Html =>
  Take.match(model.take, {
    Idle: () => h.empty,
    Starting: () => h.p([h.Class("text-sm text-stone-500")], ["Starting the take…"]),
    Recording: ({ log }) =>
      h.div(
        [h.Class("flex flex-col gap-2")],
        [
          h.p(
            [h.Class("flex items-center gap-2 text-sm font-medium")],
            [h.span([h.Class("size-2 animate-pulse rounded-full bg-rose-500")]), "Recording…"],
          ),
          logView(h, log),
        ],
      ),
    Packed: ({ replay, log }) =>
      h.div(
        [h.Class("flex flex-col gap-2")],
        [
          h.p(
            [h.Class("text-sm")],
            [
              "Your take is packed. ",
              h.a([h.Href(`/replay/${replay}`), h.Class("font-semibold underline")], ["Watch it"]),
            ],
          ),
          logView(h, log),
        ],
      ),
    Failed: ({ reason, log }) =>
      h.div(
        [h.Class("flex flex-col gap-2")],
        [
          h.p([h.Class("text-sm font-medium text-red-700 dark:text-red-400")], [reason]),
          logView(h, log),
        ],
      ),
  });

const localView = (model: Model, status: RunnerStatus, h: H): Html => {
  const busy = model.take._tag === "Starting" || model.take._tag === "Recording";
  const ready = status.missing.length === 0;

  const input = (label: string, value: string, toMessage: (value: string) => Message) =>
    h.label(
      [h.Class("flex flex-col gap-1 text-sm font-medium")],
      [
        label,
        h.input([
          h.Value(value),
          h.Class(
            "rounded-lg border border-stone-300 bg-white px-3 py-1.5 font-mono text-sm font-normal dark:border-stone-700 dark:bg-stone-950",
          ),
          h.OnInput(toMessage),
        ]),
      ],
    );

  return h.div(
    [h.Class("flex flex-col gap-5")],
    [
      h.p(
        [],
        [
          "The local runner is up. A take opens Polymarket in your Chromium, lets an agent explore it while a narrator watches and speaks, checks what the agent reports against Polymarket's public API, and packs the recording for the player.",
        ],
      ),
      ready
        ? h.empty
        : h.div(
            [
              h.Class(
                "rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950/40",
              ),
            ],
            [
              h.strong([], ["Before a take can start:"]),
              h.ul(
                [h.Class("mt-1 list-disc pl-5")],
                status.missing.map((item) => h.li([], [item])),
              ),
            ],
          ),
      h.form(
        [
          h.Class("grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end"),
          h.OnSubmit(Message.SubmittedTake()),
        ],
        [
          input("Model (OpenRouter)", model.modelInput, (value) =>
            Message.UpdatedModelInput({ value }),
          ),
          input("Spending cap, USD", model.maxUsdInput, (value) =>
            Message.UpdatedMaxUsdInput({ value }),
          ),
          h.button(
            [
              h.Type("submit"),
              h.Disabled(busy || !ready),
              h.Class(
                "h-9 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50",
              ),
            ],
            [busy ? "Recording…" : "Record a take"],
          ),
        ],
      ),
      takeView(model, h),
    ],
  );
};

export const view = defineView<Model, Message>((model, h) =>
  Runner.match(model.runner, {
    Checking: () => h.p([h.Class("text-sm text-stone-500")], ["Looking for a local runner…"]),
    Remote: () => remoteView(model, h),
    Local: ({ status }) => localView(model, status, h),
  }),
);
