/** A bounded H2 probe: exclusive persisted rotation, retained work and durable browser read-back. */
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import type * as Browser from "effect-browser/Browser";
import * as Browserbase from "effect-browserbase/Browserbase";
import {
  BrowserbaseClient,
  type Service,
  type Session,
} from "effect-browserbase/BrowserbaseClient";
import { BrowserbaseError, InvalidRequest } from "effect-browserbase/BrowserbaseError";

import { BenchError, refuse } from "./Budget.ts";
import { uncertainAllocation } from "./Trial.ts";

/** Owner-supplied dashboard verification for this key's project; this is not a billing API check. */
export const Allowance = Schema.Struct({
  verifiedAt: Schema.String,
  verificationFile: Schema.String,
  includedMinutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(10)),
  overageDisabled: Schema.Literal(true),
  exclusiveUse: Schema.Literal(true),
  usageBeforeMinutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const validateAllowance = (input: unknown) =>
  Schema.decodeUnknownEffect(Allowance)(input).pipe(
    Effect.mapError(
      () =>
        new BenchError({
          message: "H2 needs verified included allowance: see docs/HOSTED_CHECKS.md",
        }),
    ),
    Effect.flatMap((allowance) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const age = now - Date.parse(allowance.verifiedAt);

          return Number.isFinite(age) && age >= 0 && age <= 3_600_000
            ? Effect.succeed({
                ...allowance,
                verifiedAt: DateTime.formatIso(
                  DateTime.makeUnsafe(Date.parse(allowance.verifiedAt)),
                ),
              })
            : refuse("H2 allowance verification must be within the last hour");
        }),
      ),
    ),
  );

interface Call {
  readonly operation: string;
  readonly phase: "sent" | "answered" | "failed";
  readonly at: number;
  readonly session?: number;
}

interface SavedSession {
  readonly alias: number;
  readonly status: string;
  readonly createdAt?: string;
  readonly endedAt?: string;
}

const timestamp = (value: string | undefined) => {
  const at = value === undefined ? Number.NaN : Date.parse(value);

  return Number.isFinite(at) ? DateTime.formatIso(DateTime.makeUnsafe(at)) : undefined;
};

const terminal = (status: string) => ["COMPLETED", "ERROR", "TIMED_OUT"].includes(status);

/** Count before dispatch, close admission on any failed create, and retain only aliased evidence. */
export const admission = (source: Service, now: () => number) => {
  let attempts = 0;
  let stopped = false;
  let uncertain = false;
  const sessions = new Map<string, SavedSession>();
  const calls: Array<Call> = [];

  const alias = (id: string) => {
    const held = sessions.get(id);

    if (held !== undefined) return held.alias;
    const number = sessions.size + 1;

    sessions.set(id, { alias: number, status: "UNKNOWN" });

    return number;
  };

  const remember = (session: Session) => {
    sessions.set(session.id, {
      alias: alias(session.id),
      status: ["PENDING", "RUNNING", "COMPLETED", "ERROR", "TIMED_OUT"].includes(session.status)
        ? session.status
        : "UNKNOWN",
      createdAt: timestamp(session.createdAt),
      endedAt: timestamp(session.endedAt),
    });
  };

  const record = (operation: string, phase: Call["phase"], session?: number) =>
    calls.push({ operation, phase, at: now(), ...(session === undefined ? {} : { session }) });

  const observe = <A>(operation: string, id: string, effect: Effect.Effect<A, BrowserbaseError>) =>
    Effect.suspend(() => {
      const session = alias(id);

      record(operation, "sent", session);

      return effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            record(operation, Exit.isSuccess(exit) ? "answered" : "failed", session),
          ),
        ),
      );
    });

  const client: Service = {
    ...source,
    createSession: (options) =>
      Effect.suspend(() => {
        if (stopped || attempts >= 2)
          return Effect.fail(
            new BrowserbaseError({
              operation: "createSession",
              reason: new InvalidRequest({ detail: "H2 session admission is closed" }),
            }),
          );
        attempts += 1;
        stopped = true;
        record("createSession", "sent");

        return source.createSession(options).pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              remember(session);
              stopped = false;
              record("createSession", "answered", alias(session.id));
            }),
          ),
          Effect.onError((cause) =>
            Effect.sync(() => {
              uncertain ||=
                Cause.hasInterrupts(cause) || Cause.hasDies(cause) || uncertainAllocation(cause);
              record("createSession", "failed");
            }),
          ),
        );
      }),
    releaseSession: (id) => observe("releaseSession", id, source.releaseSession(id)),
    getSession: (id) =>
      observe(
        "getSession",
        id,
        source.getSession(id).pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              remember(session);
              if (terminal(session.status)) record("sessionEnded", "answered", alias(id));
            }),
          ),
        ),
      ),
  };

  return {
    client,
    record,
    ids: () => [...sessions.keys()],
    evidence: () => ({ attempts, uncertain, calls: [...calls], sessions: [...sessions.values()] }),
  };
};

