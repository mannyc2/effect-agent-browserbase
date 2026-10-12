// The player's view: the video with the recorded pointer and the spoken captions over it, its
// chapters on the timeline, and beside it the transcript that follows along. Under them, what the
// run found, each finding with the place in the video it was found, and how the run was made.
import { Option } from "effect";
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { clock, cost, duration, type Field, fields, items } from "../present.ts";
import { type ActivityKind, pointerAt, recentMark, type Replay } from "../replay.ts";
import {
  type CallWords,
  captionAt,
  type Chapter,
  chapterAt,
  currentEntry,
  decisionAt,
  type Derived,
  type Entry,
  glanceAt,
  phaseAt,
  viewportOf,
} from "./derive.ts";
import { Message, type Speed } from "./message.ts";
import { baseOf, feedIdOf, Load, type Model, videoIdOf, WatchVideo } from "./player.ts";

type H = HtmlBuilder<Message>;

const speeds: ReadonlyArray<Speed> = [1, 1.5, 2, 4];

const icon = (h: H, path: string, size = "size-5") =>
  h.svg(
    [h.ViewBox("0 0 24 24"), h.Class(size), h.AriaHidden(true)],
    [h.path([h.Attribute("d", path), h.Fill("currentColor")])],
  );

const playIcon = "M8 5.5v13l11-6.5z";
const pauseIcon = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";
const replayIcon = "M12 5V2L7.5 6 12 10V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z";
const soundIcon = "M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z";

const mutedIcon =
  "M4 9v6h4l5 4V5L8 9H4zm15.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4z";

interface KindLook {
  readonly icon: string;
  /** The chip over the video. */
  readonly chip: string;
  /** The icon's colour in the transcript. */
  readonly mark: string;
  /** Its stretches on the timeline. */
  readonly bar: string;
}

/** Each kind of thing the agent does, marked the same way over the video and in the transcript. */
const kinds: Readonly<Record<ActivityKind, KindLook>> = {
  think: {
    icon: "M12 2l1.9 5.6 5.6 1.9-5.6 1.9L12 17l-1.9-5.6-5.6-1.9 5.6-1.9zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9z",
    chip: "bg-violet-600/90 text-white",
    mark: "text-violet-600 dark:text-violet-400",
    bar: "bg-violet-500",
  },
  look: {
    icon: "M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    chip: "bg-sky-600/90 text-white",
    mark: "text-sky-600 dark:text-sky-400",
    bar: "bg-sky-500",
  },
  act: {
    icon: "M6 3l12.5 9.2-5.6.9 3.3 6.4-2.4 1.2-3.3-6.5L6 18.2z",
    chip: "bg-white/95 text-stone-900 [&_svg]:text-orange-600",
    mark: "text-orange-600 dark:text-orange-400",
    bar: "bg-orange-500",
  },
  wait: {
    icon: "M6 2v6l4 4-4 4v6h12v-6l-4-4 4-4V2zm10 14.5V20H8v-3.5l4-4zm-4-5-4-4V4h8v3.5z",
    chip: "bg-stone-800/85 text-white",
    mark: "text-stone-500 dark:text-stone-400",
    bar: "bg-stone-400 dark:bg-stone-500",
  },
  report: {
    icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-3.1 16-3.5-3.5 1.4-1.4 2.1 2.1 4.2-4.2 1.4 1.4zM13 9V3.5L18.5 9z",
    chip: "bg-emerald-600/90 text-white",
    mark: "text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
  },
};

const checkIcon = "M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z";

const crossIcon =
  "M18.3 7.1 16.9 5.7 12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z";

/** The standard arrow pointer, with its hot spot at the origin. */
const arrowPath = "M0 0 L0 17 L4.5 13 L7.5 20 L10.5 18.8 L7.6 12 L13 12 Z";

// SCREEN

const overlay = (replay: Replay, derived: Derived, now: number, h: H): Html => {
  const { width, height } = viewportOf(replay);
  const press = recentMark(derived.track.presses, now, 500);
  const wheel = recentMark(derived.track.wheels, now, 500);
  const pointer = pointerAt(derived.track, now);

  return h.svg(
    [
      h.ViewBox(`0 0 ${width} ${height}`),
      h.PreserveAspectRatio("none"),
      h.Class("pointer-events-none absolute inset-0 size-full"),
      h.AriaHidden(true),
    ],
    [
      press === undefined
        ? h.empty
        : h.circle([
            h.Cx(String(press.mark.x)),
            h.Cy(String(press.mark.y)),
            h.Attribute("r", String(8 + press.progress * 30)),
            h.Fill("none"),
            h.Stroke("#f97316"),
            h.StrokeWidth("4"),
            h.StrokeOpacity(String(1 - press.progress)),
          ]),
      wheel === undefined
        ? h.empty
        : h.path([
            h.Attribute(
              "d",
              (() => {
                const direction = Math.sign(wheel.mark.dy) || 1;
                const x = wheel.mark.x + 28;
                const y = wheel.mark.y + direction * wheel.progress * 14;

                return `M${x - 8} ${y - direction * 6} L${x + 8} ${y - direction * 6} L${x} ${y + direction * 7} Z`;
              })(),
            ),
            h.Fill("#3b82f6"),
            h.FillOpacity(String(1 - wheel.progress)),
          ]),
      pointer === undefined
        ? h.empty
        : h.path([
            h.Attribute("d", arrowPath),
            h.Transform(`translate(${pointer.x} ${pointer.y}) scale(1.4)`),
            h.Fill("#111"),
            h.Stroke("#fff"),
            h.StrokeWidth("1.5"),
            h.Attribute("paint-order", "stroke"),
          ]),
    ],
  );
};

