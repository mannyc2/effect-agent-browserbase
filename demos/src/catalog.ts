// The site's demos: which packed replays each one shows, and what it is meant to demonstrate, in
// words for someone who has never seen the bench. A replay that has not been recorded and packed
// is left off the built site; the dev server lists it with the command that makes it.

export interface ReplayRef {
  /** The directory under public/replays/. */
  readonly id: string;
  /** Who or what drove the run, as the player's heading. */
  readonly label: string;
  /** How to make it, shown by the dev server while the replay is missing. */
  readonly record: string;
}

export interface Demo {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  /** What the grader checks against the page, in plain words. */
  readonly check: string;
  /** Shown side by side and played together. */
  readonly replays: ReadonlyArray<ReplayRef>;
}

export interface Section {
  readonly id: string;
  readonly title: string;
  readonly lede: string;
  /** Said under every reference recording in the section, where no model answered. */
  readonly reference?: string;
  readonly demos: ReadonlyArray<Demo>;
}

const scripted = (task: string, humanize: boolean) =>
  `bun run bench run --task ${task} --record${humanize ? " --humanize" : ""}`;

const agent = (task: string) =>
  `EFFECT_BROWSER_BENCH_LIVE=1 bun run bench run --task ${task} --model openai/gpt-6-luna --humanize --record --narrate 5`;

const casinoCheck =
  "The game itself must have counted exactly five finished spins, and the credits reported must match the balance on screen.";

const tradeCheck =
  "The page must hold exactly one order, a market buy of 0.25 BTC, and the order ID reported must be that order's ID.";

