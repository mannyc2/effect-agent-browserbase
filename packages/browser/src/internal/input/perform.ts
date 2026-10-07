/**
 * Performing one action: admission to the page and the browser-wide input lock, the input
 * guard's step, the input run that owns its replies, and the action's record.
 */
import { Deferred, Duration, Effect, Exit, Option, Ref } from "effect";

import { BrowserError, PolicyTimeout, Timeout } from "../../BrowserError.ts";
import { Action, type ActionOptions, Subject } from "../../BrowserEvent.ts";
import { type Point, redacted, type ResolvedTarget } from "../../Page.ts";
import type { PageContext } from "../page/context.ts";
import type * as BrowserClock from "../pictures/clock.ts";
import type { Dispatch } from "./dispatch.ts";
import type { Approval, PolicyPlan } from "./guard.ts";
import * as Replies from "./replies.ts";

export interface InputMarks {
  /** The action's own input, such as a press, key or wheel, has reached the page. */
  readonly sent: Effect.Effect<void>;
  /** Preparatory input, such as the pointer travelling to a target, has reached the page. */
  readonly touched: Effect.Effect<void>;
  readonly at: (point: Point) => Effect.Effect<void>;
  /** What the input acts on, and for a drag where it ends, as the page names them now. */
  readonly on: (subject: ResolvedTarget, to?: ResolvedTarget) => Effect.Effect<void>;
  /** The action's text is not bound for a secret field, so its record may keep it. */
  readonly reveal: Effect.Effect<void>;
  readonly input: Replies.Run;
}

const subjectOf = (target: ResolvedTarget) =>
  new Subject({ role: target.role, name: target.name, tag: target.tag, context: target.context });

/** What an action records of what it acted on: subjects, and a point target's box. */
const actedOn = (subject: ResolvedTarget, to?: ResolvedTarget) => ({
  subject: subjectOf(subject),
  box: subject.box,
  ...(to === undefined ? {} : { to: subjectOf(to) }),
});

/** A subject as span attributes under `prefix`, without a role it does not have. */
const subjectAttributes = (prefix: string, subject: Subject | undefined) =>
  subject === undefined
    ? {}
    : {
        ...(subject.role === null ? {} : { [`${prefix}.role`]: subject.role }),
        [`${prefix}.name`]: subject.name,
        [`${prefix}.tag`]: subject.tag,
      };

/** The options an action was asked, without a number it refuses as not finite. */
const recordable = (options: ActionOptions | undefined): ActionOptions | undefined => {
  const finite = (value: number | undefined) =>
    value === undefined || Number.isFinite(value) ? value : undefined;

  return options === undefined
    ? undefined
    : {
        ...options,
        clickCount: finite(options.clickCount),
        holdMillis: finite(options.holdMillis),
        times: finite(options.times),
        dx: finite(options.dx),
        dy: finite(options.dy),
      };
};

/** What an action's record keeps of its call. */
export interface Call {
  readonly target?: string | undefined;
  /** The rest of what the caller asked, recorded so a plan can ask it again. */
  readonly options?: ActionOptions | undefined;
  readonly text?: string | undefined;
  /** The text may be a secret: it is recorded only once the action reveals that it is not. */
  readonly secret?: boolean | undefined;
  /** False for navigation, which sends no input and leaves the browser-wide lock free. */
  readonly input?: boolean | undefined;
}