/**
 * What the agent is doing, over the video's corner: a chip marked for thinking, looking, acting,
 * waiting or reporting, and under it what it last decided, dimmed while it thinks about the next.
 */
const activityView = (replay: Replay, derived: Derived, now: number, h: H): Html => {
  const phase = phaseAt(replay, derived.spans, now);
  const decision = decisionAt(replay, now);

  return phase === undefined && decision === undefined
    ? h.empty
    : h.div(
        [
          h.Class(
            "pointer-events-none absolute top-3 left-3 flex max-w-[min(26rem,calc(100%-1.5rem))] flex-col items-start gap-1.5",
          ),
          h.DataAttribute("testid", "activity"),
        ],
        [
          phase === undefined
            ? h.empty
            : h.span(
                [
                  h.Class(
                    `flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-2 text-xs font-medium shadow-sm backdrop-blur ${
                      phase.failed ? "bg-red-600/90 text-white" : kinds[phase.kind].chip
                    }`,
                  ),
                ],
                [
                  h.span(
                    [h.Class(phase.kind === "think" ? "animate-pulse" : "")],
                    [icon(h, kinds[phase.kind].icon, "size-3.5")],
                  ),
                  phase.label,
                  phase.kind === "think" || phase.kind === "wait"
                    ? h.span(
                        [h.Class("font-mono tabular-nums opacity-75")],
                        [`${((now - phase.since) / 1000).toFixed(1)}s`],
                      )
                    : h.empty,
                ],
              ),
          decision === undefined
            ? h.empty
            : h.keyed("p")(
                `decision-${decision.at}`,
                [
                  h.Class(
                    `hidden rounded-lg px-2.5 py-1.5 text-xs leading-snug shadow-sm backdrop-blur transition-colors duration-300 sm:block sm:text-[0.8125rem] ${
                      decision.thinking ? "bg-black/45 text-white/65" : "bg-black/65 text-white"
                    }`,
                  ),
                ],
                [h.span([h.Class("line-clamp-2")], [decision.text])],
              ),
        ],
      );
};

/** The agent taking a screenshot: the frame it saw flashes and is framed, as by a viewfinder. */
const glanceView = (replay: Replay, now: number, h: H): Html => {
  const progress = glanceAt(replay, now);

  if (progress === undefined) return h.empty;
  const corner = (place: string) => h.span([h.Class(`absolute size-6 border-white ${place}`)]);

  return h.div(
    [
      h.Class("pointer-events-none absolute inset-2"),
      h.Style({ opacity: String(1 - progress) }),
      h.AriaHidden(true),
    ],
    [
      h.span([
        h.Class("absolute -inset-2 bg-white"),
        h.Style({ opacity: String(Math.max(0, 0.16 - progress * 0.5)) }),
      ]),
      corner("top-0 left-0 rounded-tl-md border-t-2 border-l-2"),
      corner("top-0 right-0 rounded-tr-md border-t-2 border-r-2"),
      corner("bottom-0 left-0 rounded-bl-md border-b-2 border-l-2"),
      corner("right-0 bottom-0 rounded-br-md border-r-2 border-b-2"),
    ],
  );
};

/** The narration as captions: the piece of the line being spoken, two short lines at most. */
const captionView = (model: Model, derived: Derived, h: H): Html => {
  const piece = captionAt(derived.entries, model.now);

  return model.captions === "Hidden" || piece === undefined
    ? h.empty
    : h.p(
        [
          h.Class(
            "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-6 text-center",
          ),
          h.AriaLive("off"),
          h.DataAttribute("testid", "caption"),
        ],
        [
          h.span(
            [
              h.Class(
                "max-w-[36rem] rounded-md bg-black/75 px-2.5 py-1 text-sm leading-snug text-balance text-white sm:text-base",
              ),
            ],
            [piece.text],
          ),
        ],
      );
};