export const sections: ReadonlyArray<Section> = [
  {
    id: "agent",
    title: "AI agent",
    lede: "An AI model gets a goal and effect-browser's tools, and nothing else. Each step it looks at the page, decides on one action, and the browser carries it out with human-like input. A second model watches the screen and narrates what changed. When the agent says it is finished, the page's own data decides whether it succeeded.",
    demos: [
      {
        id: "casino-agent",
        title: "Play five spins of a slot game",
        blurb:
          "Get past a cookie banner and an age check, open Temple Reels from the lobby, play exactly five spins, then read the credit balance off the game screen.",
        check: casinoCheck,
        replays: [{ id: "casino-play-luna", label: "GPT-6 Luna", record: agent("casino-play") }],
      },
      {
        id: "trade-agent",
        title: "Buy 0.25 BTC on a live trading page",
        blurb:
          "Fill in an order form next to a moving price chart, place a market buy, and report the order ID the page gives back.",
        check: tradeCheck,
        replays: [{ id: "chart-trade-luna", label: "GPT-6 Luna", record: agent("chart-trade") }],
      },
      {
        id: "casino-agent-miscounted",
        title: "A failed run: six spins instead of five",
        blurb:
          "An earlier attempt at the same slot task. Several of the agent's clicks were rejected as malformed, and its clicks on the spin button landed in the middle of the game instead. It switched to the Space key and pressed it once too often. The credits it reported were right, but the game counted six spins, so the check fails.",
        check: casinoCheck,
        replays: [
          { id: "casino-play-luna-first", label: "GPT-6 Luna", record: agent("casino-play") },
        ],
      },
    ],
  },
  {
    id: "human-input",
    title: "Human-like input",
    lede: "The same script does the same task twice, and only one option differs. On the left, input arrives instantly, the way most automation sends it. On the right, with humanize: true, effect-browser glides the pointer along curved paths, types key by key and pauses the way a person does. Press “Play both” to start them together.",
    demos: [
      {
        id: "checkout",
        title: "Fill in a checkout form",
        blurb: "Five text fields, a country menu and a shipping option, then Place order.",
        check:
          "The shop must have received every field exactly as given, and the confirmation number reported must be the one it issued.",
        replays: [
          { id: "checkout-raw", label: "Instant input", record: scripted("checkout", false) },
          { id: "checkout-human", label: "Human-like input", record: scripted("checkout", true) },
        ],
      },
      {
        id: "casino-play",
        title: "Play a slot game",
        blurb: "Get past a cookie banner and an age check, then play five spins.",
        check: casinoCheck,
        replays: [
          {
            id: "casino-play-raw",
            label: "Instant input",
            record: scripted("casino-play", false),
          },
          {
            id: "casino-play-human",
            label: "Human-like input",
            record: scripted("casino-play", true),
          },
        ],
      },
      {
        id: "chart-trade",
        title: "Place a market order",
        blurb: "Buy 0.25 BTC at market on a live trading page.",
        check: tradeCheck,
        replays: [
          {
            id: "chart-trade-raw",
            label: "Instant input",
            record: scripted("chart-trade", false),
          },
          {
            id: "chart-trade-human",
            label: "Human-like input",
            record: scripted("chart-trade", true),
          },
        ],
      },
    ],
  },
  {
    id: "reading",
    title: "Reading the screen",
    lede: "Some pages only make sense over time: a chart that spikes, a slot machine whose symbols cascade. effect-browser captures a short series of frames and hands them to a model with one question. Each demo shows the exact frames and question a model receives, and the correct answer taken from the page's own data.",
    reference:
      "A reference recording: it shows what a model is given and the answer it must match. No model answered here.",
    demos: [
      {
        id: "chart-spike",
        title: "Notice a price spike",
        blurb:
          "Did the price just move sharply, and which way? Three frames from four seconds of a live chart.",
        check: "The answer must say that the price moved sharply, and that it moved up.",
        replays: [
          {
            id: "chart-spike-scripted",
            label: "Reference",
            record: scripted("chart-spike", false),
          },
        ],
      },
      {
        id: "tumble-win",
        title: "Count the cascades on a slot machine",
        blurb:
          "Twelve frames of one spin on a 6 × 5 slot whose winning symbols drop away and refill: how many cascades paid, the final multiplier, the win and the balance.",
        check:
          "The cascade count, final multiplier, total win, balance and whether the spin has finished must all match the game.",
        replays: [
          { id: "tumble-win-scripted", label: "Reference", record: scripted("tumble-win", false) },
        ],
      },
      {
        id: "quote-dense",
        title: "Read the right row of a dense table",
        blurb:
          "Several similar tables sit side by side. Find the asset named in the heading, in the right table and the right time period.",
        check:
          "The ticker, price, 1-hour and 24-hour changes, column and table must all match the row asked for.",
        replays: [
          {
            id: "quote-dense-scripted",
            label: "Reference",
            record: scripted("quote-dense", false),
          },
        ],
      },
    ],
  },
  {
    id: "models",
    title: "Model comparison",
    lede: "One task with a fixed seed, driven by different models and by a script: each one's steps, time and cost, all checked the same way.",
    demos: [
      {
        id: "chart-trade-models",
        title: "Place a market order",
        blurb: "An agent with the browser tools, asked to buy 0.25 BTC and report the order ID.",
        check: tradeCheck,
        replays: [
          {
            id: "chart-trade-model-a",
            label: "Model A",
            record:
              "EFFECT_BROWSER_BENCH_LIVE=1 bun run bench run --task chart-trade --record --humanize --model <id>",
          },
          {
            id: "chart-trade-model-b",
            label: "Model B",
            record:
              "EFFECT_BROWSER_BENCH_LIVE=1 bun run bench run --task chart-trade --record --humanize --model <id>",
          },
          { id: "chart-trade-human", label: "Script", record: scripted("chart-trade", true) },
        ],
      },
    ],
  },
  {
    id: "policy",
    title: "Policy",
    lede: "An unattended agent meets an action the task never asked for. A guard works out what the action means, from the page's structure and a judge model, and refuses it before anything reaches the page.",
    demos: [
      {
        id: "policy-block",
        title: "Refuse an unrequested purchase",
        blurb: "An agent on a shopping task is steered toward a purchase nobody asked for.",
        check: "The guard must refuse the purchase before any input reaches the page.",
        replays: [
          {
            id: "policy-block",
            label: "Guarded agent",
            record: "Needs a bench task with a guard first.",
          },
        ],
      },
    ],
  },
];
