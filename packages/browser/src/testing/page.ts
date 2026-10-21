/** A scoped, seeded Page for deterministic stories. Effects are explicit data, never page code. */
import { Clock, Deferred, Duration, Effect, Exit, Scope, Stream } from "effect";

import { type Action, nameOf, targetOf, recorded } from "../Action.ts";
import { checked, methods } from "../ActionPort.ts";
import { type BrowserError, Closed, NotActionable, undispatched } from "../BrowserError.ts";
import * as Events from "../BrowserEvent.ts";
import { monotonicMillis } from "../Clock.ts";
import type { Gate } from "../internal/input/gate.ts";
import * as Lane from "../internal/page/lane.ts";
import * as Timeline from "../internal/timeline/events.ts";
import { type Page, ResolvedTarget, State, Text, type UntilResult } from "../Page.ts";
import * as Url from "../Url.ts";
import * as Evidence from "./evidence.ts";
import * as Model from "./model.ts";

export type { Element, Seed } from "./model.ts";

const { unsupported } = Model;

const execution = (
  model: ReturnType<typeof Model.make>,
  lane: Lane.Lane,
  now: () => number,
  id: string,
  timeline: ReturnType<typeof Timeline.make>,
  gate?: Gate,
) => {
  const outcomes: Array<Effect.Effect<string | void, BrowserError>> = [];
  const actions: Array<Action> = [];

  const perform = (action: Action): Effect.Effect<ResolvedTarget | string | void, BrowserError> => {
    const operation = nameOf(action);

    return lane.write(
      operation,
      Duration.seconds(10),
    )(
      Effect.gen(function* () {
        yield* model.check(operation);
        const outcome = outcomes.shift();

        if (
          action._tag === "Act" ||
          ((action._tag === "Back" || action._tag === "Select") && outcome === undefined)
        )
          return yield* unsupported(operation);

        const target = targetOf(action);
        const resolved = target === undefined ? undefined : yield* model.resolve(target);

        if (
          resolved?.element.state?.disabled ||
          resolved?.element.visible === false ||
          (action._tag === "Type" &&
            resolved !== undefined &&
            (!resolved.element.editable || (action.options?.secret && !resolved.element.secret)))
        )
          return yield* undispatched(
            operation,
            new NotActionable({ detail: "the seeded element cannot take this input" }),
          );
        if (action._tag === "Drag") yield* model.resolve(action.to);
        const leave = gate === undefined ? () => {} : yield* gate.enter(operation);
        const startedAt = now();
        let dispatched = false;

        const safe = recorded(
          action,
          !(action._tag === "Type" && (action.options?.secret || resolved?.element.secret)),
        );

        const work = Effect.gen(function* () {
          actions.push(safe);
          dispatched = true;

          const value =
            outcome === undefined
              ? undefined
              : yield* outcome.pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      dispatched = error.dispatched;
                    }),
                  ),
                );

          if (action._tag === "Goto" || action._tag === "Reload") {
            model.update(
              {
                ...model.get(),
                url: action._tag === "Goto" ? Url.redact(action.url) : model.get().url,
              },
              true,
            );
            timeline.publish(
              new Events.Navigated({
                at: now(),
                page: id,
                url: model.get().url ?? "about:blank",
                document: model.document(),
                sameDocument: false,
              }),
            );
          }
          if (action._tag === "Click" && resolved !== undefined)
            return new ResolvedTarget({
              ...resolved.subject,
              element: resolved.ref,
              point:
                typeof target === "object"
                  ? target
                  : {
                      x: resolved.element.box.x + resolved.element.box.width / 2,
                      y: resolved.element.box.y + resolved.element.box.height / 2,
                    },
              cursor: "pointer",
              box: resolved.element.box,
            });

          return value;
        });

        return yield* work.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const failure = Exit.isFailure(exit) ? exit.cause : undefined;

              timeline.publish(
                new Events.Action({
                  at: now(),
                  startedAt,
                  page: id,
                  name: operation,
                  value: safe,
                  url: Url.redact(model.get().url ?? "about:blank"),
                  subject: resolved?.subject,
                  ok: Exit.isSuccess(exit),
                  dispatched,
                  error: failure === undefined ? undefined : "failed",
                }),
              );
              leave();
            }),
          ),
        );
      }),
    );
  };

  return {
    perform,
    succeedNext: (value?: string) =>
      Effect.sync(() => {
        outcomes.push(Effect.succeed(value));
      }),
    actions: Effect.sync(() => [...actions]),
    failNext: (error: BrowserError) =>
      Effect.sync(() => {
        outcomes.push(Effect.fail(error));
      }),
    holdNext: () =>
      Effect.sync(() => {
        const entered = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();

        outcomes.push(
          Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
        );

        return { entered: Deferred.await(entered), release: Deferred.succeed(release, undefined) };
      }),
  };
};

