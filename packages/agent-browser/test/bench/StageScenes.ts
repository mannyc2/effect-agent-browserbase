import { Effect, Schema } from "effect";
import type * as Bootstrap from "effect-browser/bootstrap";
import type * as Browser from "effect-browser/browser";
import * as PageControl from "effect-browser/page-control";
import * as Plan from "effect-browser/plan";

import { hostedUrl, injectedSite, publicOrigin } from "../fixtures/InjectedSite.ts";
import { stageContent, stageSite, type TruthEvent } from "../fixtures/StageSite.ts";
import { filming } from "./Backends.ts";
import * as Picture from "./Picture.ts";
import { BenchError, type Journal, json } from "./Records.ts";

export const stageScenes = ["smoke", "animation", "busy", "typing", "interstitials"] as const;
export const busyVariants = ["created-after", "created-before", "resume-after"] as const;
export type BusyVariant = (typeof busyVariants)[number];
export type Style = "plain" | "performed";

export interface Stage {
  readonly url: (route: string) => string;
  readonly events: () => ReadonlyArray<TruthEvent>;
  readonly lost: () => number;
  readonly bootstrap?: Bootstrap.Plan<never, never>;
}

/** Hosted fixtures use the same markup and host binding, without a separately deployed server. */
export const prepareStage = Effect.fn("Bench.stage.prepare")(function* (
  journal: Journal,
  hostedOrigin = publicOrigin,
) {
  if (journal.manifest.backend === "chromium") {
    const site = yield* stageSite;
    const offset = journal.elapsedMillis() - site.elapsedMillis();

    return {
      url: (route: string) =>
        `${site.url}${route}${route === "/slow" ? `?delay=${700 + journal.manifest.seed * 100}` : ""}`,
      events: () => site.events().map((event) => ({ ...event, at: event.at + offset })),
      lost: site.lost,
    } satisfies Stage;
  }
  const events: TruthEvent[] = [];
  let lost = 0;
  const Payload = Schema.Struct({ route: Schema.String, data: Schema.Json });

  const documents = Object.fromEntries(
    [
      "/smoke",
      "/animation",
      "/heavy",
      "/typing",
      "/cookies",
      "/newsletter",
      "/age",
      "/slow",
      "/blocked",
    ].map((route) => [route, stageContent(route, 700 + journal.manifest.seed * 100)]),
  );

  return {
    url: (route: string) => hostedUrl(hostedOrigin, route),
    events: () => [...events],
    lost: () => lost,
    bootstrap: injectedSite({
      origins: [hostedOrigin],
      markup: "<main></main>",
      script: `const pages=${JSON.stringify(documents)};const route=new URL(location.href).searchParams.get('scene')||'/smoke';const fixture=pages[route];if(!fixture)throw new Error('Unknown fixture route');document.body.innerHTML=fixture.markup;const report=data=>{void globalThis.recordBenchTruth({route,data});};(new Function('report',fixture.script))(report);`,
      record: (value) => {
        const decoded = Schema.decodeUnknownExit(Payload)(value);

        if (decoded._tag === "Success" && events.length < 20000)
          events.push({
            kind: "page",
            route: decoded.value.route,
            at: journal.elapsedMillis(),
            data: decoded.value.data,
          });
        else lost++;
      },
    }),
  } satisfies Stage;
});

const shown = Schema.Struct({ kind: Schema.String, shown: Schema.Boolean });

const key = Schema.Struct({
  kind: Schema.String,
  key: Schema.String,
  value: Schema.String,
  pageAt: Schema.Finite,
});

const Boundaries = Schema.Struct({ documentBoundaries: Schema.Array(Picture.Boundary) });

const Animation = Schema.Struct({
  kind: Schema.Literal("animation"),
  ticks: Schema.Natural,
  changing: Schema.Boolean,
  visibility: Schema.Literals(["visible", "hidden"]),
});

