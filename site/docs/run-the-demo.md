# Run the demo yourself

The demo is a take you can record on your own machine: your Chromium, your OpenRouter key, your spending cap. An agent explores Polymarket on its own, a narrator watches the screen and writes a line every few seconds, a voice speaks each line as it arrives, and the markets the agent reports are checked against Polymarket's public API. The take is packed into a replay and opens in the player.

## Set up

Clone the repository, install it and download the Chromium a take records in. A take makes model calls, so it also needs your OpenRouter key and an explicit opt-in.

:::Example
```sh
git clone https://github.com/mannyc2/effect-agent-browserbase
cd effect-agent-browserbase
bun install
./node_modules/.bin/playwright-core install chromium
export OPENROUTER_API_KEY=…
export EFFECT_BROWSER_BENCH_LIVE=1
```

Run on Linux on 11 October 2026, it printed this, leaving out the two lines of the install's own setup script:

```text output
Cloning into 'effect-agent-browserbase'...
bun install v1.4.2 (744846f84)

+ @effect/tsgo@0.51.0
+ @stylistic/eslint-plugin@5.10.0
+ @types/node@26.1.2
+ effect@4.0.0
+ oxfmt@0.72.0
+ oxlint@1.82.0
+ oxlint-tsgolint@7.0.2001
+ playwright-core@1.63.0
+ typescript@7.0.2
+ vite@1.1.0
+ vite-plus@1.1.0
+ vitest@5.0.3

450 packages installed [8.48s]
Downloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243) from https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-linux64.zip
Chrome for Testing 153.0.8010.12 (playwright chromium v1243) downloaded to ~/.cache/ms-playwright/chromium-1243
Downloading FFmpeg (playwright ffmpeg v1011) from https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-linux.zip
FFmpeg (playwright ffmpeg v1011) downloaded to ~/.cache/ms-playwright/ffmpeg-1011
Downloading Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243) from https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip
Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243) downloaded to ~/.cache/ms-playwright/chromium_headless_shell-1243
```
:::

## Record a take

From `site/`, `bun run demo take` records a take; `--model`, `--max-usd`, `--every` and `--headed` change it. The take is packed into `public/replays/<id>/`, and `bun run dev` serves it at `/replay/<id>`. The dev server also serves the local runner the [Try page](/try) uses, which shows what a take still needs and records one with the model and cap you choose.

:::Example
```sh
cd site
bun run demo take --id polymarket-take5 --max-usd 0.5
```

This is the featured take, recorded on 11 October 2026 and then moved to `public/replays/polymarket/`. It printed the lines below, with paths shortened and the agent's warnings about tool calls that failed and were handed back to it left out:

