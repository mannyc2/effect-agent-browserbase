/**
 * Performing one action: its turn on the page, the input guard's step, the input run that owns its
 * replies, and the action's record. Its deadline leaves out the time its style takes to show it.
 */
import { Duration, Effect, Exit, Option, Ref } from "effect";

import { BrowserError, PolicyTimeout, Timeout } from "../../BrowserError.ts";
import { Action, type ActionOptions, Subject } from "../../BrowserEvent.ts";
import { type Point, redacted, type ResolvedTarget } from "../../Page.ts";
import { failWith, type PageContext, undispatched } from "../page/context.ts";
import { Correlation } from "../page/lane.ts";
import type * as BrowserClock from "../pictures/clock.ts";
import type { Dispatch } from "./dispatch.ts";
import type { Approval, PolicyPlan } from "./guard.ts";
import * as Replies from "./replies.ts";
import { plain, type Style } from "./style.ts";

export interface InputMarks {
  /** How the action's input is sent: plainly, or performed for viewers. */
  readonly style: Style;
  /**
   * Time the style spends showing the input, such as a glide or typing at a person's pace, planned
   * from now: the deadline moves back by as much, so presentation has a budget of its own.
   */
  readonly present: (millis: number) => Effect.Effect<void>;
  /** The action's own input, such as a press, key or wheel, has reached the page. */
  readonly sent: Effect.Effect<void>;
  /** Preparatory input, such as the pointer travelling to a target, has reached the page. */
  readonly touched: Effect.Effect<void>;
  readonly at: (point: Point) => Effect.Effect<void>;
  /** What the input acts on, and for a drag where it ends, as the page names them now. */
  readonly on: (subject: Named, to?: Named) => Effect.Effect<void>;
  /** The action's text is not bound for a secret field, so its record may keep it. */
  readonly reveal: Effect.Effect<void>;
  readonly input: Replies.Run;
}

/** What the page names a target: a resolved one, or the field that has focus. */
type Named = Pick<ResolvedTarget, "role" | "name" | "tag" | "context" | "box">;

const subjectOf = (target: Named) =>
  new Subject({ role: target.role, name: target.name, tag: target.tag, context: target.context });

