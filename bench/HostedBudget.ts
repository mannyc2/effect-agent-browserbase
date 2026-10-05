/** Hosted time is reserved before creation; unknown writes keep the whole timeout bound. */
import { Clock, Deferred, Effect, Exit, Ref, Schema } from "effect";
import type * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";

export const sessionSeconds = 600;

export class HostedError extends Schema.TaggedError<HostedError>()("HostedBudgetError", {
  code: Schema.Literals(["Limit", "Create", "MissingEndpoint"]),
}) {}

export interface Snapshot {
  readonly creates: number;
  readonly allocated: number;
  readonly releasesRequested: number;
  readonly releasesAcknowledged: number;
  readonly terminalConfirmed: number;
  readonly knownSeconds: number;
  readonly reservedSeconds: number;
  readonly uncertainSessions: number;
  readonly stopped: boolean;
}

const terminal = Effect.fnUntraced(
  function* (client: BrowserbaseClient.Service, id: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const session = yield* client.getSession(id).pipe(Effect.timeout("5 seconds"));

      if (session.id !== id) return false;
      if (["COMPLETED", "ERROR", "TIMED_OUT"].includes(session.status)) return true;
      if (attempt < 9) yield* Effect.sleep("1 second");
    }

    return false;
  },
  Effect.timeout("30 seconds"),
  Effect.orElseSucceed(() => false),
);

export const make = (maximumSeconds: number) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < sessionSeconds)
      return yield* new HostedError({ code: "Limit" });
    const changed = yield* Deferred.make<void>();

    const state = yield* Ref.make({
      creates: 0,
      allocated: 0,
      releasesRequested: 0,
      releasesAcknowledged: 0,
      terminalConfirmed: 0,
      knownSeconds: 0,
      reservedSeconds: 0,
      uncertainSessions: 0,
      active: 0,
      stopped: false,
      changed,
    });

    const stop = Effect.gen(function* () {
      const next = yield* Deferred.make<void>();

      const previous = yield* Ref.modify(state, (value) => [
        value.changed,
        { ...value, stopped: true, changed: next },
      ]);

      yield* Deferred.succeed(previous, undefined);
    });

    const settle = (seconds: number | undefined) =>
      Effect.gen(function* () {
        const next = yield* Deferred.make<void>();

        const previous = yield* Ref.modify(state, (value) => [
          value.changed,
          {
            ...value,
            active: value.active - sessionSeconds,
            knownSeconds: value.knownSeconds + (seconds ?? 0),
            reservedSeconds: value.reservedSeconds - (seconds === undefined ? 0 : sessionSeconds),
            uncertainSessions: value.uncertainSessions + (seconds === undefined ? 1 : 0),
            stopped: value.stopped || seconds === undefined,
            changed: next,
          },
        ]);

        yield* Deferred.succeed(previous, undefined);
      });

    const admit = (restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        while (true) {
          const admission = yield* Ref.modify(state, (value) => {
            const fits =
              !value.stopped &&
              value.knownSeconds + value.reservedSeconds + sessionSeconds <= maximumSeconds;

            return [
              {
                fits,
                denied:
                  value.stopped ||
                  value.knownSeconds + value.reservedSeconds - value.active + sessionSeconds >
                    maximumSeconds,
                changed: value.changed,
              },
              fits
                ? {
                    ...value,
                    reservedSeconds: value.reservedSeconds + sessionSeconds,
                    active: value.active + sessionSeconds,
                  }
                : value,
            ];
          });

          if (admission.fits) return;
          if (admission.denied) return yield* new HostedError({ code: "Limit" });
          yield* restore(Deferred.await(admission.changed));
        }
      });

    return {
      stop,
      snapshot: Ref.get(state).pipe(
        Effect.map((value): Snapshot => ({
          creates: value.creates,
          allocated: value.allocated,
          releasesRequested: value.releasesRequested,
          releasesAcknowledged: value.releasesAcknowledged,
          terminalConfirmed: value.terminalConfirmed,
          knownSeconds: value.knownSeconds,
          reservedSeconds: value.reservedSeconds,
          uncertainSessions: value.uncertainSessions,
          stopped: value.stopped,
        })),
      ),
      open: (client: BrowserbaseClient.Service) =>
        Effect.gen(function* () {
          // Keep admission through ownership atomic, but permit cancellation while queued.
          const owner = yield* Effect.uninterruptibleMask((restore) =>
            Effect.acquireRelease(
              admit(restore).pipe(Effect.as({ dispatched: false, settled: false })),
              (owner) => (owner.settled ? Effect.void : settle(owner.dispatched ? undefined : 0)),
            ),
          );

          const started = yield* Clock.monotonicTimeNanos;

          owner.dispatched = true;
          yield* Ref.update(state, (value) => ({ ...value, creates: value.creates + 1 }));

          const session = yield* Effect.acquireRelease(
            client
              .createSession({
                timeout: sessionSeconds,
                keepAlive: false,
                proxies: false,
                browserSettings: {
                  viewport: { width: 1280, height: 720 },
                  solveCaptchas: false,
                  recordSession: false,
                  logSession: false,
                },
              })
              .pipe(
                Effect.timeout("30 seconds"),
                Effect.mapError(() => new HostedError({ code: "Create" })),
              ),
            (session) =>
              Effect.gen(function* () {
                yield* Ref.update(state, (value) => ({
                  ...value,
                  releasesRequested: value.releasesRequested + 1,
                }));

                const released = yield* client
                  .releaseSession(session.id)
                  .pipe(Effect.timeout("30 seconds"), Effect.exit);

                if (Exit.isSuccess(released))
                  yield* Ref.update(state, (value) => ({
                    ...value,
                    releasesAcknowledged: value.releasesAcknowledged + 1,
                  }));

                // An acknowledgment can precede termination, and a lost release response can hide
                // success. Only a read of this exact session can return unused admission.
                const confirmed = yield* terminal(client, session.id);

                owner.settled = true;
                if (!confirmed) {
                  yield* settle(undefined);

                  return;
                }
                yield* Ref.update(state, (value) => ({
                  ...value,
                  terminalConfirmed: value.terminalConfirmed + 1,
                }));
                const ended = yield* Clock.monotonicTimeNanos;

                // Elapsed time through terminal confirmation is an upper bound, not an invoice.
                yield* settle(
                  Math.min(
                    sessionSeconds,
                    Math.max(0, Number((ended - started + 999_999_999n) / 1_000_000_000n)),
                  ),
                );
              }),
          );

          yield* Ref.update(state, (value) => ({ ...value, allocated: value.allocated + 1 }));
          if (session.connectUrl === undefined)
            return yield* new HostedError({ code: "MissingEndpoint" });

          return session.connectUrl;
        }),
    };
  });
