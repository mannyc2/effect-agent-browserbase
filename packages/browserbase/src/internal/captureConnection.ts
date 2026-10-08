/**
 * The capture connection: a second DevTools connection to a session, for its pages' screencasts
 * alone. A frame and its acknowledgement then never wait behind a large message on the
 * connection Playwright drives the pages over, such as an upload or a read's answer: Browserbase
 * refuses compression, and on air those waits stopped the picture for as long as the message took
 * to cross.
 *
 * Raw CDP over the global WebSocket, with no Playwright. A page's session on it sends only the
 * capture's commands, and receives that page's events. The connection opens as the first capture
 * starts and stays until the scope closes, which closes it and waits, bounded, for it to close;
 * one that fails ends every page's session on it, and the next capture opens another.
 */
import { Duration, Effect, Option, Redacted, Schema, Semaphore } from "effect";
import type { CaptureSource } from "effect-browser/Browser";
import { BrowserError, Failed } from "effect-browser/BrowserError";

const Message = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Int),
    sessionId: Schema.optionalKey(Schema.String),
    method: Schema.optionalKey(Schema.String),
    params: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
);

const Session = Schema.Struct({ sessionId: Schema.String });

type Listener = Parameters<CaptureSource["attach"]>[1];

interface Open {
  readonly socket: WebSocket;
  /** Replies awaited, by command id. */
  readonly replies: Map<
    number,
    { readonly resolve: (result: unknown) => void; readonly reject: (error: BrowserError) => void }
  >;
  /** Each attached page's listener, by its session id. */
  readonly sessions: Map<string, Listener>;
}

type State =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Open"; readonly open: Open }
  | { readonly _tag: "Closed" };

const failure = (detail: string) =>
  new BrowserError({ operation: "screencast", reason: new Failed({ detail }), dispatched: false });

const closing = Duration.seconds(2);

/** The capture connection to the DevTools address `url`, for the scope. */
export const make = Effect.fnUntraced(function* (url: Redacted.Redacted<string>) {
  let state: State = { _tag: "Idle" };
  let ids = 0;
  const opening = yield* Semaphore.make(1);

  // A failure ends every page's session on the connection; the next capture opens another.
  const lose = (open: Open, error: BrowserError) => {
    if (state._tag !== "Open" || state.open !== open) return;
    state = { _tag: "Idle" };
    for (const reply of open.replies.values()) reply.reject(error);
    for (const listener of open.sessions.values()) listener.lost(error);
    open.replies.clear();
    open.sessions.clear();
  };

  const receive = (open: Open, data: unknown) => {
    const decoded = typeof data === "string" ? Schema.decodeOption(Message)(data) : Option.none();

    if (Option.isNone(decoded))
      return lose(open, failure("the capture connection sent a message it could not read"));
    const { id, sessionId, method, params, result, error } = decoded.value;

    if (id !== undefined) {
      const reply = open.replies.get(id);

      open.replies.delete(id);
      if (error === undefined) reply?.resolve(result);
      else reply?.reject(failure(error.message));
    } else if (method === undefined) return;
    else if (sessionId !== undefined) open.sessions.get(sessionId)?.event(method, params);
    // The connection's own session announces that a page's session ended.
    else if (method === "Target.detachedFromTarget") {
      const detached = Schema.decodeUnknownOption(Session)(params);
      const ended = Option.isSome(detached) ? detached.value.sessionId : "";
      const listener = open.sessions.get(ended);

      open.sessions.delete(ended);
      listener?.event(method, params);
    }
  };

  const send = (
    open: Open,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string,
  ) => {
    if (state._tag !== "Open" || state.open !== open)
      return Promise.reject(failure("the capture connection was lost"));
    const id = ++ids;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();

    open.replies.set(id, { resolve, reject });
    try {
      open.socket.send(JSON.stringify({ id, method, params, sessionId }));
    } catch {
      open.replies.delete(id);
      reject(failure("the capture connection could not send"));
    }

    return promise;
  };

  const connect = Effect.callback<Open, BrowserError>((resume) => {
    const socket = new WebSocket(Redacted.value(url));
    const open: Open = { socket, replies: new Map(), sessions: new Map() };

    const unopened = () => resume(Effect.fail(failure("the capture connection did not open")));

    socket.addEventListener("close", unopened, { once: true });
    socket.addEventListener(
      "open",
      () => {
        socket.removeEventListener("close", unopened);
        // A scope that closed meanwhile keeps no connection.
        if (state._tag === "Closed") {
          socket.close(1000);

          return resume(Effect.fail(failure("the capture connection is closed")));
        }
        state = { _tag: "Open", open };
        socket.addEventListener("close", () =>
          lose(open, failure("the capture connection was lost")),
        );
        resume(Effect.succeed(open));
      },
      { once: true },
    );
    socket.addEventListener("message", ({ data }: MessageEvent<unknown>) => receive(open, data));

    return Effect.sync(() => socket.close(1000));
  });

  const current = opening.withPermits(1)(
    Effect.suspend(() =>
      state._tag === "Open"
        ? Effect.succeed(state.open)
        : state._tag === "Closed"
          ? Effect.fail(failure("the capture connection is closed"))
          : connect,
    ),
  );

  const replied = (reply: () => Promise<unknown>) =>
    Effect.tryPromise({
      try: reply,
      catch: (cause) =>
        Schema.is(BrowserError)(cause) ? cause : failure("the capture connection failed"),
    });

  const attach: CaptureSource["attach"] = (target, listener) =>
    Effect.gen(function* () {
      const open = yield* current;

      const { sessionId } = yield* replied(() =>
        send(open, "Target.attachToTarget", { targetId: target, flatten: true }),
      ).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Session)(result).pipe(
            Effect.mapError(() => failure("the capture connection's attach had no session")),
          ),
        ),
      );

      open.sessions.set(sessionId, listener);
      // Detached as the page's scope closes; a connection that closes detaches every session.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (open.sessions.delete(sessionId))
            void send(open, "Target.detachFromTarget", { sessionId }, undefined).catch(
              () => undefined,
            );
        }),
      );

      return (method, params) => send(open, method, params, sessionId);
    });

  // Closing the scope closes the connection and waits, bounded, until it has closed.
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const previous = state;

      state = { _tag: "Closed" };
      if (previous._tag !== "Open") return Effect.void;
      const { socket, replies, sessions } = previous.open;

      for (const reply of replies.values()) reply.reject(failure("the capture connection closed"));
      replies.clear();
      sessions.clear();

      return Effect.callback<void>((resume) => {
        if (socket.readyState === WebSocket.CLOSED) return resume(Effect.void);
        socket.addEventListener("close", () => resume(Effect.void), { once: true });
        socket.close(1000);
      }).pipe(Effect.timeoutOrElse({ duration: closing, orElse: () => Effect.void }));
    }),
  );

  return { attach } satisfies CaptureSource;
});