/** What an action records of what it acted on: subjects, and a point target's box. */
const actedOn = (subject: Named, to?: Named) => ({
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

/** What an action's record keeps of its call. */
export interface Call {
  readonly target?: string | undefined;
  /** The rest of what the caller asked, recorded so a plan can ask it again. */
  readonly options?: ActionOptions | undefined;
  readonly text?: string | undefined;
  /** The text may be a secret: it is recorded only once the action reveals that it is not. */
  readonly secret?: boolean | undefined;
  /** False for navigation, which sends no input. */
  readonly input?: boolean | undefined;
  /** False for the pointer's travel ahead of an action, which is no action of its own. */
  readonly recorded?: boolean | undefined;
}

const timedOut = (operation: string, timeout: Duration.Duration) =>
  failWith(operation, new Timeout({ millis: Duration.toMillis(timeout) }));

/**
 * Fail `effect` with `Timeout` once `timeout` has passed, and as much later again as `presented`
 * says presentation has planned meanwhile.
 */
const deadline =
  (operation: string, timeout: Duration.Duration, now: () => number, presented: () => number) =>
  <A>(effect: Effect.Effect<A, BrowserError>) =>
    Effect.suspend(() => {
      const due = now() + Duration.toMillis(timeout);

      const expiry: Effect.Effect<never, BrowserError> = Effect.suspend(() => {
        const left = due + presented() - now();

        return left <= 0
          ? timedOut(operation, timeout)
          : Effect.sleep(Duration.millis(left)).pipe(Effect.andThen(expiry));
      });

      return Effect.raceFirst(effect, expiry);
    });

export const make = (page: PageContext, sender: Dispatch) => {
  const { id, settings, mapping, lane, publish, now, noteInput, span, owned } = page;
  const { inputClocks, flush } = sender;
  const input = Replies.make();

  // Record the whole operation, but never hold the page's turn or spend its action timeout while
  // a policy is waiting. Validation binds approval to the document and targets it saw.
  const perform = <A>(
    name: string,
    info: Call,
    timeout: Duration.Duration,
    prepare: Effect.Effect<PolicyPlan, BrowserError>,
    body: (marks: InputMarks, approval: Approval | undefined) => Effect.Effect<A, BrowserError>,
    style: Style = plain,
  ): Effect.Effect<A, BrowserError> =>
    Effect.gen(function* () {
      const startedAt = now();
      const sent = yield* Ref.make(false);
      const at = yield* Ref.make(Option.none<Point>());
      const acted = yield* Ref.make<Pick<Action, "subject" | "to" | "box">>({});

      // The page may react to preparatory input, as to script changes such as a selection, so
      // paint from before either is not current; only the action's own input can have given it
      // effect.
      const touch = Effect.sync(noteInput);

      // A failure before the action checks its field, a denial included, records no text.
      let revealed = info.secret !== true;
      // The time the style has planned to show the input, which the deadline leaves out.
      let presented = 0;

      const marks = {
        style,
        present: (millis: number) =>
          Effect.sync(() => {
            presented += Math.max(0, millis);
          }),
        sent: Ref.set(sent, true).pipe(Effect.andThen(touch)),
        touched: touch,
        at: (point: Point) => Ref.set(at, Option.some(point)),
        on: (subject: Named, to?: Named) => Ref.set(acted, actedOn(subject, to)),
        reveal: Effect.sync(() => {
          revealed = true;
        }),
      };

      // Admission waits only on this page's own unresolved replies, in its turn, so a stalled page
      // cannot delay input on other pages. Input never waits for the clock mapping: until a
      // capture has measured one, it keeps Chromium's own receipt time.
      let estimate: BrowserClock.Estimate | undefined;

      const admit = input.idle.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            estimate = (info.input ?? true) ? mapping.latest() : undefined;
          }),
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
              Effect.ensuring(run.close.pipe(Effect.andThen(page.openings.clear))),
            ),
          ),
        );

      // How long its turn and the page's replies kept the action waiting, once it had both.
      let queuedMillis: number | undefined;

      // The page's turn and its earlier input's replies are waited for within the action's
      // deadline, undispatched: a turn not given by then is `Busy`, and replies not answered by
      // then a `Timeout`. The turn starts a full deadline of its own, so a wait never truncates
      // input under way.
      const dispatch = <Value>(action: Effect.Effect<Value, BrowserError>) =>
        Effect.suspend(() => {
          const asked = now();

          return lane.write(
            name,
            timeout,
          )(
            Effect.suspend(() =>
              admit.pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(
                    Math.max(0, Duration.toMillis(timeout) - (now() - asked)),
                  ),
                  orElse: () => timedOut(name, timeout),
                }),
              ),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  queuedMillis = Math.round(now() - asked);
                }),
              ),
              Effect.andThen(deadline(name, timeout, now, () => presented)(action)),
            ),
          );
        });

      const guard = settings.guard;

      // Only an approval needs binding: without a guard, input goes straight to the page.
      const run =
        guard === undefined
          ? dispatch(useInput((run) => body({ ...marks, input: run }, undefined)))
          : Effect.gen(function* () {
              const plan = yield* lane
                .read(name)(deadline(name, settings.actionTimeout, now, () => 0)(prepare))
                .pipe(span("Page.prepare", {}, "Debug"));

              // A hold lasts as long as this span; a judge's model call is its child.
              yield* guard(plan.request).pipe(
                Effect.mapError((reason) => undispatched(name, reason)),
                Effect.timeoutOrElse({
                  duration: settings.policyTimeout,
                  orElse: () =>
                    failWith(
                      name,
                      new PolicyTimeout({ millis: Duration.toMillis(settings.policyTimeout) }),
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

      const record = info.recorded === false ? () => 0 : publish;

      // Record the outcome even when the caller interrupts: its input may already be in the page.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(run));
          const dispatched = yield* Ref.get(sent);
          const point = yield* Ref.get(at);
          const { subject, to, box } = yield* Ref.get(acted);
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

          record(
            new Action({
              at: now(),
              startedAt,
              page: id,
              name,
              correlation: yield* Correlation,
              target: info.target,
              options: Exit.isSuccess(exit) ? info.options : undefined,
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