```text output
$ node --conditions=@effect-browser/source demo/main.ts take --id "polymarket-take5" --max-usd "0.5"
Take polymarket-take5: openai/gpt-6-luna, recording into ~/effect-agent-browserbase/.work/demo/2026-10-11T21-32-22-678Z-polymarket-take5
graded pass answered, 185s, 44 model calls, $0.1049 known + $0.0000 unresolved
3 of 3 reported markets match Polymarket's API, within 4 points. Which company has the best AI model end of October? (Google): reported 69.2%, Polymarket's API 69.3%; Which company has best AI model end of 2026? (Google): reported 43%, Polymarket's API 42.5%; What price will Bitcoin hit in October? (↑ 87,500): reported 54%, Polymarket's API 53.5%.
  said: Hi, everyone. Polymarket is a prediction market where prices show the odds of possible outcomes. The agent will browse in view-only mode, check what’s trending, explore a topic, search, and open markets to see how their odds have moved. Let’s watch.
  said: The prompt’s gone, and Brazil’s presidential race is front and center, with Flávio Bolsonaro at eighty-seven percent.
  said: A live football market has taken its place, and San Francisco’s odds have slipped to fifty-four percent.
  said: Politics is selected now, with midterms and presidential races in view; next, it can pick a market to inspect.
  said: The AI search brings up Z.ai and Baidu model forecasts, both under one percent; it can choose one to inspect.
  said: The full results page is open, with four hundred thirty-six matches; it can choose a market and check its chart.
  said: That first AI forecast stands out, so it’s opening the October model question to see how its odds have moved.
  said: Google leads at about sixty-nine percent, and the chart shows a sharp drop near October before recovering.
  said: It’s on the market page now, and the chart’s settled back near seventy percent for Google.
  said: The chart’s hovered near the end, with Google around seventy percent and Anthropic at thirty.
  said: Google’s line stays near seventy percent, while Anthropic’s sits around thirty; I’ll move down to see what else this market shows.
  said: The chart remains in view, so it hasn’t reached the details yet; we can keep looking for what’s below.
  said: Now the outcome list is in view, and several other companies are below one percent.
  said: The year-end chart shows Google at forty-three percent and Anthropic close behind at forty-two, with a sharp recent shift.
  said: It’s reached the bottom of the company list, with Amazon still below one percent; next, we can inspect another market.
  said: This Bitcoin market asks how high it’ll go in October; the chart climbs early, then drops sharply before recovering.
  said: The strike list puts fifteen thousand at under one percent, while ninety-two thousand five hundred sits at twenty-two percent.
  said: We’re farther down the strikes now, where ninety thousand is at thirty-five percent and eighty-seven thousand five hundred is just below.
  said: That outcome is selected, and its order book is open; the yes price sits at fifty-four cents.
  said: That lower strike is at fifty-four percent, down thirteen points; the order book shows asks at fifty-four cents.
  said: That wraps up the run. The agent’s picks are Google at sixty-nine point two percent for the October AI model market, Google at forty-three percent for the end-of-twenty-twenty-six market, and the eighty-seven-thousand-five-hundred-dollar Bitcoin threshold at fifty-four percent. All three matched Polymarket’s public data. Thanks for watching.
polymarket-take5: 6897 of 6897 frames, 198.4s, 21 of 21 lines spoken, in ~/effect-agent-browserbase/site/public/replays/polymarket-take5/
Packed polymarket-take5: 21 lines spoken for $0.0102; the take cost $0.1152 in all.
```
:::

The agent and the narrator run on one OpenRouter model; the voice is `openai/gpt-audio-mini`. The cap covers all three: every call reserves its worst case against it before it is sent, and settles to what it actually cost. The featured take ran just over three minutes on a cheap model: 44 model calls and 21 spoken lines for $0.12 in all, voice included.

From the United States, Polymarket opens with a notice about trading from the US; the agent continues in view-only mode, which is all a reading take needs.

## What a take records

- The browser's own screencast, as video, with the pointer's planned glides, every press, wheel and key drawn over it from the recorded input.
- Each of the agent's turns: what it said, the tools it called and what they returned.
- Each narrator line: the moment it captioned, the frames it saw, when its words arrived and when the voice spoke them. The lines are also written out as WebVTT captions.
- The agent's answer and how it checked out against Polymarket's API at the time of the run.

## How the answer is checked

The agent reports three markets: each one's title as its page shows it, the outcome it quotes and that outcome's chance. The check searches Polymarket's public Gamma API for each title and passes a market that is open and within 4 points of the chance the agent read, since odds move while it browses. For an event with several options, the agent must name the option, such as a date or a range; "Yes" alone is a miss, and the check lists the options it had. A market the API does not answer for counts as not checked, so the take fails its check and still packs.

## The casino demo

`bun run demo take --demo casino` records a second demo, an agent playing a slot machine. It starts in an online casino's lobby, finds the slot Opal Crown, opens it in demo mode, sets the bet, reads the paytable and plays six spins. The game is drawn on a canvas inside the game studio's iframe, as real casino games are. Its reels, balance, bet and wins are pictures with no text behind them, so the agent reads every result from screenshots and plays by clicking points on them.

The casino, the studio and the game were made for this demo. The take serves them at their own HTTPS addresses by request interception, and nothing on them tells the agent so. The game server decides each spin from a fixed seed, which deals four wins in the first six spins at a $2 bet, the last of them a big one. It keeps its own record of every spin. The agent reports six things: what five Crowns pay, the bet it played at, each spin's win in order, the final balance and its biggest win's symbol and count. The check compares each one with that record, to the cent.

::Replay{id="casino"}

## Hand it to your coding agent

The repository's `site/AGENTS.md` tells a coding agent how to install, which key to ask you for and how to record a take. On the deployed site, the [Try page](/try) has a prompt to copy.