const screenView = (model: Model, replay: Replay, derived: Derived, h: H): Html => {
  const playing = model.playback === "Playing";
  const ended = model.playback === "Ended";
  const base = baseOf(model.id);

  return h.div(
    [
      h.Class("group relative overflow-hidden rounded-t-xl bg-black"),
      h.Style({ "aspect-ratio": `${replay.video.width} / ${replay.video.height}` }),
    ],
    [
      h.video(
        [
          h.Id(videoIdOf(model.id)),
          h.Src(`${base}/${replay.video.file}`),
          h.Playsinline(true),
          h.Preload("auto"),
          h.Class("absolute inset-0 size-full"),
          h.OnMount(WatchVideo()),
        ],
        replay.narration === undefined
          ? []
          : [
              h.track([
                h.Attribute("kind", "captions"),
                h.Attribute("srclang", "en"),
                h.LabelAttr("Narration"),
                h.Src(`${base}/${replay.narration.captions}`),
              ]),
            ],
      ),
      overlay(replay, derived, model.now, h),
      glanceView(replay, model.now, h),
      activityView(replay, derived, model.now, h),
      captionView(model, derived, h),
      h.button(
        [
          h.Type("button"),
          h.Class(
            `absolute inset-0 flex flex-col items-center justify-center gap-3 transition ${playing ? "opacity-0" : ended ? "bg-black/55" : "bg-black/25"}`,
          ),
          h.AriaLabel(playing ? "Pause" : ended ? "Watch again" : "Play"),
          h.OnClick(playing ? Message.ClickedPause() : Message.ClickedPlay()),
        ],
        playing
          ? []
          : [
              h.span(
                [
                  h.Class(
                    "flex size-16 items-center justify-center rounded-full bg-white/95 text-stone-900 shadow-lg ring-1 ring-black/10 transition group-hover:scale-105 [&_svg]:size-8",
                  ),
                ],
                [icon(h, ended ? replayIcon : playIcon)],
              ),
              ended
                ? h.span([h.Class("text-sm font-semibold text-white")], ["Watch again"])
                : h.empty,
            ],
      ),
    ],
  );
};

// CONTROLS

/** Where host time `at` falls along the recording, from 0 to 1. */
const fractionOf = (replay: Replay, at: number) =>
  Math.min(1, Math.max(0, (at - replay.video.startsAt) / replay.video.durationMillis));

/** The timeline, split into the run's chapters, each filled as far as it has played. */
const timelineView = (model: Model, replay: Replay, derived: Derived, h: H): Html => {
  const { startsAt, durationMillis } = replay.video;
  const offset = Math.min(durationMillis, Math.max(0, model.now - startsAt));
  const ends = startsAt + durationMillis;

  const segments: ReadonlyArray<Pick<Chapter, "at">> =
    derived.chapters.length === 0 ? [{ at: startsAt }] : derived.chapters;

  return h.div(
    [h.Class("group/timeline relative h-5")],
    [
      ...(replay.activity ?? []).map((activity) => {
        const from = fractionOf(replay, activity.start);

        return h.span([
          h.Class(
            `pointer-events-none absolute top-0 h-[3px] min-w-px rounded-full ${activity.failed ? "bg-red-500" : kinds[activity.kind].bar}`,
          ),
          h.Style({
            left: `${from * 100}%`,
            width: `${(fractionOf(replay, activity.end) - from) * 100}%`,
          }),
        ]);
      }),
      ...segments.map((segment, index) => {
        const from = fractionOf(replay, segment.at);
        const to = fractionOf(replay, segments[index + 1]?.at ?? ends);

        const played =
          to === from
            ? 0
            : Math.min(1, Math.max(0, (offset / durationMillis - from) / (to - from)));

        return h.span(
          [
            h.Class(
              "pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-stone-300 transition-[height] group-hover/timeline:h-1.5 dark:bg-stone-700",
            ),
            h.Style({
              left: `${from * 100}%`,
              width: `calc(${(to - from) * 100}% - ${index === segments.length - 1 ? 0 : 3}px)`,
            }),
          ],
          [
            h.span([
              h.Class("absolute inset-y-0 left-0 bg-stone-900 dark:bg-stone-100"),
              h.Style({ width: `${played * 100}%` }),
            ]),
          ],
        );
      }),
      h.span([
        h.Class(
          "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-900 ring-2 ring-white dark:bg-white dark:ring-stone-900",
        ),
        h.Style({ left: `${(offset / durationMillis) * 100}%` }),
      ]),
      h.input([
        h.Type("range"),
        h.Min("0"),
        h.Max(String(Math.round(durationMillis))),
        h.Step("100"),
        h.Value(String(Math.round(offset))),
        h.AriaLabel("Position in the recording"),
        h.AriaValuetext(
          `${clock(offset, durationMillis)} of ${clock(durationMillis, durationMillis)}`,
        ),
        h.Class("absolute inset-0 size-full cursor-pointer opacity-0"),
        h.OnInput((value) => Message.UpdatedTimeline({ value })),
      ]),
    ],
  );
};

