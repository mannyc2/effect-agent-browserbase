// A small narrated replay, for tests of the player and the site: two agent steps, what the agent
// was doing around them, one narrated moment and an answer that checked out, on a 30 second video
// starting at host time 1000.
import { Schema } from "effect";

import { Replay } from "../src/replay.ts";

export const replay = Schema.decodeSync(Replay)({
  version: 1,
  task: {
    name: "polymarket",
    kind: "operate",
    summary: "Explore Polymarket and report a market",
    prompt: "Explore Polymarket and report one market you found interesting.",
  },
  run: {
    trial: 1,
    seed: 0,
    model: "openai/gpt-6-luna",
    reasoning: "low",
    browser: "chromium",
    humanize: true,
    commit: "0000000",
    dirty: false,
  },
  startedAt: 0,
  endedAt: 31_000,
  events: [
    { sequence: 1, event: { _tag: "PageOpened", at: 100, page: "p1", url: "about:blank" } },
    {
      sequence: 2,
      event: {
        _tag: "Navigated",
        at: 200,
        page: "p1",
        url: "https://polymarket.com/",
        document: 1,
        sameDocument: false,
      },
    },
  ],
  viewports: [{ page: "p1", width: 1280, height: 720 }],
  steps: [
    { at: 2000, step: 1, text: "", calls: [{ name: "observe", params: {} }], results: [] },
    {
      at: 12_000,
      step: 2,
      text: "Opening the ceasefire market.",
      calls: [{ name: "act", params: { actions: [{ kind: "click", ref: "e4" }] } }],
      results: [],
    },
  ],
  moments: [
    {
      at: 5000,
      from: 1000,
      frames: [{ file: "moments/0-0.jpg", hostTime: 3000 }],
      question: "Say one line about what the screen shows.",
      caption: "The Iran ceasefire market shows October 12 at 97%.",
      readyAt: 6000,
    },
  ],
  problems: [],
  outcome: {
    status: "graded",
    reason: "answered",
    pass: true,
    detail: "Every market matched Polymarket's API",
    answer: { question: "US-Iran ceasefire continues?", outcome: "October 12", probability: 0.97 },
    calls: 3,
    knownUsd: 0.012,
    seconds: 30,
  },
  video: {
    file: "video.mp4",
    startsAt: 1000,
    durationMillis: 30_000,
    width: 1280,
    height: 720,
    frames: 900,
  },
  // A screenshot, then thinking until each step, the first reading the page and the second acting.
  activity: [
    { kind: "look", start: 900, end: 950, failed: false },
    { kind: "think", start: 950, end: 2000, failed: false },
    { kind: "look", tool: "observe", start: 2000, end: 2040, failed: false },
    { kind: "look", start: 9350, end: 9400, failed: false },
    { kind: "think", start: 9400, end: 12_000, failed: false },
    { kind: "act", tool: "act", start: 12_000, end: 13_500, failed: false },
  ],
  narration: {
    voice: "openai/gpt-audio-mini, voice marin",
    captions: "captions.vtt",
    lines: [
      {
        text: "The Iran ceasefire market shows October 12 at 97%.",
        from: 1000,
        until: 5000,
        readyAt: 6000,
        at: 6000,
        end: 9000,
      },
    ],
  },
});
