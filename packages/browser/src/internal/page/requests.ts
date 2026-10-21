/** Context-owned request decisions over bounded CDP interception, including every redirect hop. */
import { Cause, Clock, Duration, Effect, FiberSet, Option, Queue, Result } from "effect";
import { Base64 } from "effect/encoding";
import type { BrowserContext } from "playwright-core";

import type { RequestDecision, RequestPolicy } from "../../Browser.ts";
import {
  type BrowserError,
  Closed,
  InvalidRequest,
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
  (
    clock: Clock.Clock,
    duration: Duration.Duration,
    failed: () => boolean,
    fail: () => void,
  ): Owner.Native =>
  <A>(run: (signal: AbortSignal) => Promise<A>, closing = false) =>
    Effect.suspend(() => {
      if (failed() && !closing)
        return Effect.fail(undispatched("requests", new Closed({ cause: "connection" })));

      return Effect.tryPromise({
        try: run,
        catch: (cause) => undispatched("requests", reasonOf(cause, undefined, "connection")),
      }).pipe(
        Effect.timeoutOrElse({
          duration: closing ? Duration.min(duration, Duration.seconds(1)) : duration,
          orElse: () =>
            Effect.fail(
              undispatched("requests", new Timeout({ millis: Duration.toMillis(duration) })),
            ),
        }),
        Effect.tapError(() => Effect.sync(fail)),
        Effect.provideService(Clock.Clock, clock),
      );
    });

type Reply = (
  paused: Paused,
  method: "Fetch.continueRequest" | "Fetch.failRequest" | "Fetch.fulfillRequest",
  params?: object,
  closing?: boolean,
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
    deny: (paused: Paused, reason: string) => Effect.Effect<void, BrowserError>,
    reply: Reply,
  ) =>
  (paused: Paused) =>
    Effect.suspend(() => {
      const body = bodyOf(paused.request);

      if (body === undefined)
        return Effect.fail(
          undispatched(
            "requests",
            new InvalidRequest({ detail: "request body was not fully observable as UTF-8 text" }),
          ),
        );

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

        return deny(
          paused,
          error.reason._tag === "Timeout"
            ? "request decision timed out"
            : "request decision failed",
        ).pipe(Effect.andThen(Effect.fail(error)));
      }),
      Effect.flatMap((decision) => {
        if (decision._tag === "Allowed") return reply(paused, "Fetch.continueRequest");
        if (decision._tag === "Refused") return deny(paused, decision.reason);
        const response = responseOf(decision);

        return response === undefined
          ? deny(paused, "request fulfillment is invalid or exceeds 8MB")
          : reply(paused, "Fetch.fulfillRequest", response);
      }),
      Effect.provideService(Clock.Clock, clock),
    );

const identifying = (
  owner: Effect.Success<ReturnType<typeof Owner.make>>,
  fail: (untracked: boolean) => void,
  frame: string | undefined,
) => owner.owns(frame).pipe(Effect.tapCause(() => Effect.sync(() => fail(true))));

const retiring = (
  owner: Effect.Success<ReturnType<typeof Owner.make>>,
  held: ReadonlyMap<string, Paused>,
  reply: Reply,
  uncertain: () => boolean,
) =>
  Effect.suspend(() =>
    uncertain()
      ? owner.closeOwned
      : Effect.forEach(
          held.values(),
          (paused) =>
            owner
              .owns(paused.frameId, true)
              .pipe(
                Effect.flatMap((owned) =>
                  reply(
                    paused,
                    owned ? "Fetch.failRequest" : "Fetch.continueRequest",
                    owned ? { errorReason: "BlockedByClient" } : {},
                    true,
                  ),
                ),
              ),
          { concurrency: 8, discard: true },
        ).pipe(
          Effect.andThen(Effect.suspend(() => (uncertain() ? owner.closeOwned : Effect.void))),
          Effect.catchCause(() => owner.closeOwned),
        ),
  );