const controlButton = (
  h: H,
  label: string,
  pressed: Option.Option<boolean>,
  message: Message,
  content: ReadonlyArray<Html | string>,
) =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel(label),
      h.Title(label),
      ...Option.match(pressed, {
        onNone: () => [],
        onSome: (value) => [h.AriaPressed(value ? "true" : "false")],
      }),
      h.Class(
        `flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-sm font-medium text-stone-700 hover:bg-stone-200 aria-pressed:bg-stone-900 aria-pressed:text-white dark:text-stone-200 dark:hover:bg-stone-800 dark:aria-pressed:bg-stone-100 dark:aria-pressed:text-stone-900`,
      ),
      h.OnClick(message),
    ],
    content,
  );

/**
 * The narration's mute button, with its volume in a popover above it while the pointer is on either
 * or the keyboard's focus is. Phones set the volume with their own buttons, and iOS ignores a page's.
 */
const soundView = (model: Model, h: H): Html => {
  const volume = model.sound === "Muted" ? 0 : model.volume;

  return h.div(
    [h.Class("group/sound relative flex items-center")],
    [
      controlButton(
        h,
        model.sound === "On" ? "Mute the narration" : "Unmute the narration",
        Option.none(),
        Message.ClickedSound(),
        [icon(h, model.sound === "On" ? soundIcon : mutedIcon)],
      ),
      // Padding, not margin, joins the popover to the button, so the pointer can cross the gap.
      h.div(
        [
          h.Class(
            "absolute bottom-full left-1/2 z-20 hidden -translate-x-1/2 pb-2 pointer-fine:group-has-[button:focus-visible]/sound:block pointer-fine:group-has-[input:focus]/sound:block pointer-fine:group-hover/sound:block",
          ),
        ],
        [
          h.div(
            [
              h.Class(
                "flex h-28 w-10 items-center justify-center rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900",
              ),
            ],
            [
              h.input([
                h.Type("range"),
                h.Min("0"),
                h.Max("1"),
                h.Step("0.05"),
                h.Value(String(volume)),
                h.AriaLabel("Narration volume"),
                h.AriaValuetext(`${Math.round(volume * 100)}%`),
                h.Class(
                  "h-20 w-4 cursor-pointer accent-stone-900 [direction:rtl] [writing-mode:vertical-lr] dark:accent-stone-100",
                ),
                h.OnInput((value) => Message.UpdatedVolume({ value })),
              ]),
            ],
          ),
        ],
      ),
    ],
  );
};

/**
 * The speed it plays at, as one button that opens the other speeds above it. A click outside or
 * Escape closes them.
 */
const speedView = (model: Model, h: H): Html => {
  const open = model.speeds === "Open";

  return h.div(
    [
      h.Class("relative flex items-center"),
      ...(open ? [h.OnKeyDown((key) => Message.PressedKeyInSpeeds({ key }))] : []),
    ],
    [
      open
        ? h.button([
            h.Type("button"),
            h.Tabindex(-1),
            h.AriaHidden(true),
            h.Class("fixed inset-0 z-10 cursor-default"),
            h.OnClick(Message.DismissedSpeeds()),
          ])
        : h.empty,
      h.button(
        [
          h.Type("button"),
          h.AriaLabel(`Playback speed, ${model.speed}×`),
          h.Title("Playback speed"),
          h.AriaHasPopup("menu"),
          h.AriaExpanded(open),
          h.Class(
            "relative flex h-8 min-w-10 items-center justify-center rounded-md px-1.5 font-mono text-sm font-medium text-stone-700 tabular-nums hover:bg-stone-200 aria-expanded:bg-stone-200 dark:text-stone-200 dark:hover:bg-stone-800 dark:aria-expanded:bg-stone-800",
          ),
          h.OnClick(Message.ClickedSpeed()),
        ],
        [`${model.speed}×`],
      ),
      open
        ? h.div(
            [
              h.Role("menu"),
              h.AriaLabel("Playback speed"),
              h.Class(
                "absolute right-0 bottom-full z-20 mb-2 flex w-24 flex-col rounded-lg border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900",
              ),
            ],
            speeds.map((speed) =>
              h.button(
                [
                  h.Type("button"),
                  h.Role("menuitemradio"),
                  h.AriaChecked(model.speed === speed),
                  h.Class(
                    "flex items-center justify-between rounded-md px-2 py-1 text-left font-mono text-sm text-stone-700 tabular-nums hover:bg-stone-100 aria-checked:font-semibold aria-checked:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:aria-checked:text-white",
                  ),
                  h.OnClick(Message.SelectedSpeed({ speed })),
                ],
                [`${speed}×`, model.speed === speed ? icon(h, checkIcon, "size-3.5") : h.empty],
              ),
            ),
          )
        : h.empty,
    ],
  );
};

