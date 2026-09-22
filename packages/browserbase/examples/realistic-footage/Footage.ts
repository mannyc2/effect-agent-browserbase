import { Effect, Random } from "effect";
import type { BrowserSession } from "effect-browser/browser";
import { NavigateRequest } from "effect-browser/browser-data";

import * as Camera from "./Camera.ts";
import * as Storyboard from "./Storyboard.ts";

export interface FootageRequest {
  /** Where the film opens. Its origin must be one the stagehand plan allows. */
  readonly url: string;
  readonly storyboard: Storyboard.Storyboard;
  readonly outputPath: string;
  /** The same seed performs the same film: every path, pause and slip of the keys. */
  readonly seed: string;
  readonly film?: Camera.FilmOptions;
}

/**
 * Film one storyboard on a session opened with `Stagehand.plan`.
 *
 * The opening document is loaded and ready before the camera rolls, so the
 * film never starts on a blank page or on text reflowing into its web font.
 */
export const record = Effect.fn("Footage.record")(function* (
  session: BrowserSession,
  request: FootageRequest,
) {
  yield* session.bind().navigate(NavigateRequest.make({ url: request.url }));
  yield* session.ready;

  return yield* Camera.film(
    session,
    request.outputPath,
    Storyboard.perform(session, request.storyboard),
    request.film,
  ).pipe(Random.withSeed(request.seed));
});

/** The storyboard the committed test films against `StageSite`. */
export const demo: Storyboard.Storyboard = [
  { _tag: "Pause", millis: 900 },
  { _tag: "Caption", text: "Find a sleeper train to Venice" },
  { _tag: "Type", selector: "#destination", text: "Venice" },
  { _tag: "Read", words: 14 },
  { _tag: "Follow", selector: 'a.route[href="/routes/vienna-venice"]' },
  { _tag: "Caption", text: "Check where it stops overnight" },
  { _tag: "Read", words: 20 },
  { _tag: "ScrollTo", selector: "#stops li:nth-child(7)" },
  { _tag: "Read", words: 36 },
  { _tag: "Caption", text: "Pick a berth and hold it" },
  { _tag: "Click", selector: '.berth[data-kind="couchette"]' },
  { _tag: "Click", selector: "#hold" },
  { _tag: "Caption", text: "" },
  { _tag: "ScrollTo", selector: "#held" },
  { _tag: "Read", words: 16 },
];
