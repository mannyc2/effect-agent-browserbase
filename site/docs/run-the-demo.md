# Run the demo yourself

The demo is a take you can record on your own machine: your Chromium, your OpenRouter key, your spending cap. An agent explores Polymarket on its own, a narrator watches the screen and writes a line every few seconds, a voice speaks each line as it arrives, and the markets the agent reports are checked against Polymarket's public API. The take is packed into a replay and opens in the player.

## Set up

```sh
git clone https://github.com/mannyc2/effect-agent-browserbase
cd effect-agent-browserbase
bun install
./node_modules/.bin/playwright-core install chromium
```

A take makes model calls, so it needs a key and an explicit opt-in:

```sh
export OPENROUTER_API_KEY=…
export EFFECT_BROWSER_BENCH_LIVE=1
```

## Record a take

Start the site and open the Try page:

```sh
cd site && bun run dev
# open http://localhost:5173/try
```

The page finds the local runner that `bun run dev` serves, shows what it still needs, and records a take with the model and cap you choose. When the take is packed, it opens in the player at `/replay/<id>`. From a terminal, `bun run demo` in `site/` records the same take.

The agent and the narrator run on one OpenRouter model; the voice is `openai/gpt-audio-mini`. The cap covers all three: every call reserves its worst case against it before it is sent, and settles to what it actually cost. A cheap model keeps a take to a few cents.

From the United States, Polymarket opens with a notice about trading from the US; the agent continues in view-only mode, which is all a reading take needs.

## What a take records

- The browser's own screencast, as video, with the pointer's planned glides, every press, wheel and key drawn over it from the recorded input.
- Each of the agent's turns: what it said, the tools it called and what they returned.
- Each narrator line: the moment it captioned, the frames it saw, when its words arrived and when the voice spoke them. The lines are also written out as WebVTT captions.
- The agent's answer and how it checked out against Polymarket's API at the time of the run.

## Hand it to your coding agent

The repository's `site/AGENTS.md` tells a coding agent how to install, which key to ask you for and how to record a take. On the deployed site, the [Try page](/try) has a prompt to copy.