const controlsView = (model: Model, replay: Replay, derived: Derived, h: H): Html => {
  const { startsAt, durationMillis } = replay.video;
  const playing = model.playback === "Playing";
  const chapter = chapterAt(derived.chapters, model.now);

  return h.div(
    [
      h.Class(
        "flex flex-col gap-0.5 rounded-b-xl border border-t-0 border-stone-200 bg-white px-3 pt-1 pb-1.5 dark:border-stone-800 dark:bg-stone-900",
      ),
    ],
    [
      timelineView(model, replay, derived, h),
      h.div(
        [h.Class("flex items-center gap-2")],
        [
          controlButton(
            h,
            playing ? "Pause" : "Play",
            Option.none(),
            playing ? Message.ClickedPause() : Message.ClickedPlay(),
            [icon(h, playing ? pauseIcon : model.playback === "Ended" ? replayIcon : playIcon)],
          ),
          h.span(
            [h.Class("shrink-0 font-mono text-xs whitespace-nowrap text-stone-500 tabular-nums")],
            [
              `${clock(model.now - startsAt, durationMillis)} / ${clock(durationMillis, durationMillis)}`,
            ],
          ),
          chapter === undefined
            ? h.empty
            : h.span(
                [
                  h.Class(
                    "min-w-0 truncate border-l border-stone-200 pl-2 text-xs font-medium text-stone-700 dark:border-stone-700 dark:text-stone-300",
                  ),
                  h.Title(chapter.title),
                ],
                [chapter.title],
              ),
          h.div(
            [h.Class("ml-auto flex shrink-0 items-center")],
            [
              speedView(model, h),
              controlButton(
                h,
                "Captions",
                Option.some(model.captions === "Shown"),
                Message.ClickedCaptions(),
                ["CC"],
              ),
              replay.narration === undefined ? h.empty : soundView(model, h),
            ],
          ),
        ],
      ),
    ],
  );
};

// TRANSCRIPT

/** One line of a step, after the mark of its kind. */
const markedView = (
  kind: ActivityKind,
  h: H,
  attributes: ReadonlyArray<ReturnType<H["Title"]>>,
  text: string,
  tone: string,
) =>
  h.span(
    [h.Class(`flex items-start gap-1.5 text-xs ${tone}`), ...attributes],
    [h.span([h.Class(`pt-0.5 ${kinds[kind].mark}`)], [icon(h, kinds[kind].icon, "size-3")]), text],
  );

const callView = (call: CallWords, h: H): Html =>
  markedView(
    call.kind,
    h,
    call.technical === undefined ? [] : [h.Title(call.technical)],
    call.failed ? `${call.text}, ${call.why ?? "failed"}` : call.text,
    call.failed ? "text-red-700 dark:text-red-400" : "text-stone-500 dark:text-stone-400",
  );

const framesView = (model: Model, replay: Replay, moment: number, h: H): Html => {
  const recorded = replay.moments[moment];

  return recorded === undefined
    ? h.empty
    : h.div(
        [h.Class("mt-2 grid grid-cols-3 gap-1.5 pl-12")],
        recorded.frames.map((frame, order) =>
          h.button(
            [
              h.Type("button"),
              h.Class("text-left"),
              h.Title("Jump to this instant"),
              h.OnClick(Message.ClickedEntry({ at: frame.hostTime })),
            ],
            [
              h.img([
                h.Src(`${baseOf(model.id)}/${frame.file}`),
                h.Alt(`What was on screen, frame ${order + 1}`),
                h.Loading("lazy"),
                h.Class(
                  "aspect-video w-full rounded object-cover ring-1 ring-stone-200 dark:ring-stone-700",
                ),
              ]),
              h.span(
                [h.Class("font-mono text-[0.6875rem] text-stone-500")],
                [clock(frame.hostTime - replay.video.startsAt, replay.video.durationMillis)],
              ),
            ],
          ),
        ),
      );
};

const stamp = (replay: Replay, at: number, h: H) =>
  h.span(
    [h.Class("pt-0.5 font-mono text-[0.6875rem] text-stone-400 tabular-nums dark:text-stone-500")],
    [clock(at - replay.video.startsAt, replay.video.durationMillis)],
  );

const lineContent = (replay: Replay, entry: Extract<Entry, { _tag: "Line" }>, h: H) => [
  stamp(replay, entry.at, h),
  h.span([h.Class("text-[0.9375rem] leading-6 text-stone-900 dark:text-stone-100")], [entry.text]),
];