export const make = (
  page: PageContext,
  sender: Dispatch,
  calibrateClock: Effect.Effect<BrowserClock.Estimate, BrowserError>,
) => {
  const { id, settings, mapping, inputLock, lock, publish, now, noteInput, span, owned } = page;
  const { activity } = page;
  const { inputClocks, flush } = sender;
  const input = Replies.make();

  // Record the whole operation, but never keep the page locked or spend its action timeout
  // while a policy is waiting. Validation binds approval to the document and targets it saw.
  const perform = <A>(
    name: string,
    info: Call,
    timeout: Duration.Duration,
    prepare: Effect.Effect<PolicyPlan, BrowserError>,
    body: (marks: InputMarks, approval: Approval | undefined) => Effect.Effect<A, BrowserError>,
  ): Effect.Effect<A, BrowserError> =>
    Effect.gen(function* () {
      const startedAt = now();
      const sendsInput = info.input ?? true;
      const sent = yield* Ref.make(false);
      const at = yield* Ref.make(Option.none<Point>());
      const acted = yield* Ref.make<Pick<Action, "subject" | "to" | "box">>({});

      // The page may react to preparatory input, so no cached paint is current while the action
      // runs, but only the action's own input can have given it effect. `touched` covers both and
      // changes in one step with `changing`, so an interruption cannot unbalance the count.
      let touched = false;

      const touch = Effect.sync(() => {
        if (!touched) activity.changing += 1;
        touched = true;
        noteInput();
      });

      // A failure before the action checks its field, a denial included, records no text.
      let revealed = info.secret !== true;

      const marks = {
        sent: Ref.set(sent, true).pipe(Effect.andThen(touch)),
        touched: touch,
        at: (point: Point) => Ref.set(at, Option.some(point)),
        on: (subject: ResolvedTarget, to?: ResolvedTarget) => Ref.set(acted, actedOn(subject, to)),
        reveal: Effect.sync(() => {
          revealed = true;
        }),
      };

      const timedOut = (duration: Duration.Duration) =>
        Effect.fail(
          new BrowserError({
            operation: name,
            reason: new Timeout({ millis: Duration.toMillis(duration) }),
            dispatched: false,
          }),
        );

      const bounded = <Value>(
        effect: Effect.Effect<Value, BrowserError>,
        duration: Duration.Duration,
      ) => effect.pipe(Effect.timeoutOrElse({ duration, orElse: () => timedOut(duration) }));

      // Admission waits only on this page: its own unresolved replies and, before the browser's
      // first input, its clock mapping. It runs under the page lock but before the browser-wide
      // input lock, so a stalled page cannot delay input on other pages. The run re-checks the
      // replies under both locks.
      let estimate: BrowserClock.Estimate | undefined;

      const admit = input.idle.pipe(
        Effect.andThen(
          sendsInput
            ? mapping.current(calibrateClock).pipe(
                Effect.tap((current) =>
                  Effect.sync(() => {
                    estimate = current;
                  }),
                ),
                Effect.mapError(
                  (error) =>
                    new BrowserError({ operation: name, reason: error.reason, dispatched: false }),
                ),
              )
            : Effect.void,
        ),
      );

      const useInput = <Value>(action: (run: Replies.Run) => Effect.Effect<Value, BrowserError>) =>
        input.begin.pipe(
          // A capture can recalibrate while input is running. One run, including delayed cleanup
          // releases, keeps one mapping so epoch stamps cannot jump backwards during a stroke.
          Effect.tap((run) =>
            Effect.sync(() => {
              if (estimate !== undefined) inputClocks.set(run, estimate);
            }),
          ),
          Effect.flatMap((run) =>
            action(run).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  run.close.pipe(
                    Effect.andThen(flush(name, run).pipe(Effect.ignore)),
                    Effect.andThen(Effect.fail(error)),
                  ),
                onSuccess: (value) =>
                  run.close.pipe(Effect.andThen(flush(name, run)), Effect.as(value)),
              }),
              // The finalizer only submits missing releases. It cannot wait forever for a
              // disconnected peer; the page retains those replies and gates its next action.
              Effect.ensuring(run.close),
            ),
          ),
        );

      // How long admission and the locks kept the action waiting, once it held them.
      let queuedMillis: number | undefined;

      // Admission and lock waits end at the action's deadline, undispatched. Holding the locks
      // starts a full deadline of its own, so contention never truncates input under way.
      // Locks are always taken page first, then browser-wide, and the browser-wide one is never
      // held while waiting for anything on one page: its navigation, zoom, replies or clock.
      const dispatch = <Value>(action: Effect.Effect<Value, BrowserError>) =>
        Effect.gen(function* () {
          const held = yield* Deferred.make<void>();
          const asked = now();

          const acquired = Effect.sync(() => {
            queuedMillis = Math.round(now() - asked);
          }).pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(bounded(action, timeout)),
          );

          const deadline = Effect.sleep(timeout).pipe(
            Effect.andThen(Deferred.isDone(held)),
            Effect.flatMap((done) => (done ? Effect.never : timedOut(timeout))),
          );

          return yield* Effect.raceFirst(
            admit.pipe(
              Effect.andThen(sendsInput ? inputLock.withPermits(1)(acquired) : acquired),
              lock.withPermits(1),
            ),
            deadline,
          );
        });

      const guard = settings.guard;

      // Only an approval needs binding: without a guard, input goes straight to the page.
      const run =
        guard === undefined
          ? dispatch(useInput((run) => body({ ...marks, input: run }, undefined)))
          : Effect.gen(function* () {
              const plan = yield* bounded(
                lock.withPermits(1)(prepare),
                settings.actionTimeout,
              ).pipe(span("Page.prepare", {}, "Debug"));

              // A hold lasts as long as this span; a judge's model call is its child.
              yield* guard(plan.request).pipe(
                Effect.mapError(
                  (reason) => new BrowserError({ operation: name, reason, dispatched: false }),
                ),
                Effect.timeoutOrElse({
                  duration: settings.policyTimeout,
                  orElse: () =>
                    Effect.fail(
                      new BrowserError({
                        operation: name,
                        reason: new PolicyTimeout({
                          millis: Duration.toMillis(settings.policyTimeout),
                        }),
                        dispatched: false,
                      }),
                    ),
                }),
                span("Page.guard"),
              );

              return yield* dispatch(
                useInput((run) =>
                  plan.validate.pipe(
                    Effect.flatMap((approval) => body({ ...marks, input: run }, approval)),
                  ),
                ),
              );
            });

      // Record the outcome even when the caller interrupts: its input may already be in the page.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(run));
          const dispatched = yield* Ref.get(sent);
          const point = yield* Ref.get(at);
          const { subject, to, box } = yield* Ref.get(acted);

          if (touched) activity.changing -= 1;
          const failure = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();

          // What the Action records, less its text: only a revealed text's length.
          yield* Effect.annotateCurrentSpan({
            dispatched,
            ...(queuedMillis === undefined ? {} : { queuedMillis }),
            ...(info.text !== undefined && revealed ? { chars: info.text.length } : {}),
            ...subjectAttributes("subject", subject),
            ...subjectAttributes("to", to),
            ...Option.match(failure, {
              onNone: () => ({}),
              onSome: (error) => ({ "error.type": error.reason._tag }),
            }),
          });

          publish(
            new Action({
              at: now(),
              startedAt,
              page: id,
              name,
              target: info.target,
              options: recordable(info.options),
              subject,
              to,
              box,
              text:
                info.text === undefined ? undefined : revealed ? info.text.slice(0, 200) : redacted,
              x: Option.getOrUndefined(Option.map(point, (p) => p.x)),
              y: Option.getOrUndefined(Option.map(point, (p) => p.y)),
              ok: Exit.isSuccess(exit),
              dispatched,
              error: Option.match(failure, {
                onNone: () => (Exit.hasInterrupts(exit) ? "interrupted" : undefined),
                onSome: (error) => error.message,
              }),
            }),
          );
          if (Exit.isSuccess(exit)) return exit.value;
          if (dispatched)
            return yield* Exit.mapError(exit, (error) =>
              error.dispatched
                ? error
                : new BrowserError({
                    operation: error.operation,
                    reason: error.reason,
                    dispatched: true,
                  }),
            );

          return yield* exit;
        }),
      );
    }).pipe(span(`Page.${name}`, info.target === undefined ? {} : { target: info.target }), owned);

  return perform;
};

export type Perform = ReturnType<typeof make>;