export const install = Effect.fnUntraced(function* (
  context: BrowserContext,
  policy: RequestPolicy,
  clock: Clock.Clock,
  publish: (event: BrowserEvent) => number,
  now: () => number,
  lost: () => void,
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

  let state:
    | { readonly _tag: "Active" }
    | { readonly _tag: "Lost"; readonly untracked: boolean }
    | { readonly _tag: "Closing"; readonly uncertain: boolean } = { _tag: "Active" };

  const fail = (untracked = false) => {
    state =
      state._tag === "Closing"
        ? { _tag: "Closing", uncertain: state.uncertain || untracked }
        : { _tag: "Lost", untracked: untracked || (state._tag === "Lost" && state.untracked) };
    lost();
  };

  const native = bounded(clock, bound.value, () => state._tag !== "Active", fail);
  let retire: Effect.Effect<void, BrowserError> = Effect.void;
  let stopListening: (() => void) | undefined;

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
    (chrome) =>
      retire.pipe(
        Effect.orDie,
        Effect.ensuring(
          Effect.sync(() => stopListening?.()).pipe(
            Effect.andThen(native(() => chrome.detach(), true)),
            Effect.orDie,
          ),
        ),
      ),
  );

  const owner = yield* Owner.make(context, chrome, native);
  const held = new Map<string, Paused>();
  const pending = yield* Queue.bounded<Paused>(32);

  const reply = (
    paused: Paused,
    method: "Fetch.continueRequest" | "Fetch.failRequest" | "Fetch.fulfillRequest",
    params: object = {},
    closing = false,
  ) =>
    native(
      () =>
        chrome.send(method, { requestId: paused.requestId, ...params }).then((value) => {
          held.delete(paused.requestId);

          return value;
        }),
      closing,
    ).pipe(Effect.asVoid);

  const deny = (paused: Paused, reason: string) =>
    Effect.sync(() => {
      publish(
        new RequestRefused({
          at: now(),
          page: paused.page,
          method: paused.request.method,
          url: Url.redact(paused.request.url),
          reason: Url.redactWithin(reason).slice(0, 2000),
        }),
      );
    }).pipe(Effect.andThen(reply(paused, "Fetch.failRequest", { errorReason: "BlockedByClient" })));

  const decide = deciding(policy, clock, bound.value, () => state._tag === "Closing", deny, reply);

  const handle = (paused: Paused) =>
    identifying(owner, fail, paused.frameId).pipe(
      Effect.flatMap((owned) =>
        owned ? decide({ ...paused, page: owned.page }) : reply(paused, "Fetch.continueRequest"),
      ),
      Effect.tapCause((cause) =>
        state._tag === "Closing" && Cause.hasInterrupts(cause) ? Effect.void : Effect.sync(fail),
      ),
    );

  for (let index = 0; index < 8; index++)
    yield* Queue.take(pending).pipe(Effect.flatMap(handle), Effect.forever, Effect.forkScoped);

  const refusing = new Set<string>();
  const overflow = yield* FiberSet.make();
  const runOverflow = yield* FiberSet.runtime(overflow)<never>();

  const onRequest = (paused: Paused) => {
    if (state._tag !== "Active") {
      fail(true);

      return;
    }
    if (held.size === 72) {
      fail(true);

      return;
    }
    held.set(paused.requestId, paused);
    if (Queue.offerUnsafe(pending, paused)) return;
    if (refusing.size === 32) {
      fail();

      return;
    }
    refusing.add(paused.requestId);
    runOverflow(
      identifying(owner, fail, paused.frameId).pipe(
        Effect.flatMap((owned) =>
          owned
            ? deny({ ...paused, page: owned.page }, "request decision queue is full")
            : reply(paused, "Fetch.continueRequest"),
        ),
        Effect.tapCause((cause) =>
          state._tag === "Closing" && Cause.hasInterrupts(cause) ? Effect.void : Effect.sync(fail),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            refusing.delete(paused.requestId);
          }),
        ),
      ),
    );
  };

  chrome.on("Fetch.requestPaused", onRequest);
  stopListening = () => {
    chrome.off("Fetch.requestPaused", onRequest);
  };
  retire = retiring(owner, held, reply, () => state._tag === "Closing" && state.uncertain);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      state = { _tag: "Closing", uncertain: state._tag === "Lost" && state.untracked };
    }),
  );
  yield* native(() =>
    chrome.send("Fetch.enable", {
      patterns: policy.patterns.map((urlPattern) => ({ urlPattern })),
    }),
  );
  yield* owner.assertSupported;
});