const stepsContent = (replay: Replay, entry: Extract<Entry, { _tag: "Steps" }>, h: H) => [
  stamp(replay, entry.at, h),
  h.span(
    [h.Class("flex gap-1.5")],
    [
      h.span(
        [h.Class("flex min-w-0 flex-col gap-0.5")],
        [
          Option.match(entry.thought, {
            onNone: () => h.empty,
            onSome: (millis) =>
              markedView(
                "think",
                h,
                [],
                `Thought for ${(millis / 1000).toFixed(1)}s`,
                "text-stone-500 dark:text-stone-400",
              ),
          }),
          entry.said === ""
            ? h.empty
            : h.span(
                [h.Class("text-sm leading-5 text-stone-600 dark:text-stone-400")],
                [entry.said],
              ),
          ...entry.calls.map((call) => callView(call, h)),
          Option.match(entry.rejected, {
            onNone: () => h.empty,
            onSome: (rejected) =>
              callView({ kind: "act", text: rejected, failed: true, why: "rejected" }, h),
          }),
          entry.last > entry.first
            ? h.span(
                [h.Class("text-xs text-stone-500")],
                [`The same, ${entry.last - entry.first + 1} times`],
              )
            : h.empty,
        ],
      ),
    ],
  ),
];

const entryView = (
  model: Model,
  replay: Replay,
  entry: Entry,
  maybeChapter: Option.Option<Chapter>,
  state: "past" | "current" | "upcoming",
  h: H,
): Html => {
  const seek = h.button(
    [
      h.Type("button"),
      h.Class(
        `grid w-full grid-cols-[2.75rem_minmax(0,1fr)] gap-x-1 rounded-lg px-2 py-1.5 text-left transition hover:bg-stone-100 dark:hover:bg-stone-800/60 ${
          state === "current"
            ? "bg-amber-50 ring-1 ring-amber-300 hover:bg-amber-50 dark:bg-amber-950/40 dark:ring-amber-800"
            : state === "upcoming"
              ? "opacity-60"
              : ""
        }`,
      ),
      h.OnClick(Message.ClickedEntry({ at: entry.at })),
    ],
    entry._tag === "Line" ? lineContent(replay, entry, h) : stepsContent(replay, entry, h),
  );

  const frames =
    entry._tag === "Line" && entry.moment >= 0
      ? [
          h.button(
            [
              h.Type("button"),
              h.Class(
                "ml-14 self-start text-xs text-stone-500 underline-offset-2 hover:text-stone-800 hover:underline dark:hover:text-stone-200",
              ),
              h.AriaExpanded(Option.contains(model.maybeOpenMoment, entry.moment)),
              h.OnClick(Message.ClickedFrames({ moment: entry.moment })),
            ],
            [
              Option.contains(model.maybeOpenMoment, entry.moment)
                ? "Hide what was on screen"
                : "What was on screen",
            ],
          ),
          Option.contains(model.maybeOpenMoment, entry.moment)
            ? framesView(model, replay, entry.moment, h)
            : h.empty,
        ]
      : [];

  return h.keyed("li")(
    `${entry._tag}-${entry.at}`,
    [h.Class("flex flex-col")],
    [
      Option.match(maybeChapter, {
        onNone: () => h.empty,
        onSome: (chapter) =>
          h.p(
            [
              h.Class(
                "mt-3 mb-1 truncate px-2 text-sm font-semibold text-stone-900 first:mt-0 dark:text-stone-100",
              ),
              h.Title(chapter.title),
            ],
            [chapter.title],
          ),
      }),
      seek,
      ...frames,
    ],
  );
};

const transcript = createLazy();

/**
 * The spoken lines and the agent's steps in time order, each opening a chapter under the
 * chapter's name, with the entry playing now marked and kept in view.
 */
const transcriptView = (
  model: Model,
  replay: Replay,
  derived: Derived,
  current: number,
  h: H,
): Html =>
  h.section(
    [
      h.AriaLabel("Transcript"),
      h.Class(
        "flex max-h-[26rem] min-h-0 flex-col rounded-xl border border-stone-200 bg-white @4xl:absolute @4xl:inset-0 @4xl:max-h-none dark:border-stone-800 dark:bg-stone-900",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "flex items-baseline justify-between gap-2 border-b border-stone-200 px-4 py-2.5 dark:border-stone-800",
          ),
        ],
        [
          h.h3([h.Class("text-sm font-semibold")], ["Transcript"]),
          h.span([h.Class("text-xs text-stone-500")], ["Select a line to jump there"]),
        ],
      ),
      h.ol(
        [
          h.Id(feedIdOf(model.id)),
          h.Class(
            "relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-2",
          ),
        ],
        derived.entries.map((entry, index) => {
          const chapter = chapterAt(derived.chapters, entry.at);
          const previous = derived.entries[index - 1];

          const opens =
            chapter !== undefined &&
            (previous === undefined || chapterAt(derived.chapters, previous.at) !== chapter);

          return entryView(
            model,
            replay,
            entry,
            opens ? Option.some(chapter) : Option.none(),
            index === current ? "current" : index > current ? "upcoming" : "past",
            h,
          );
        }),
      ),
    ],
  );