/** Wait admission follows preceding input, then releases the lane while observing new evidence. */
const untilFor =
  (model: ReturnType<typeof Model.make>, lane: Lane.Lane, now: () => number): Page["until"] =>
  (query, want, millis) =>
    lane
      .read("until")(Effect.void)
      .pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (query.selector !== undefined) return yield* unsupported("until:selector");
            if (!Number.isFinite(millis) || millis < 0) return yield* unsupported("until");
            const deadline = now() + millis;

            while (true) {
              yield* model.check("until");
              const found = model.find({ ...query, scope: query.scope ?? "document" });

              const mark = model.mark(found);

              const met =
                want === "some"
                  ? found.length > 0
                  : want === "none"
                    ? found.length === 0
                    : mark !== want.other;

              if (met || now() >= deadline) return { met, mark } satisfies UntilResult;
              yield* Effect.sleep(Duration.millis(Math.min(50, deadline - now())));
            }
          }),
        ),
      );

export const makeIn = Effect.fnUntraced(function* (
  seed: Model.Seed = {},
  options: {
    readonly id?: string;
    readonly connection?: string;
    readonly session?: string;
    readonly gate?: Gate;
    readonly closedBy?: () => Events.DisconnectCause | undefined;
    readonly timeline?: ReturnType<typeof Timeline.make>;
  } = {},
) {
  const clock = yield* Clock.Clock;
  const scope = yield* Scope.Scope;
  const now = () => monotonicMillis(clock);
  const id = options.id ?? "test-page";
  const connection = options.connection ?? "test-connection";
  const model = Model.make(seed, options.closedBy);
  const timeline = options.timeline ?? Timeline.make(4096);

  const lane = Lane.make({
    now,
    actionTimeout: Duration.seconds(10),
    documentAt: model.document,
    scope,
    gone: (operation) => undispatched(operation, new Closed({ cause: "page" })),
    beforeWrite: options.gate?.check,
    refusal: options.gate?.refused,
  });

  const evidence = yield* Evidence.make({
    id,
    connection,
    session: options.session ?? "test-browser",
    now,
    model,
  });

  const run = execution(model, lane, now, id, timeline, options.gate);

  const own = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Clock.Clock, clock);

  const read = <A>(operation: string, work: () => A) =>
    own(lane.read(operation)(Effect.andThen(model.check(operation), Effect.sync(work))));

  const perform: Page["perform"] = checked((action) => own(run.perform(action)));

  const page: Page = {
    ...methods(perform),
    id,
    clock,
    perform,
    until: (query, want, millis) => own(untilFor(model, lane, now)(query, want, millis)),
    afterInput: (effect) => own(lane.read("afterInput")(effect)),
    read: () => unsupported("read"),
    act: () => unsupported("act"),
    url: Effect.sync(() => Url.redact(model.get().url ?? "about:blank")),
    title: read("title", () => model.get().title ?? ""),
    bringToFront: Effect.void,
    close: Effect.andThen(
      Effect.sync(() => {
        if (model.close())
          timeline.publish(new Events.PageClosed({ at: now(), page: id, cause: "page" }));
      }),
      evidence.close,
    ),
    find: (query) =>
      query?.selector !== undefined
        ? unsupported("find:selector")
        : read("find", () => model.find(query)),
    snapshot: (options) =>
      options?.within !== undefined
        ? unsupported("snapshot:within")
        : read("snapshot", () => model.snapshot(options)),
    text: (options) =>
      options?.scope !== undefined && options.scope !== "viewport"
        ? unsupported("text:scope")
        : read("text", () => {
            const snapshot = model.snapshot({ maxChars: options?.maxChars });

            return new Text({
              url: snapshot.url,
              title: snapshot.title,
              text: snapshot.text,
              truncated: snapshot.truncated,
              at: now(),
            });
          }),
    viewport: read("viewport", () => model.get().viewport ?? { width: 800, height: 600 }),
    state: Effect.sync(
      () =>
        new State({
          page: id,
          connection,
          at: now(),
          document: model.document(),
          url: Url.redact(model.get().url ?? "about:blank"),
        }),
    ),
    screenshot: (options) =>
      options === undefined
        ? Effect.map(evidence.frame(), (frame) => frame.image)
        : unsupported("screenshot"),
    frame: evidence.frame,
    zoom: () => unsupported("zoom"),
    ready: () =>
      model.get().ready === true ? read("ready", () => undefined) : unsupported("ready"),
    capture: evidence.capture,
    screencast: (options) =>
      Stream.unwrap(Effect.map(evidence.capture(options), (capture) => capture.stream)),
    captureStats: () => unsupported("captureStats"),
    recentFrames: evidence.recentFrames,
    changes: evidence.changes,
    window: () => unsupported("window"),
    recentEvents: Effect.map(timeline.recent, (records) =>
      records
        .filter((record) => "page" in record.event && record.event.page === id)
        .map((record) => record.event),
    ),
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      model.close();
    }),
  );

  return {
    page,
    emitFrame: evidence.emitFrame,
    event: (event: Events.BrowserEvent) =>
      Effect.sync(() => {
        timeline.publish(event);
      }),
    succeedNext: run.succeedNext,
    isClosed: Effect.sync(model.isClosed),
    actions: run.actions,
    holdNext: run.holdNext,
    failNext: run.failNext,
    update: (seed: Model.Seed) => Effect.sync(() => model.update(seed)),
    document: (seed: Model.Seed) => Effect.sync(() => model.update(seed, true)),
  };
});