const Visibility = Schema.Struct({
  kind: Schema.Literal("visibility"),
  visibility: Schema.Literals(["visible", "hidden"]),
});

export const activityReports = (events: ReadonlyArray<TruthEvent>): Picture.ActivityReport[] =>
  events.flatMap<Picture.ActivityReport>((event) => {
    if (event.route !== "/animation" && event.route !== "/smoke") return [];
    const animation = Schema.decodeUnknownExit(Animation)(event.data);

    if (animation._tag === "Success")
      return [
        {
          at: event.at,
          kind: "animation" as const,
          visibility: animation.value.visibility,
          ticks: animation.value.ticks,
        },
      ];
    const visibility = Schema.decodeUnknownExit(Visibility)(event.data);

    return visibility._tag === "Success"
      ? [
          {
            at: event.at,
            kind: "visibility" as const,
            visibility: visibility.value.visibility,
            ticks: null,
          },
        ]
      : [];
  });

export const pictureMetrics = (
  journal: Journal,
  changing: ReadonlyArray<Picture.Interval> = [],
  windows: Readonly<Record<string, Picture.Interval>> = {},
  options: {
    readonly program?: Picture.Interval;
    readonly reports?: ReadonlyArray<TruthEvent>;
    readonly lostReports?: number;
  } = {},
) => {
  const recording = journal.recording;
  const frames = recording?.frames ?? [];

  const programWindow = options.program ?? {
    start: recording?.startedAt ?? 0,
    end: recording?.endedAt ?? 0,
  };

  const cutoff = Picture.recordingCutoff(recording, programWindow);

  const measured = Picture.measurement(programWindow, cutoff);
  const window = measured.window;
  const boundaries = Schema.decodeUnknownExit(Boundaries)(recording?.summary);
  const reports = activityReports(options.reports ?? []);
  const silence = Picture.freezes(frames, changing, window);

  return {
    ...Picture.cadence(frames, window),
    measurement: measured,
    freezes: silence,
    pageActivity: Picture.activity(reports, window, silence.intervals, options.lostReports),
    captureTeardownMillis: Math.max(
      0,
      (recording?.endedAt ?? 0) - (recording?.captureEndedAt ?? recording?.endedAt ?? 0),
    ),
    firstFrame: Picture.firstFrame(
      frames,
      boundaries._tag === "Success" ? boundaries.value.documentBoundaries : [],
    ),
    discarded: recording?.discardedFrames ?? 0,
    retentionLimit: recording?.limitReached ?? null,
    captureError: recording?.error ?? null,
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, interval]) => [
        name,
        (() => {
          const measured = Picture.measurement(interval, cutoff);

          return {
            cadence:
              measured.status === "unmeasured" ? null : Picture.cadence(frames, measured.window),
            freezes:
              measured.status === "unmeasured"
                ? null
                : Picture.freezes(frames, changing, measured.window),
            measurement: measured,
            pageActivity:
              measured.status === "unmeasured"
                ? null
                : Picture.activity(
                    reports,
                    measured.window,
                    Picture.freezes(frames, changing, measured.window).intervals,
                    options.lostReports,
                  ),
          };
        })(),
      ]),
    ),
  };
};