// FINDINGS

const headline = new Set(["title", "question", "name"]);
const odds = new Set(["outcome", "chance", "probability"]);

/** What the check said of one reported item, from the outcome's detail, and whether it held. */
const checkOf = (detail: string, title: string, outcome: string) => {
  const label = `${title} (${outcome}): `;
  const at = detail.indexOf(label);

  if (at < 0) return undefined;
  const rest = detail.slice(at + label.length);
  const end = rest.search(/; |\.$/);
  const said = end < 0 ? rest : rest.slice(0, end);
  const quoted = /reported ([\d.]+)%, (.+?) ([\d.]+)%$/.exec(said);
  const tolerance = Number(/within ([\d.]+) points/.exec(detail)?.[1] ?? Number.NaN);

  return quoted === null
    ? { held: false, text: said }
    : {
        held: Math.abs(Number(quoted[1]) - Number(quoted[3])) <= tolerance,
        text: `${quoted[2]} said ${quoted[3]}%`,
      };
};

/** One reported item, such as a market: its name, its odds, why, how it checked out and where. */
const findingView = (replay: Replay, derived: Derived, item: ReadonlyArray<Field>, h: H): Html => {
  const named = item.find((field) => headline.has(field.key));
  const quoted = item.filter((field) => odds.has(field.key));
  const rest = item.filter((field) => !headline.has(field.key) && !odds.has(field.key));
  const outcome = item.find((field) => field.key === "outcome");

  const check =
    named === undefined || outcome === undefined
      ? undefined
      : checkOf(replay.outcome.detail, named.value, outcome.value);

  const found =
    named === undefined
      ? undefined
      : derived.chapters.find((chapter) => chapter.title === named.value);

  return h.li(
    [
      h.Class(
        "flex flex-col gap-2 rounded-xl bg-white p-4 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800",
      ),
    ],
    [
      named === undefined
        ? h.empty
        : h.p(
            [
              h.Class(
                "text-[0.9375rem] leading-snug font-semibold text-stone-900 dark:text-stone-100",
              ),
            ],
            [named.value],
          ),
      quoted.length === 0
        ? h.empty
        : h.p(
            [h.Class("flex flex-wrap items-baseline gap-x-2")],
            quoted.map((field) =>
              h.span(
                [
                  h.Class(
                    field.key === "outcome"
                      ? "text-sm text-stone-600 dark:text-stone-400"
                      : "text-2xl font-semibold text-stone-900 tabular-nums dark:text-stone-100",
                  ),
                  h.Title(field.label),
                ],
                [field.value],
              ),
            ),
          ),
      ...rest.map((field) =>
        h.p(
          [h.Class("text-sm text-stone-600 dark:text-stone-400")],
          [field.key === "why" ? field.value : `${field.label}: ${field.value}`],
        ),
      ),
      h.div(
        [
          h.Class(
            "mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-2 dark:border-stone-800",
          ),
        ],
        [
          check === undefined
            ? h.span([], [])
            : h.span(
                [
                  h.Class(
                    `flex items-center gap-1 text-xs ${check.held ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`,
                  ),
                ],
                [icon(h, check.held ? checkIcon : crossIcon, "size-3.5"), check.text],
              ),
          found === undefined
            ? h.empty
            : h.button(
                [
                  h.Type("button"),
                  h.Class(
                    "flex items-center gap-1 text-xs font-medium text-stone-700 hover:text-stone-950 dark:text-stone-300 dark:hover:text-white",
                  ),
                  h.OnClick(Message.ClickedEntry({ at: found.at })),
                ],
                [
                  icon(h, playIcon, "size-3.5"),
                  `Watch it at ${clock(found.at - replay.video.startsAt, replay.video.durationMillis)}`,
                ],
              ),
        ],
      ),
    ],
  );
};

const fieldList = (list: ReadonlyArray<Field>, h: H): Html =>
  h.dl(
    [h.Class("grid gap-2")],
    list.map((item) =>
      h.div(
        [],
        [
          h.dt([h.Class("text-xs text-stone-500")], [item.label]),
          h.dd(
            [h.Class("text-sm font-medium break-words text-stone-900 dark:text-stone-100")],
            [item.value],
          ),
        ],
      ),
    ),
  );

/** The check's verdict: the first sentence of its detail when it gave one. */
const verdictOf = (detail: string) => {
  const end = detail.indexOf(". ");

  return end < 0 ? detail : detail.slice(0, end + 1);
};

