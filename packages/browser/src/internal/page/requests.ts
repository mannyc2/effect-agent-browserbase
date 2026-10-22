/** Context-owned request decisions over bounded CDP interception, including every redirect hop. */
import { Cause, Clock, Duration, Effect, Exit, Option, Queue, Result, Scope } from "effect";
import { Base64 } from "effect/encoding";
import type { BrowserContext } from "playwright-core";

import type { RequestDecision, RequestPolicy } from "../../Browser.ts";
import {
  type BrowserError,
  refuse,
  reasonOf,
  Threw,
  Timeout,
  undispatched,
} from "../../BrowserError.ts";
import { type BrowserEvent, RequestRefused } from "../../BrowserEvent.ts";
import * as Url from "../../Url.ts";
import * as Port from "./port.ts";
import * as Owner from "./request-owner.ts";

interface Paused {
  readonly requestId: string;
  readonly page?: string | undefined;
  readonly frameId?: string | undefined;
  readonly request: {
    readonly hasPostData?: boolean | undefined;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly url: string;
    readonly method: string;
    readonly postData?: string | undefined;
    readonly postDataEntries?: ReadonlyArray<{ readonly bytes?: string | undefined }> | undefined;
  };
}

const responseOf = (decision: Extract<RequestDecision, { readonly _tag: "Fulfilled" }>) =>
  Number.isInteger(decision.status) &&
  decision.status >= 100 &&
  decision.status <= 599 &&
  new TextEncoder().encode(decision.body).byteLength <= 8_000_000 &&
  !/[\r\n]/.test(decision.contentType) &&
  Object.entries(decision.headers ?? {}).every(
    ([name, value]) => name !== "" && !/[\r\n]/.test(name + value),
  )
    ? {
        responseCode: decision.status,
        responseHeaders: [
          { name: "Content-Type", value: decision.contentType },
          ...Object.entries(decision.headers ?? {}).map(([name, value]) => ({ name, value })),
        ],
        body: Base64.encode(decision.body),
      }
    : undefined;

const bounded =
  (clock: Clock.Clock, duration: Duration.Duration): Owner.Native =>
  <A>(run: (signal: AbortSignal) => Promise<A>, closing = false) => {
    const bound = closing ? Duration.min(duration, Duration.seconds(1)) : duration;

    return Effect.tryPromise({
      try: run,
      catch: (cause) => undispatched("requests", reasonOf(cause, undefined, "connection")),
    }).pipe(
      Effect.timeoutOrElse({
        duration: bound,
        orElse: () =>
          Effect.fail(undispatched("requests", new Timeout({ millis: Duration.toMillis(bound) }))),
      }),
      Effect.provideService(Clock.Clock, clock),
    );
  };

type Reply = (
  paused: Paused,
  method: "Fetch.continueRequest" | "Fetch.failRequest" | "Fetch.fulfillRequest",
  params?: object,
  authorize?: boolean,
) => Effect.Effect<void, BrowserError>;

const bodyOf = (request: Paused["request"]): string | null | undefined => {
  const hasBody =
    request.hasPostData === true ||
    request.postData !== undefined ||
    (request.postDataEntries?.length ?? 0) > 0 ||
    Object.entries(request.headers ?? {}).some(
      ([name, value]) => name.toLowerCase() === "content-length" && Number(value) > 0,
    );

  if (!hasBody) return null;
  if (request.postData === undefined || request.postDataEntries === undefined) return undefined;
  const chunks: Uint8Array[] = [];

  for (const entry of request.postDataEntries) {
    if (entry.bytes === undefined) return undefined;
    const decoded = Base64.decode(entry.bytes);

    if (Result.isFailure(decoded)) return undefined;
    chunks.push(decoded.success);
  }

  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    return text === request.postData ? text : undefined;
  } catch {
    return undefined;
  }
};