export const stageScene = Effect.fn("Bench.stage.scene")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: {
    readonly durationMillis: number;
    readonly variant?: BusyVariant;
    readonly style?: Style;
    readonly stage?: Stage;
  },
) {
  const scene = journal.manifest.scene;
  const site = options.stage ?? (yield* prepareStage(journal));

  if (site.bootstrap !== undefined && options.stage === undefined)
    return yield* new BenchError({
      operation: "stage",
      message: "Prepare the hosted fixture bootstrap before acquiring the owner.",
    });
  const variant = options.variant ?? "created-after";
  const style = options.style === "performed" ? { seed: journal.manifest.seed } : "plain";
  const operations: Array<{ operation: string; startedAt: number; endedAt: number }> = [];
  const windows: Record<string, Picture.Interval> = {};
  const changing: Picture.Interval[] = [];
  let page = browser.initialPage;
  let background: Browser.Page | undefined;
  let typing: Schema.Json = null;
  let workEndedAt = 0;

  const timed = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const startedAt = journal.elapsedMillis();
      const result = yield* effect;
      const timing = { operation, startedAt, endedAt: journal.elapsedMillis() };

      operations.push(timing);
      journal.append({ kind: "host", turn: null, value: timing });

      return result;
    });

  if (scene === "busy" && variant === "created-before") {
    background = yield* timed("create-background", browser.createPage());
    page = yield* timed("create-on-air", browser.createPage());
  }
  if (scene === "animation" || scene === "smoke" || scene === "busy")
    yield* page.navigate({ url: site.url("/animation") });

  yield* filming(
    journal,
    page,
    Effect.gen(function* () {
      const start = journal.elapsedMillis();

      if (scene === "animation" || scene === "smoke") {
        yield* Effect.sleep(options.durationMillis);
        changing.push({ start, end: journal.elapsedMillis() });
      } else if (scene === "busy") {
        const margin = Math.min(3000, Math.max(300, options.durationMillis / 3));

        yield* Effect.sleep(margin);
        const workStart = journal.elapsedMillis();

        windows.before = { start, end: workStart };
        background ??= yield* timed("create-background", browser.createPage());
        if (variant === "resume-after") {
          const receipt = yield* timed("suspend-on-air", PageControl.suspend(page));

          yield* timed("resume-on-air", PageControl.resume(page, receipt));
        }
        const worker = background;

        yield* timed("navigate-heavy", worker.navigate({ url: site.url("/heavy") }));
        yield* timed("observe-heavy", worker.observe({ scope: "document" }));
        yield* timed("checkpoint-heavy", worker.checkpoint({ picture: true }));

        const baseline = yield* timed(
          "record-plan",
          worker.run({
            version: 1,
            steps: [
              {
                id: "next",
                action: {
                  _tag: "Click",
                  target: { _tag: "Descriptor", descriptor: { kind: "button", label: "Next" } },
                },
              },
              {
                id: "search",
                action: {
                  _tag: "Fill",
                  target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Search" } },
                  value: { _tag: "Literal", value: "background reading" },
                },
              },
              {
                id: "finish",
                action: {
                  _tag: "Click",
                  target: { _tag: "Descriptor", descriptor: { kind: "button", label: "Finish" } },
                },
              },
            ],
          }),
        );

        const durable = yield* Plan.recorded(baseline);
        const replay = yield* Plan.decode(yield* Plan.encode(durable));

        const inputs = Object.fromEntries(
          Plan.inputSlots(replay).map((slot) => [slot.name, "background reading"]),
        );

        yield* timed("replay-plan", worker.run(replay, { style, inputs, within: 15000 }));
        const workEnd = journal.elapsedMillis();

        windows.during = { start: workStart, end: workEnd };
        yield* Effect.sleep(margin);
        windows.after = { start: workEnd, end: journal.elapsedMillis() };
        changing.push({ start, end: journal.elapsedMillis() });
      } else if (scene === "typing") {
        yield* page.navigate({ url: site.url("/typing") });
        const value = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567";
        const before = journal.elapsedMillis();

        yield* timed(
          "type",
          page.run(
            {
              version: 1,
              steps: [
                {
                  id: "type",
                  action: {
                    _tag: "Fill",
                    target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Search" } },
                    value: { _tag: "Literal", value },
                  },
                },
              ],
            },
            { style, within: 15000 },
          ),
        );
        const duration = journal.elapsedMillis() - before;

        const readKeys = () =>
          site.events().flatMap((event) => {
            const decoded = Schema.decodeUnknownExit(key)(event.data);

            return decoded._tag === "Success" ? [decoded.value] : [];
          });

        const confirmationStart = journal.elapsedMillis();
        let keys = readKeys();
        let input = keys.findLast((event) => event.kind === "input");

        while (input?.value !== value) {
          const remaining = 3000 - (journal.elapsedMillis() - confirmationStart);

          if (remaining <= 0) break;
          yield* Effect.sleep(Math.min(25, remaining));
          keys = readKeys();
          input = keys.findLast((event) => event.kind === "input");
        }

        const confirmation =
          input === undefined ? "missing" : input.value === value ? "confirmed" : "partial";

        const confirmationWaitMillis = journal.elapsedMillis() - confirmationStart;

        const down = new Map<string, number>();
        const holds: number[] = [];
        const intervals: number[] = [];
        let previous: number | undefined;

        for (const event of keys) {
          if (event.kind === "keydown") {
            down.set(event.key, event.pageAt);
            if (previous !== undefined) intervals.push(event.pageAt - previous);
            previous = event.pageAt;
          } else if (event.kind === "keyup") {
            const at = down.get(event.key);

            if (at !== undefined) holds.push(event.pageAt - at);
            down.delete(event.key);
          }
        }
        typing = json({
          characters: value.length,
          exactValue: confirmation === "confirmed",
          confirmation,
          confirmationWaitMillis,
          reportedCharacters: input?.value.length ?? null,
          inputEvents: keys.filter((event) => event.kind === "input").length,
          durationMillis: duration,
          charactersPerSecond: (value.length * 1000) / duration,
          within15Seconds: duration <= 15000,
          keyEvents: keys.length,
          holdMillis: holds.length === 0 ? null : Picture.quantiles(holds),
          intervalMillis: intervals.length === 0 ? null : Picture.quantiles(intervals),
        });
      } else if (scene === "interstitials") {
        for (const route of ["/cookies", "/newsletter", "/age", "/slow", "/blocked"]) {
          yield* timed(`navigate${route}`, page.navigate({ url: site.url(route) }));
          yield* Effect.sleep(route === "/slow" ? 1000 + journal.manifest.seed * 100 : 500);
          if (route === "/cookies" || route === "/newsletter" || route === "/age")
            yield* timed(`dismiss${route}`, page.click({ selector: "#dismiss" }));
          yield* Effect.sleep(200);
        }
      } else return yield* new BenchError({ operation: "scene", message: "Unknown stage scene." });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          workEndedAt = journal.elapsedMillis();
        }),
      ),
    ),
  );
  const recording = journal.recording;
  const window = { start: recording?.startedAt ?? 0, end: workEndedAt };

  const shownEvents = site.events().flatMap((event) => {
    const data = Schema.decodeUnknownExit(shown)(event.data);

    return data._tag === "Success"
      ? [{ at: event.at, kind: `${event.route}:${data.value.kind}`, shown: data.value.shown }]
      : [];
  });

  const overlays = Picture.shownIntervals(shownEvents, window);

  const pixels =
    scene === "interstitials" ? yield* Picture.lumaSpreads(recording?.frames ?? []) : [];

  const delivery = pictureMetrics(journal, changing, windows, {
    program: window,
    reports: site.events(),
    lostReports: site.lost(),
  });

  journal.truth = json({ events: site.events(), lost: site.lost() });
  journal.metrics = json({
    ...delivery,
    scene,
    variant,
    style: options.style ?? "plain",
    operations,
    typing,
    overlaySeconds: Object.fromEntries(
      overlays.map((interval) => [interval.kind, (interval.end - interval.start) / 1000]),
    ),
    blank:
      scene === "interstitials" && delivery.measurement.status !== "unmeasured"
        ? {
            ...Picture.blank(recording?.frames ?? [], pixels, delivery.measurement.window),
            measurement: delivery.measurement,
          }
        : null,
    fixtureBlankSeconds: overlays
      .filter((interval) => interval.kind.endsWith(":blank"))
      .reduce((total, interval) => total + (interval.end - interval.start) / 1000, 0),
  });
});
