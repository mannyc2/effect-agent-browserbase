import { Effect } from "effect";
import type { AnySession } from "effect-browser/browser";
import { NavigateRequest } from "effect-browser/browser-data";

import * as Camera from "./Camera.ts";
import * as Storyboard from "./Storyboard.ts";

export interface FootageRequest {
  /** Where the film opens. Its origin must be one the read-only clock probe allows. */
  readonly url: string;
  readonly storyboard: Storyboard.Storyboard;
  readonly outputPath: string;
  /** The same seed performs the same presentation paths and pauses. */
  readonly seed: number;
  readonly film?: Camera.FilmOptions;
}

/**
 * Film one storyboard on the original issued Page, with public performed actions.
 *
 * The opening document is loaded and ready before the camera rolls, so the
 * film never starts on a blank page or on text reflowing into its web font.
 */
export const record = Effect.fn("Footage.record")(function* (
  session: AnySession,
  request: FootageRequest,
) {
  const page = session.initialPage;

  yield* page.navigate(NavigateRequest.make({ url: request.url }));
  yield* page.ready();

  return yield* Camera.film(
    session,
    page,
    request.outputPath,
    Storyboard.perform(page, request.storyboard, request.seed),
    request.film,
  );
});

/** The storyboard the committed test films against `StageSite`. */
export const demo: Storyboard.Storyboard = [
  { _tag: "Pause", millis: 900 },
  { _tag: "Caption", text: "Find a sleeper train to Venice" },
  {
    _tag: "Browser",
    step: {
      id: "hover-destination",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Hover",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "input",
            label: "Where do you want to wake up?",
            matchScope: "document",
            identity: { inputType: "text", autocomplete: "off" },
          },
        },
      },
    },
  },
  { _tag: "Pause", millis: 120 },
  {
    _tag: "Browser",
    step: {
      id: "focus-destination",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Click",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "input",
            label: "Where do you want to wake up?",
            matchScope: "document",
            identity: { inputType: "text", autocomplete: "off" },
          },
        },
      },
    },
  },
  { _tag: "Pause", millis: 350 },
  {
    _tag: "Browser",
    step: {
      id: "type-destination",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Type",
        text: { _tag: "Literal", value: "Venice" },
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "input",
            label: "Where do you want to wake up?",
            matchScope: "document",
            identity: { inputType: "text", autocomplete: "off" },
          },
        },
      },
    },
  },
  { _tag: "Read", words: 14 },
  {
    _tag: "Browser",
    step: {
      id: "hover-route",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Hover",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "link",
            label: "Vienna → Venice21:27 – 08:2410 h 57Nightlyfrom €59",
            matchScope: "document",
          },
        },
      },
    },
  },
  { _tag: "Pause", millis: 120 },
  {
    _tag: "Browser",
    step: {
      id: "open-route",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Click",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "link",
            label: "Vienna → Venice21:27 – 08:2410 h 57Nightlyfrom €59",
            matchScope: "document",
          },
        },
      },
      expect: { after: [{ _tag: "Path", value: "/routes/vienna-venice" }] },
    },
  },
  { _tag: "Pause", millis: 350 },
  { _tag: "Caption", text: "Check where it stops overnight" },
  { _tag: "Read", words: 20 },
  {
    _tag: "Browser",
    step: {
      id: "read-stops",
      resolution: { _tag: "Strict" },
      action: { _tag: "Scroll", mode: { _tag: "By", deltaX: 0, deltaY: 700 } },
    },
  },
  { _tag: "Read", words: 36 },
  { _tag: "Caption", text: "Pick a berth and hold it" },
  // Hover never scrolls; bring the berth into view as its own visible step first.
  {
    _tag: "Browser",
    step: {
      id: "show-berth",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Scroll",
        mode: {
          _tag: "To",
          target: {
            _tag: "Descriptor",
            descriptor: {
              kind: "button",
              label: "CouchetteFour bunks, bedding included€99",
              matchScope: "document",
            },
          },
        },
      },
    },
  },
  {
    _tag: "Browser",
    step: {
      id: "hover-berth",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Hover",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "button",
            label: "CouchetteFour bunks, bedding included€99",
            matchScope: "document",
          },
        },
      },
    },
  },
  { _tag: "Pause", millis: 120 },
  {
    _tag: "Browser",
    step: {
      id: "choose-berth",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Click",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "button",
            label: "CouchetteFour bunks, bedding included€99",
            matchScope: "document",
          },
        },
      },
    },
  },
  { _tag: "Pause", millis: 350 },
  {
    _tag: "Browser",
    step: {
      id: "hover-hold",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Hover",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "button",
            label: "Hold this berth",
            matchScope: "document",
          },
        },
      },
    },
  },
  { _tag: "Pause", millis: 120 },
  {
    _tag: "Browser",
    step: {
      id: "hold-berth",
      resolution: { _tag: "Strict" },
      action: {
        _tag: "Click",
        target: {
          _tag: "Descriptor",
          descriptor: {
            kind: "button",
            label: "Hold this berth",
            matchScope: "document",
          },
        },
      },
    },
  },
  { _tag: "Pause", millis: 350 },
  { _tag: "Caption", text: "" },
  {
    _tag: "Browser",
    step: {
      id: "show-held",
      resolution: { _tag: "Strict" },
      action: { _tag: "Scroll", mode: { _tag: "By", deltaX: 0, deltaY: 400 } },
    },
  },
  { _tag: "Read", words: 16 },
];