const deciding =
  (
    policy: RequestPolicy,
    clock: Clock.Clock,
    duration: Duration.Duration,
    closing: () => boolean,
    lost: () => void,
    deny: (
      paused: Paused,
      reason: string,
      failure?: BrowserError,
    ) => Effect.Effect<void, BrowserError>,
    reply: Reply,
  ) =>
  (paused: Paused) =>
    Effect.suspend(() => {
      const body = bodyOf(paused.request);

      if (body === undefined)
        return Effect.succeed({
          _tag: "Refused" as const,
          reason: "request body was not fully observable as UTF-8 text",
        });

      return policy.decide({
        url: paused.request.url,
        method: paused.request.method,
        body,
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: duration,
        orElse: () =>
          Effect.fail(
            undispatched("requests", new Timeout({ millis: Duration.toMillis(duration) })),
          ),
      }),
      Effect.catchCause((cause) => {
        if (closing() && Cause.hasInterrupts(cause)) return Effect.failCause(cause);

        const error = Option.getOrElse(Cause.findErrorOption(cause), () =>
          undispatched("requests", new Threw({})),
        );

        lost();

        return deny(
          paused,
          error.reason._tag === "Timeout"
            ? "request decision timed out"
            : `request decision failed: ${error.reason._tag}`,
          error,
        ).pipe(Effect.andThen(Effect.fail(error)));
      }),
      Effect.flatMap((decision) => {
        if (decision._tag === "Allowed") return reply(paused, "Fetch.continueRequest", {}, true);
        if (decision._tag === "Refused") return deny(paused, decision.reason);
        const response = responseOf(decision);

        return response === undefined
          ? deny(paused, "request fulfillment is invalid or exceeds 8MB")
          : reply(paused, "Fetch.fulfillRequest", response, true);
      }),
      Effect.provideService(Clock.Clock, clock),
    );

const retire = (
  owner: Effect.Success<ReturnType<typeof Owner.make>>,
  held: ReadonlyMap<string, Paused>,
  reply: Reply,
) =>
  Effect.forEach(
    held.values(),
    (paused) =>
      owner.owns(paused.frameId).pipe(
        Effect.matchEffect({
          onFailure: () => reply(paused, "Fetch.failRequest", { errorReason: "BlockedByClient" }),
          onSuccess: (owned) =>
            reply(
              paused,
              owned ? "Fetch.failRequest" : "Fetch.continueRequest",
              owned ? { errorReason: "BlockedByClient" } : {},
            ),
        }),
      ),
    { concurrency: 8, discard: true },
  );

export const install = Effect.fnUntraced(function* (
  context: BrowserContext,
  policy: RequestPolicy,
  clock: Clock.Clock,
  publish: (event: BrowserEvent) => number,
  now: () => number,
  lost: () => void,
  unavailable: () => boolean,
) {
  const browser = context.browser();

  if (browser === null)
    return yield* refuse("requests", "this provider cannot intercept browser requests");
  const bound = Duration.fromInput(policy.timeout ?? "5 seconds");

  if (
    bound._tag === "None" ||
    !Duration.isFinite(bound.value) ||
    !Duration.isPositive(bound.value) ||
    policy.patterns.length === 0
  )
    return yield* refuse("requests", "request patterns and a finite positive timeout are required");

  const native = bounded(clock, bound.value);
  const protocol = yield* Effect.context<never>();

  const chrome = yield* Effect.acquireRelease(
    native((signal) =>
      Effect.runPromiseWith(protocol)(
        Port.openSession(() => browser.newBrowserCDPSession(), undefined, "browser"),
        { signal },
      ).then(async (session) => {
        if (signal.aborted) await session.detach().catch(() => undefined);

        return session;
      }),
    ),
    (chrome) => native(() => chrome.detach(), true).pipe(Effect.orDie),
  );

  let closing = false;
  const owner = yield* Owner.make(context, chrome, native, () => closing);
  const held = new Map<string, Paused>();
  const pending = yield* Queue.unbounded<Paused>();
  const workers = yield* Scope.make();

  const record = (paused: Paused, reason: string, failure?: BrowserError) =>
    publish(
      new RequestRefused({
        at: now(),
        page: paused.page,
        method: paused.request.method,
        url: Url.redact(paused.request.url),
        reason: Url.redactWithin(reason).slice(0, 2000),
        ...(failure === undefined
          ? {}
          : {
              failure: {
                reason: failure.reason._tag,
                ...(failure.reason._tag === "Timeout"
                  ? { timeoutMillis: failure.reason.millis }
                  : {}),
              },
            }),
      }),
    );

  const reply: Reply = (paused, method, params = {}, authorize = false) =>
    native(async () => {
      // Check at dispatch: a policy may finish after a sibling failed or retirement began.
      const ended = authorize && (closing || unavailable());

      if (ended) record(paused, "request authority has ended");
      try {
        await chrome.send(ended ? "Fetch.failRequest" : method, {
          requestId: paused.requestId,
          ...(ended ? { errorReason: "BlockedByClient" } : params),
        });
      } catch (cause) {
        // A cancelled request is already settled; it does not revoke the browser's authority.
        if (!(cause instanceof Error && /Invalid InterceptionId\.?$/.test(cause.message)))
          throw cause;
      }
      held.delete(paused.requestId);
    }, closing).pipe(Effect.uninterruptible);

  const deny = (paused: Paused, reason: string, failure?: BrowserError) =>
    Effect.sync(() => record(paused, reason, failure)).pipe(
      Effect.andThen(reply(paused, "Fetch.failRequest", { errorReason: "BlockedByClient" })),
    );

  const decide = deciding(policy, clock, bound.value, () => closing, lost, deny, reply);

  const handle = (paused: Paused) =>
    owner.owns(paused.frameId).pipe(
      Effect.matchEffect({
        onFailure: () => deny(paused, "request ownership could not be established"),
        onSuccess: (owned) =>
          !owned
            ? reply(paused, "Fetch.continueRequest")
            : closing || unavailable()
              ? deny({ ...paused, page: owned.page }, "request authority has ended")
              : decide({ ...paused, page: owned.page }),
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => {
          const error = Option.getOrElse(Cause.findErrorOption(cause), () =>
            undispatched("requests", new Threw({})),
          );

          return (
            unavailable()
              ? Effect.void
              : Effect.sync(() => record(paused, "request control failed", error))
          ).pipe(Effect.andThen(Effect.sync(lost)));
        },
      ),
    );

  const onRequest = (paused: Paused) => {
    held.set(paused.requestId, paused);
    Queue.offerUnsafe(pending, paused);
  };

  chrome.on("Fetch.requestPaused", onRequest);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closing = true;
    }).pipe(
      // This stops new pauses without releasing the existing ones, unlike detach or disable.
      Effect.andThen(native(() => chrome.send("Fetch.enable", { patterns: [] }), true)),
      Effect.ensuring(Scope.close(workers, Exit.void)),
      Effect.andThen(Effect.suspend(() => retire(owner, held, reply))),
      Effect.ensuring(Effect.sync(() => chrome.off("Fetch.requestPaused", onRequest))),
      Effect.orDie,
    ),
  );

  for (let index = 0; index < 8; index++)
    yield* Queue.take(pending).pipe(
      Effect.flatMap(handle),
      Effect.forever,
      Effect.forkScoped,
      Scope.provide(workers),
    );

  yield* native(() =>
    chrome.send("Fetch.enable", {
      patterns: policy.patterns.map((urlPattern) => ({ urlPattern })),
    }),
  );
  yield* owner.refresh;
});
