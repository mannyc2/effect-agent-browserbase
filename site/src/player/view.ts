// The player's view: the video with the recorded pointer and the narrator's captions over it, the
// controls and timeline under it, and beside them the run's story and what it reported.
import { Option } from "effect";
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { clock, cost, duration, type Field, fields } from "../present.ts";
import { pointerAt, recentMark, type Replay } from "../replay.ts";
import {
  type CallWords,
  currentEntry,
  type Derived,
  type Entry,
  lineAt,
  type Span,
  statusAt,
  viewportOf,
} from "./derive.ts";
import { Message, type Speed } from "./message.ts";
import { baseOf, feedIdOf, Load, type Model, videoIdOf, WatchVideo } from "./player.ts";

type H = HtmlBuilder<Message>;

const speeds: ReadonlyArray<Speed> = [1, 2, 4];

const icon = (h: H, path: string) =>
  h.svg(
    [h.ViewBox("0 0 24 24"), h.Class("size-5"), h.AriaHidden(true)],
    [h.path([h.Attribute("d", path), h.Fill("currentColor")])],
  );

const playIcon = "M8 5.5v13l11-6.5z";
const pauseIcon = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";
const replayIcon = "M12 5V2L7.5 6 12 10V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z";
const soundIcon = "M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z";

const mutedIcon =
  "M4 9v6h4l5 4V5L8 9H4zm15.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4z";

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

const statusView = (replay: Replay, derived: Derived, now: number, h: H): Html => {
  const status = statusAt(replay, derived.spans, now);

  return status === undefined
    ? h.empty
    : h.span(
        [
          h.Class(
            `pointer-events-none absolute top-3 left-3 rounded-full px-3 py-1 font-mono text-xs font-medium shadow-sm backdrop-blur ${
              status.tone === "fail"
                ? "bg-red-600/90 text-white"
                : status.tone === "wait"
                  ? "bg-black/60 text-white/90"
                  : "bg-white/90 text-stone-900"
            }`,
          ),
        ],
        [status.text],
      );
};

const captionView = (model: Model, derived: Derived, h: H): Html => {
  const line = lineAt(derived.entries, model.now);

  return model.captions === "Hidden" || line === undefined
    ? h.empty
    : h.p(
        [
          h.Class(
            "pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-6 text-center",
          ),
          h.AriaLive("off"),
          h.DataAttribute("testid", "caption"),
        ],
        [
          h.span(
            [
              h.Class(
                "max-w-[46rem] rounded-md bg-black/80 px-3 py-1.5 text-sm leading-snug text-white sm:text-base",
              ),
            ],
            [line.text],
          ),
        ],
      );
};

const screenView = (model: Model, replay: Replay, derived: Derived, h: H): Html => {
  const playing = model.playback === "Playing";
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
      statusView(replay, derived, model.now, h),
      captionView(model, derived, h),
      h.button(
        [
          h.Type("button"),
          h.Class(
            `absolute inset-0 flex items-center justify-center transition ${playing ? "opacity-0" : "bg-black/25"}`,
          ),
          h.AriaLabel(playing ? "Pause" : "Play"),
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
                [icon(h, model.playback === "Ended" ? replayIcon : playIcon)],
              ),
            ],
      ),
    ],
  );
};

// CONTROLS

const marks = createLazy();

const marksView = (replay: Replay, derived: Derived, h: H): Html => {
  const { startsAt, durationMillis } = replay.video;
  const fraction = (at: number) => Math.min(1, Math.max(0, (at - startsAt) / durationMillis));
  const left = (at: number) => `${fraction(at) * 100}%`;

  const width = (span: Pick<Span, "start" | "end">) =>
    `max(3px, ${(fraction(span.end) - fraction(span.start)) * 100}%)`;

  return h.div(
    [h.Class("pointer-events-none absolute inset-x-0 top-1/2 h-3 -translate-y-1/2")],
    [
      ...derived.spans.map((span) =>
        h.span([
          h.Class(`absolute top-0 h-3 rounded-sm ${span.ok ? "bg-amber-500/80" : "bg-red-500/90"}`),
          h.Style({ left: left(span.start), width: width(span) }),
        ]),
      ),
      ...derived.entries.map((entry) =>
        entry._tag === "Line"
          ? h.span([
              h.Class("absolute -top-1.5 h-1.5 rounded-full bg-rose-500/70"),
              h.Style({ left: left(entry.at), width: width({ start: entry.at, end: entry.end }) }),
            ])
          : h.span([
              h.Class(
                `absolute top-4 size-1.5 -translate-x-1/2 rounded-full ${
                  entry.calls.some((call) => call.failed) ? "bg-red-500" : "bg-stone-500"
                }`,
              ),
              h.Style({ left: left(entry.at) }),
            ]),
      ),
    ],
  );
};

