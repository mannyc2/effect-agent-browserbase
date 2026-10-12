# For AI agents

This site is written to be read by agents as well as people. Everything a page says is available as plain markdown, and the replays' data is plain JSON and WebVTT.

## Markdown

- Every page is available as markdown at its URL plus `.md`: [/docs/get-started.md](/docs/get-started.md), and [/index.md](/index.md) for the home page.
- Requesting a page's URL with `Accept: text/markdown` returns the same markdown.
- A page served as HTML names its markdown in a `Link` header and in a `<link rel="alternate" type="text/markdown">` in its head.
- [/llms.txt](/llms.txt) lists every page with a one-line summary and its markdown link.
- [/llms-full.txt](/llms-full.txt) is every page in one file.
- [/api/v1/pages.json](/api/v1/pages.json) lists the pages as JSON: slug, title, summary and both URLs.

A replay embedded in a page appears in its markdown as links to the replay's data files, and `/replay/<id>.md` describes any replay. `robots.txt` allows all crawlers and signals `ai-train=yes, search=yes, ai-input=yes`.

## Replay data

A packed replay lives under `/replays/<id>/`:

| File            | What it holds                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `replay.json`   | The recording: every browser event on one host clock, the agent's turns, the moments the agent was shown, the spoken lines and the outcome |
| `video.mp4`     | The browser's screencast, H.264, with the narration as its audio track                                                                     |
| `captions.vtt`  | The narration as WebVTT, timed from the video's start                                                                                      |
| `moments/*.jpg` | The frames each moment held                                                                                                                |

## Working on this repository

A coding agent working on the site reads [site/AGENTS.md](https://github.com/mannyc2/effect-agent-browserbase/blob/main/site/AGENTS.md); the repository's own rules are in [AGENTS.md](https://github.com/mannyc2/effect-agent-browserbase/blob/main/AGENTS.md). To record a take of the demo, an agent follows [Run the demo yourself](/docs/run-the-demo) and asks its person for an OpenRouter key and a spending cap first.