const fixture = (browser: Browser.Service) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      browser.context.route("https://h2.browser.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<title>H2 scratch</title><h1>H2 scratch</h1>",
        }),
      ),
    );
    const page = yield* browser.firstPage;

    yield* page.goto("https://h2.browser.test/");

    return page;
  });

/** A probe's report remains readable after failure or interruption; run owns all browser cleanup. */
export const make = Effect.fnUntraced(function* (runId: string) {
  const clock = yield* Clock.Clock;

  const limited = admission(
    yield* BrowserbaseClient,
    () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6,
  );

  const client = limited.client;

  const generations: Array<{
    number: number;
    at: number;
    hostTime: number;
    state: string;
    revokeAt?: number;
    released?: string;
  }> = [];

  const checks = {
    heldReadable: false,
    noOverlapDuringHold: false,
    cleanupBeforeRelease: false,
    terminalBeforeCreate: false,
    contextSettled: false,
    providerOrder: false,
    cookie: false,
    storage: false,
  };

  let contextId: string | undefined;
  let contextDeleted = false;
  let failure: "interrupted" | "operation-failed" | undefined;
  let completed = false;

  const report = () => {
    const evidence = limited.evidence();

    const released = generations
      .filter((event) => event.state === "Closed")
      .map((event) => event.released);

    const confirmed =
      evidence.sessions.length === 2 &&
      evidence.sessions.every(
        (session) => terminal(session.status) && session.endedAt !== undefined,
      ) &&
      released.length === 2 &&
      released.every((release) => release === "Settled");

    return {
      runId,
      status:
        !completed || !confirmed || !contextDeleted || evidence.uncertain
          ? "incomplete"
          : Object.values(checks).every(Boolean)
            ? "held"
            : "broken",
      checks,
      ...evidence,
      generations,
      contextDeleted,
      failure,
      usageDeltaMinutes: null,
    };
  };

  const run = Effect.gen(function* () {
    const context = yield* client.createContext({ name: `h2-${runId}` });

    contextId = context.id;

    const sessions = yield* Browserbase.supervise({
      session: {
        timeout: 120,
        proxies: false,
        userMetadata: { probe: "h2", run: runId },
        browserSettings: {
          context: { id: context.id, persist: true },
          viewport: { width: 1280, height: 720 },
          solveCaptchas: false,
          recordSession: false,
          logSession: false,
          verified: false,
        },
      },
      reopen: Schedule.recurs(0),
      handover: "30 seconds",
      contextSettle: "10 seconds",
    });

    const draining = yield* Deferred.make<void>();

    yield* sessions.states.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          generations.push({
            number: event.number,
            at: event.at,
            hostTime: event.hostTime,
            state: event.state._tag,
            ...(event.state._tag === "Draining" ? { revokeAt: event.state.revokeAt } : {}),
            ...(event.state._tag === "Closed" ? { released: event.state.released?._tag } : {}),
          });
          if (event.number === 1 && event.state._tag === "Draining")
            Deferred.doneUnsafe(draining, Exit.void);
        }),
      ),
      Effect.forkScoped,
    );

    const first = yield* sessions.use((lease) =>
      Effect.gen(function* () {
        const hold = yield* lease.retain;

        yield* Scope.addFinalizer(
          hold,
          Effect.sync(() => limited.record("retainedCleanup", "answered", 1)),
        );
        const page = yield* fixture(lease.browser);

        yield* Effect.promise(() =>
          page.playwright.evaluate((marker) => {
            document.cookie = `h2=${marker}; Max-Age=600; Secure; SameSite=Lax; Path=/`;
            localStorage.setItem("h2", marker);
          }, runId),
        );

        return { hold, page };
      }),
    );

    const rotation = yield* sessions.rotate.pipe(Effect.forkChild);

    yield* Deferred.await(draining);
    yield* Effect.sleep("5 seconds");
    checks.heldReadable = (yield* first.page.snapshot()).text.includes("H2 scratch");
    checks.noOverlapDuringHold =
      limited.evidence().attempts === 1 &&
      !limited.evidence().calls.some((call) => call.operation === "releaseSession");
    yield* Scope.close(first.hold, Exit.void);
    yield* Fiber.join(rotation);
    yield* sessions.use((lease) =>
      Effect.gen(function* () {
        const page = yield* fixture(lease.browser);

        const saved = yield* Effect.promise(() =>
          page.playwright.evaluate(
            (marker) => ({
              cookie: document.cookie.split("; ").includes(`h2=${marker}`),
              storage: localStorage.getItem("h2") === marker,
            }),
            runId,
          ),
        );

        checks.cookie = saved.cookie;
        checks.storage = saved.storage;
      }),
    );
    yield* sessions.retire;
    completed = true;
  }).pipe(
    Effect.provideService(BrowserbaseClient, client),
    Effect.scoped,
    Effect.timeout("4 minutes"),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit))
          failure = Exit.hasInterrupts(exit) ? "interrupted" : "operation-failed";
        for (const id of limited.ids()) yield* client.getSession(id).pipe(Effect.exit);
        const evidence = limited.evidence();
        const cleanup = evidence.calls.find((call) => call.operation === "retainedCleanup");

        const release = evidence.calls.find(
          (call) => call.operation === "releaseSession" && call.phase === "sent",
        );

        const creates = evidence.calls.filter(
          (call) => call.operation === "createSession" && call.phase === "sent",
        );

        const terminalRead = evidence.calls.find(
          (call) =>
            call.operation === "sessionEnded" &&
            call.session === 1 &&
            release !== undefined &&
            call.at >= release.at,
        );

        const old = evidence.sessions[0];
        const next = evidence.sessions[1];

        checks.cleanupBeforeRelease =
          cleanup !== undefined && release !== undefined && cleanup.at <= release.at;
        checks.terminalBeforeCreate =
          terminalRead !== undefined &&
          creates[1] !== undefined &&
          terminalRead.at <= creates[1].at;
        checks.contextSettled =
          terminalRead !== undefined &&
          creates[1] !== undefined &&
          creates[1].at - terminalRead.at >= 10_000;
        checks.providerOrder =
          old?.endedAt !== undefined &&
          next?.createdAt !== undefined &&
          Date.parse(old.endedAt) <= Date.parse(next.createdAt);
        if (
          contextId !== undefined &&
          !evidence.uncertain &&
          evidence.attempts === evidence.sessions.length &&
          evidence.sessions.every((session) => terminal(session.status))
        ) {
          const deleted = yield* client.deleteContext(contextId).pipe(Effect.exit);

          contextDeleted = Exit.isSuccess(deleted);
        }
      }),
    ),
  );

  return { run, report };
});