const timelineView = (model: Model, replay: Replay, derived: Derived, h: H): Html => {
  const { startsAt, durationMillis } = replay.video;
  const offset = Math.min(durationMillis, Math.max(0, model.now - startsAt));

  return h.div(
    [h.Class("relative order-last h-8 basis-full sm:order-none sm:basis-0 sm:flex-1")],
    [
      h.div([
        h.Class(
          "absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-stone-300 dark:bg-stone-700",
        ),
      ]),
      h.div([
        h.Class(
          "absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-stone-900 dark:bg-stone-100",
        ),
        h.Style({ width: `${(offset / durationMillis) * 100}%` }),
      ]),
      marks(marksView, [replay, derived, h]),
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

const controlsView = (model: Model, replay: Replay, derived: Derived, h: H): Html => {
  const { startsAt, durationMillis } = replay.video;
  const playing = model.playback === "Playing";

  return h.div(
    [
      h.Class(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-b-xl border border-t-0 border-stone-200 bg-white px-2 py-1.5 dark:border-stone-800 dark:bg-stone-900",
      ),
    ],
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
      timelineView(model, replay, derived, h),
      h.div(
        [h.Class("ml-auto flex items-center")],
        [
          ...speeds.map((speed) =>
            controlButton(
              h,
              `Play at ${speed}× speed`,
              Option.some(model.speed === speed),
              Message.SelectedSpeed({ speed }),
              [`${speed}×`],
            ),
          ),
          controlButton(
            h,
            "Captions",
            Option.some(model.captions === "Shown"),
            Message.ClickedCaptions(),
            ["CC"],
          ),
          replay.narration === undefined
            ? h.empty
            : controlButton(
                h,
                model.sound === "On" ? "Mute the narration" : "Unmute the narration",
                Option.none(),
                Message.ClickedSound(),
                [icon(h, model.sound === "On" ? soundIcon : mutedIcon)],
              ),
        ],
      ),
    ],
  );
};

// FEED

const callView = (call: CallWords, h: H): Html =>
  h.span(
    [
      h.Class(
        `block rounded-md px-2 py-1 text-[0.8125rem] ${
          call.failed
            ? "bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200"
            : "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300"
        }`,
      ),
      ...(call.technical === undefined ? [] : [h.Title(call.technical)]),
    ],
    [
      call.failed ? `✗ ${call.text}, ${call.why ?? "failed"}` : call.text,
      call.answer === undefined
        ? h.empty
        : h.span(
            [h.Class("mt-1 block text-stone-500 dark:text-stone-400")],
            [
              fields(call.answer)
                .map((field) => `${field.label}: ${field.value}`)
                .join(" · "),
            ],
          ),
    ],
  );

const framesView = (model: Model, replay: Replay, moment: number, h: H): Html => {
  const recorded = replay.moments[moment];

  return recorded === undefined
    ? h.empty
    : h.div(
        [h.Class("mt-2 grid grid-cols-3 gap-1.5")],
        recorded.frames.map((frame, order) =>
          h.button(
            [
              h.Type("button"),
              h.Class("group/frame text-left"),
              h.Title("Jump to this instant"),
              h.OnClick(Message.ClickedEntry({ at: frame.hostTime })),
            ],
            [
              h.img([
                h.Src(`${baseOf(model.id)}/${frame.file}`),
                h.Alt(`What the narrator saw, frame ${order + 1}`),
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

const entryView = (
  model: Model,
  replay: Replay,
  entry: Entry,
  state: "past" | "current" | "upcoming",
  h: H,
): Html => {
  const tone =
    state === "current"
      ? "bg-amber-50 ring-1 ring-amber-300 dark:bg-amber-950/40 dark:ring-amber-800"
      : state === "upcoming"
        ? "opacity-55"
        : "";

  const seek = h.button(
    [
      h.Type("button"),
      h.Class("block w-full text-left"),
      h.OnClick(Message.ClickedEntry({ at: entry.at })),
    ],
    entry._tag === "Line"
      ? [
          h.span(
            [
              h.Class(
                "flex items-center gap-1.5 text-[0.6875rem] font-semibold tracking-wide text-rose-600 uppercase dark:text-rose-400",
              ),
            ],
            [h.span([h.Class("size-1.5 rounded-full bg-rose-500")]), "Narrator"],
          ),
          h.span(
            [h.Class("mt-0.5 block text-sm text-stone-800 dark:text-stone-200")],
            [entry.text],
          ),
        ]
      : [
          h.span(
            [h.Class("text-[0.6875rem] font-semibold tracking-wide text-stone-500 uppercase")],
            [
              entry.first === entry.last
                ? `Step ${entry.first}`
                : `Steps ${entry.first}–${entry.last} · ${entry.last - entry.first + 1} times`,
            ],
          ),
          entry.said === ""
            ? h.empty
            : h.span(
                [h.Class("mt-0.5 block text-sm text-stone-800 dark:text-stone-200")],
                [entry.said],
              ),
          h.span(
            [h.Class("mt-1 flex flex-col gap-1")],
            [
              ...entry.calls.map((call) => callView(call, h)),
              Option.match(entry.rejected, {
                onNone: () => h.empty,
                onSome: (rejected) =>
                  callView({ text: rejected, failed: true, why: "rejected" }, h),
              }),
            ],
          ),
        ],
  );

  const frames =
    entry._tag === "Line" && entry.moment >= 0
      ? [
          h.button(
            [
              h.Type("button"),
              h.Class("mt-1 text-xs font-medium text-stone-500 underline-offset-2 hover:underline"),
              h.AriaExpanded(Option.contains(model.maybeOpenMoment, entry.moment)),
              h.OnClick(Message.ClickedFrames({ moment: entry.moment })),
            ],
            [
              Option.contains(model.maybeOpenMoment, entry.moment)
                ? "Hide what it saw"
                : "What the narrator saw",
            ],
          ),
          Option.contains(model.maybeOpenMoment, entry.moment)
            ? framesView(model, replay, entry.moment, h)
            : h.empty,
        ]
      : [];

  return h.keyed("li")(
    `${entry._tag}-${entry.at}`,
    [h.Class(`rounded-lg px-3 py-2 transition ${tone}`)],
    [seek, ...frames],
  );
};

const feed = createLazy();

const feedView = (
  model: Model,
  replay: Replay,
  entries: ReadonlyArray<Entry>,
  current: number,
  h: H,
): Html =>
  h.section(
    [h.Class("min-w-0")],
    [
      h.h3(
        [h.Class("mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase")],
        ["Step by step"],
      ),
      h.ol(
        [
          h.Id(feedIdOf(model.id)),
          h.Class(
            "relative flex max-h-[26rem] flex-col gap-1 overflow-y-auto overscroll-contain pr-1",
          ),
        ],
        entries.map((entry, index) =>
          entryView(
            model,
            replay,
            entry,
            index === current ? "current" : index > current ? "upcoming" : "past",
            h,
          ),
        ),
      ),
    ],
  );

// RESULT

const fieldList = (items: ReadonlyArray<Field>, h: H): Html =>
  h.dl(
    [h.Class("grid gap-2")],
    items.map((item) =>
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

const badge = (replay: Replay, h: H): Html => {
  const { outcome } = replay;
  const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold";

  return outcome.status !== "graded" || outcome.pass === null
    ? h.span(
        [h.Class(`${base} bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300`)],
        ["Not graded"],
      )
    : outcome.pass
      ? h.span(
          [
            h.Class(
              `${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300`,
            ),
          ],
          ["✓ Checked"],
        )
      : h.span(
          [h.Class(`${base} bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300`)],
          ["✗ Did not check out"],
        );
};

const resultView = (replay: Replay, h: H): Html => {
  const { outcome, run } = replay;
  const reported = fields(outcome.answer);

  const stats = [
    duration(replay.video.durationMillis),
    run.model === null ? "scripted, no AI" : `${replay.steps.length} steps`,
    ...(run.model === null ? [] : [`${cost(outcome.knownUsd)} in model calls`]),
  ];

  return h.section(
    [h.Class("flex min-w-0 flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [badge(replay, h), h.span([h.Class("text-xs text-stone-500")], [stats.join(" · ")])],
      ),
      h.div(
        [],
        [
          h.h3(
            [h.Class("mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase")],
            [run.model === null ? "The script reported" : "The agent reported"],
          ),
          reported.length === 0
            ? h.p(
                [h.Class("text-sm text-stone-600 dark:text-stone-400")],
                [`Nothing: the run ended ${outcome.reason.replaceAll("-", " ")}.`],
              )
            : fieldList(reported, h),
        ],
      ),
      h.details(
        [h.Class("group text-sm")],
        [
          h.summary(
            [
              h.Class(
                "cursor-pointer text-xs font-semibold tracking-wide text-stone-500 uppercase hover:text-stone-800 dark:hover:text-stone-200",
              ),
            ],
            [run.model === null ? "What the script was given" : "What the agent was asked"],
          ),
          h.p([h.Class("mt-2 text-stone-700 dark:text-stone-300")], [replay.task.prompt]),
        ],
      ),
      outcome.detail === "" || reported.length === 0
        ? h.empty
        : h.p(
            [
              h.Class(
                "rounded-lg bg-stone-100 px-3 py-2 text-[0.8125rem] text-stone-700 dark:bg-stone-800/70 dark:text-stone-300",
              ),
            ],
            [h.strong([], ["How it was checked: "]), outcome.detail],
          ),
      h.p(
        [h.Class("text-xs text-stone-500")],
        [
          [
            run.model === null ? "Driven by a script" : `Agent and narrator: ${run.model}`,
            replay.narration === undefined ? undefined : `voice: ${replay.narration.voice}`,
            `browser: ${run.browser}`,
            run.humanize ? "performed input" : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(" · "),
        ],
      ),
    ],
  );
};

// VIEW

const readyView = (model: Model, replay: Replay, derived: Derived, h: H): Html =>
  h.div(
    [h.Class("not-prose flex flex-col gap-5")],
    [
      h.div(
        [h.Class("shadow-xl shadow-stone-900/10 dark:shadow-black/40")],
        [screenView(model, replay, derived, h), controlsView(model, replay, derived, h)],
      ),
      h.div(
        [h.Class("grid gap-6 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]")],
        [
          feed(feedView, [
            model,
            replay,
            derived.entries,
            currentEntry(derived.entries, model.now),
            h,
          ]),
          resultView(replay, h),
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
