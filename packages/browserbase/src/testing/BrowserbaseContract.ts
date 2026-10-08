/**
 * What this package relies on the Browserbase API to do, as named checks over
 * `BrowserbaseClient`, each an Effect with no test runner around it. A package test runs them
 * against `TestBrowserbase`, which keeps the fake to them; run against Browserbase itself, they
 * show whether the fake is still faithful, at the cost of a few one-minute sessions. Checks that
 * move the test clock run only against the fake.
 *
 * @category testing
 * @since 0.3.0
 */
import { Clock, Effect, Schedule, Schema } from "effect";
import { TestClock } from "effect/testing";

import { BrowserbaseClient, type Session } from "../BrowserbaseClient.ts";
import type { BrowserbaseError } from "../BrowserbaseError.ts";

/** A check found the API behaving otherwise. */
export class Broken extends Schema.TaggedError<Broken>()("Broken", {
  check: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.check}: ${this.detail}`;
  }
}

export interface Check {
  readonly name: string;
  /** It moves the test clock, so only the fake can run it. */
  readonly clock: boolean;
  readonly run: Effect.Effect<void, Broken | BrowserbaseError, BrowserbaseClient>;
}

const check = (
  name: string,
  run: (
    expect: (holds: boolean, detail: string) => Effect.Effect<void, Broken>,
  ) => Effect.Effect<void, Broken | BrowserbaseError, BrowserbaseClient>,
  clock = false,
): Check => ({
  name,
  clock,
  run: run((holds, detail) =>
    holds ? Effect.void : Effect.fail(new Broken({ check: name, detail })),
  ).pipe(Effect.withSpan("BrowserbaseContract.check", { attributes: { check: name } })),
});

const running = (session: Session) => session.status === "PENDING" || session.status === "RUNNING";

/** What the call failed with, or `nothing` when it succeeded. */
const failure = <A, R>(call: Effect.Effect<A, BrowserbaseError, R>) =>
  Effect.match(call, { onFailure: (error) => error.reason._tag, onSuccess: () => "nothing" });

/** Read the session until it has ended, for at most 10 seconds. */
const ended = (client: BrowserbaseClient["Service"], id: string) =>
  client.getSession(id).pipe(
    Effect.repeat({
      until: (session) => !running(session),
      schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 10 })),
    }),
  );

export const checks: ReadonlyArray<Check> = [
  check("a new session runs, and ends once released", (expect) =>
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const session = yield* client.createSession({ timeout: 60 });

      yield* expect(running(session), `a new session is ${session.status}`);
      yield* client.releaseSession(session.id);
      const after = yield* ended(client, session.id);

      yield* expect(after.status === "COMPLETED", `a released session is ${after.status}`);
      // Releasing a session that has ended succeeds and changes nothing.
      yield* client.releaseSession(session.id);
      const again = yield* client.getSession(session.id);

      yield* expect(again.status === "COMPLETED", `released twice, it is ${again.status}`);
    }),
  ),
  check("a well-formed id no session has is not found", (expect) =>
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const read = yield* failure(client.getSession("00000000-0000-4000-8000-000000000000"));

      yield* expect(read === "NotFound", `reading it failed with ${read}`);
    }),
  ),
  check("a session id of another shape is refused as invalid", (expect) =>
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const read = yield* failure(client.getSession("not-a-session-of-this-project"));

      yield* expect(read === "InvalidRequest", `reading it failed with ${read}`);
    }),
  ),
  check("sessions are found by status and user metadata", (expect) =>
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const label = `contract-${yield* Clock.currentTimeMillis}`;
      const session = yield* client.createSession({ timeout: 60, userMetadata: { label } });
      const query = (value: string) => `user_metadata['label']:'${value}'`;

      // A new session is PENDING or RUNNING, and may change between the two queries, so the
      // package looks under both statuses; a check of one alone would fail a compliant API.
      const running = (value: string) =>
        Effect.map(
          Effect.forEach(["PENDING", "RUNNING"], (status) =>
            client.listSessions({ status, query: query(value) }),
          ),
          (found) => new Set(found.flat().map(({ id }) => id)),
        );

      const found = yield* running(label);
      const other = yield* running(`${label}-x`);

      yield* client.releaseSession(session.id);
      yield* ended(client, session.id);
      const gone = yield* running(label);

      yield* expect(
        found.size === 1 && found.has(session.id),
        `${found.size} unended sessions had its label`,
      );
      yield* expect(other.size === 0, `${other.size} sessions had another label`);
      yield* expect(gone.size === 0, `${gone.size} still ran once it had ended`);
    }),
  ),
  check("a stored context reads back, and is gone once deleted", (expect) =>
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const created = yield* client.createContext();
      const read = yield* client.getContext(created.id);

      yield* client.deleteContext(created.id);
      const gone = yield* failure(client.getContext(created.id));

      yield* expect(read.id === created.id, `it read back as ${read.id}`);
      yield* expect(gone === "NotFound", `once deleted, reading it failed with ${gone}`);
    }),
  ),
  check(
    "a session ends at its timeout",
    (expect) =>
      Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        const session = yield* client.createSession({ timeout: 60 });

        yield* TestClock.adjust("61 seconds");
        const after = yield* client.getSession(session.id);

        yield* expect(after.status === "TIMED_OUT", `after its timeout it is ${after.status}`);
      }),
    true,
  ),
];