const findingsView = (replay: Replay, derived: Derived, h: H): Html => {
  const { outcome, run } = replay;
  const reported = fields(outcome.answer);
  const graded = outcome.status === "graded" && outcome.pass !== null;

  return h.section(
    [h.Class("flex flex-col gap-3")],
    [
      h.h3(
        [h.Class("text-lg font-semibold tracking-tight")],
        [run.model === null ? "What the script reported" : "What the agent found"],
      ),
      graded && outcome.detail !== ""
        ? h.p(
            [
              h.Class(
                `flex items-start gap-1.5 text-sm ${outcome.pass === true ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300"}`,
              ),
            ],
            [
              h.span(
                [h.Class("pt-0.5")],
                [icon(h, outcome.pass === true ? checkIcon : crossIcon, "size-4")],
              ),
              verdictOf(outcome.detail),
            ],
          )
        : h.empty,
      reported.length === 0
        ? h.p(
            [h.Class("text-sm text-stone-600 dark:text-stone-400")],
            [`Nothing: the run ended ${outcome.reason.replaceAll("-", " ")}.`],
          )
        : Option.match(items(outcome.answer), {
            onNone: () => fieldList(reported, h),
            onSome: (list) =>
              h.ol(
                [h.Class("grid gap-3 @2xl:grid-cols-3")],
                list.map((item) => findingView(replay, derived, item, h)),
              ),
          }),
    ],
  );
};

// ABOUT

const aboutView = (model: Model, replay: Replay, h: H): Html => {
  const { outcome, run } = replay;

  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Length", duration(replay.video.durationMillis)],
    ...(run.model === null
      ? ([["Driven by", "a script, no model"]] as const)
      : ([
          ["Agent steps", String(replay.steps.length)],
          ["Model calls", `${outcome.calls}, for ${cost(outcome.knownUsd)}`],
          ["Model", run.model],
        ] as const)),
    ...(replay.narration === undefined ? [] : ([["Voice", replay.narration.voice]] as const)),
    [
      "Browser",
      run.humanize ? `${run.browser}, with input performed at a person's pace` : run.browser,
    ],
  ];

  return h.details(
    [h.Class("group rounded-xl border border-stone-200 dark:border-stone-800")],
    [
      h.summary(
        [h.Class("cursor-pointer px-4 py-3 text-sm font-semibold")],
        [
          run.model === null
            ? "What the script was given, and how it ran"
            : "What the agent was asked, and how it ran",
        ],
      ),
      h.div(
        [h.Class("flex flex-col gap-4 border-t border-stone-200 px-4 py-4 dark:border-stone-800")],
        [
          h.blockquote(
            [
              h.Class(
                "border-l-2 border-amber-500 pl-3 text-sm leading-6 text-stone-700 dark:text-stone-300",
              ),
            ],
            [replay.task.prompt],
          ),
          h.dl(
            [h.Class("grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm")],
            facts.flatMap(([term, value]) => [
              h.dt([h.Class("text-stone-500")], [term]),
              h.dd([h.Class("text-stone-900 dark:text-stone-100")], [value]),
            ]),
          ),
          h.p(
            [h.Class("text-sm text-stone-600 dark:text-stone-400")],
            [
              "The whole recording is in ",
              h.a(
                [h.Href(`${baseOf(model.id)}/replay.json`), h.Class("font-medium underline")],
                ["replay.json"],
              ),
              ".",
            ],
          ),
        ],
      ),
    ],
  );
};

// VIEW

const readyView = (model: Model, replay: Replay, derived: Derived, h: H): Html =>
  h.div(
    [h.Class("not-prose @container")],
    [
      h.div(
        [h.Class("flex flex-col gap-8")],
        [
          h.div(
            [h.Class("grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_22rem]")],
            [
              h.div(
                [h.Class("min-w-0 shadow-xl shadow-stone-900/10 dark:shadow-black/40")],
                [screenView(model, replay, derived, h), controlsView(model, replay, derived, h)],
              ),
              h.div(
                [h.Class("relative min-w-0")],
                [
                  transcript(transcriptView, [
                    model,
                    replay,
                    derived,
                    currentEntry(derived.entries, model.now),
                    h,
                  ]),
                ],
              ),
            ],
          ),
          findingsView(replay, derived, h),
          aboutView(model, replay, h),
        ],
      ),
    ],
  );

const placeholder = (h: H, content: ReadonlyArray<Html | string>) =>
  h.div(
    [
      h.Class(
        "not-prose flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-100 p-6 text-center text-sm text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400",
      ),
    ],
    content,
  );

export const view = defineView<Model, Message>((model, h) =>
  Load.match(model.load, {
    Loading: () => placeholder(h, ["Loading the recording…"]),
    Missing: ({ reason }) =>
      placeholder(h, [
        h.strong([h.Class("text-stone-900 dark:text-stone-100")], ["No recording here yet"]),
        h.span([], [`${reason}. Record one on your own machine: `]),
        h.a([h.Href("/try"), h.Class("font-medium underline")], ["run the demo yourself"]),
      ]),
    Ready: ({ replay, derived }) => readyView(model, replay, derived, h),
  }),
);
