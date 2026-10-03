import { Clock, Deferred, Effect, Exit, Schema, Scope } from "effect";
import type {
  CaptureSource,
  CaptureStart,
  CaptureTarget,
  Lifetime,
} from "effect-browser/browser-runtime";
import { BrowserError, Reasons, type BrowserReason } from "effect-browser/errors";
import { Socket } from "effect/unstable/socket";

import type { ObservationEndpoint } from "./ObservationBinding.ts";

const Envelope = Schema.Struct({
  id: Schema.optionalKey(Schema.Natural),
  sessionId: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});

const Attachment = Schema.Struct({ sessionId: Schema.NonEmptyString });

const Frame = Schema.Struct({
  id: Schema.NonEmptyString,
  url: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
});

const FrameTree = Schema.Struct({ frameTree: Schema.Struct({ frame: Frame }) });
const Navigation = Schema.Struct({ frame: Frame });
const WithinDocument = Schema.Struct({ frameId: Schema.NonEmptyString, url: Schema.String });

const ScreencastFrame = Schema.Struct({
  sessionId: Schema.Natural,
  data: Schema.Uint8ArrayFromBase64,
  metadata: Schema.Struct({
    timestamp: Schema.Finite,
    deviceWidth: Schema.Finite,
    deviceHeight: Schema.Finite,
  }),
});

// This is the entire protocol capability. No caller can submit an arbitrary CDP command.
type Command =
  | {
      readonly method: "Target.attachToTarget";
      readonly params: { readonly targetId: string; readonly flatten: true };
    }
  | { readonly method: "Target.detachFromTarget"; readonly params: { readonly sessionId: string } }
  | {
      readonly method: "Page.enable" | "Page.getFrameTree" | "Page.stopScreencast";
      readonly sessionId: string;
    }
  | {
      readonly method: "Page.startScreencast";
      readonly sessionId: string;
      readonly params: {
        readonly format: "jpeg";
        readonly quality: number;
        readonly maxWidth: number;
        readonly maxHeight: number;
      };
    }
  | {
      readonly method: "Page.screencastFrameAck";
      readonly sessionId: string;
      readonly params: { readonly sessionId: number };
    };

interface Target {
  readonly options: CaptureStart;
  frameId?: string;
  opened: boolean;
  detached: boolean;
  released: boolean;
}

interface Pending {
  readonly reply: Deferred.Deferred<unknown, BrowserError>;
  readonly acknowledgement: boolean;
  readonly sessionId?: string;
  readonly deadline?: number;
  readonly accept?: (value: unknown) => Effect.Effect<void, BrowserError>;
}

const failure = (reason: BrowserReason = Reasons.Transport.make({})) =>
  BrowserError.make({ operation: "capture-start", reason, outcome: "unknown" });

// The public capture byte ceiling is 64 MiB; base64 plus bounded metadata fits below 90 MiB.
const maxMessageBytes = 90 * 1024 * 1024;

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => failure(Reasons.Malformed.make({}))),
  );

export interface Observation {
  readonly source: (target: CaptureTarget) => CaptureSource;
  readonly close: Effect.Effect<void, BrowserError>;
}

/** One lazy socket per provider session, with bounded, flattened page attachments. */
export const makeObservation = Effect.fnUntraced(function* (options: {
  readonly connection: Lifetime["connection"];
  readonly resolve: ObservationEndpoint;
  readonly constructor: Socket.WebSocketConstructor["Service"];
  readonly deadline: number;
}): Effect.fn.Return<Observation, never, Scope.Scope> {
  const scope = yield* Scope.make();
  const clock = yield* Clock.Clock;
  const closed = yield* Deferred.make<void>();
  const targets = new Map<string, Target>();
  const pending = new Map<number, Pending>();
  let sequence = 0;
  let terminal: BrowserError | undefined;
  let closing = false;
  let writer: Socket.Writer | undefined;
  let closeSocket: Effect.Effect<void, BrowserError> = Effect.void;

  const terminate = (error: BrowserError) =>
    Effect.sync(() => {
      terminal ??= error;
      for (const item of pending.values()) Deferred.doneUnsafe(item.reply, Effect.fail(terminal));
      pending.clear();
      for (const target of targets.values()) if (!target.released) target.options.fail(terminal);
    });

  const write = Effect.fnUntraced(function* (command: Command, accept?: Pending["accept"]) {
    if (terminal !== undefined) return yield* terminal;
    if (writer === undefined || closing) return yield* failure(Reasons.Closed.make({}));
    if (pending.size >= 32) return yield* failure(Reasons.Busy.make({}));
    const id = ++sequence;
    const reply = yield* Deferred.make<unknown, BrowserError>();

    pending.set(id, {
      reply,
      acknowledgement: command.method === "Page.screencastFrameAck",
      ...(command.method === "Page.screencastFrameAck"
        ? { deadline: Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 + 2000 }
        : {}),
      ...("sessionId" in command ? { sessionId: command.sessionId } : {}),
      ...(accept === undefined ? {} : { accept }),
    });

    const message = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      id,
      ...command,
    }).pipe(Effect.mapError(() => failure(Reasons.Malformed.make({}))));

    yield* writer.write(message).pipe(
      Effect.mapError(() => failure()),
      Effect.tapError(terminate),
    );

    return { id, reply };
  });

  const request = Effect.fnUntraced(function* (command: Command, accept?: Pending["accept"]) {
    const sent = yield* write(command, accept);

    return yield* Deferred.await(sent.reply).pipe(
      Effect.timeoutOrElse({
        duration: 2000,
        orElse: () => Effect.fail(failure(Reasons.Timeout.make({}))),
      }),
      Effect.tapError((error) =>
        error.reason._tag === "Timeout" ? terminate(error) : Effect.void,
      ),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(sent.id);
        }),
      ),
    );
  });

  const dispatch = Effect.fnUntraced(function* (text: string) {
    if (text.length > maxMessageBytes)
      return yield* failure(
        Reasons.Limit.make({
          dimension: "buffered-bytes",
          maximum: maxMessageBytes,
          observed: text.length,
        }),
      );
    const message = yield* decode(Schema.fromJsonString(Envelope), text);

    if (message.id !== undefined) {
      const item = pending.get(message.id);

      if (item === undefined) return;
      if (message.error !== undefined) {
        const error = failure(Reasons.Provider.make({}));

        yield* Deferred.fail(item.reply, error);

        // A rejected acknowledgement also ends capture; its reply has no waiting caller.
        pending.delete(message.id);
        const target = item.sessionId === undefined ? undefined : targets.get(item.sessionId);

        if (item.acknowledgement && target !== undefined && !target.released && !target.detached)
          target.options.fail(error);

        return;
      }
      if (item.accept !== undefined) yield* item.accept(message.result);
      pending.delete(message.id);
      yield* Deferred.succeed(item.reply, message.result);

      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const detached = yield* decode(Attachment, message.params);
      const target = targets.get(detached.sessionId);

      if (target !== undefined) {
        target.detached = true;
        // Losing an observation attachment says nothing about the control Page's authority.
        if (!target.released) target.options.fail(failure(Reasons.Disconnected.make({})));
      }

      return;
    }
    const target = message.sessionId === undefined ? undefined : targets.get(message.sessionId);

    if (
      target === undefined ||
      target.released ||
      target.detached ||
      message.sessionId === undefined ||
      message.method === undefined
    )
      return;
    switch (message.method) {
      case "Page.screencastFrame": {
        const frame = yield* decode(ScreencastFrame, message.params);

        // Queue the small acknowledgement before handing the frame to bounded accounting.
        // Its response is consumed by the reader, without blocking the next navigation event.
        yield* write({
          method: "Page.screencastFrameAck",
          sessionId: message.sessionId,
          params: { sessionId: frame.sessionId },
        });
        target.options.receive({
          data: frame.data,
          timestamp: frame.metadata.timestamp * 1000,
          viewportWidth: frame.metadata.deviceWidth,
          viewportHeight: frame.metadata.deviceHeight,
        });

        return;
      }
      case "Page.frameNavigated": {
        const { frame } = yield* decode(Navigation, message.params);

        if (frame.parentId !== undefined || !target.opened) return;
        target.frameId = frame.id;
        if (target.options.document === undefined) target.options.invalidate("target-changed");
        else target.options.document(frame.url, false);

        return;
      }
      case "Page.navigatedWithinDocument": {
        const navigation = yield* decode(WithinDocument, message.params);

        if (target.opened && navigation.frameId === target.frameId)
          target.options.document?.(navigation.url, true);

        return;
      }
      case "Page.frameResized":
        target.options.invalidate("resized");

        return;
      default:
        return;
    }
  });

  const connect = yield* Effect.cached(
    Effect.gen(function* () {
      if (closing) return yield* failure(Reasons.Closed.make({}));

      const remaining = Math.ceil(
        options.deadline - Number(yield* Clock.monotonicTimeNanos) / 1_000_000,
      );

      if (remaining <= 0) return yield* failure(Reasons.Expired.make({}));

      const url = yield* options
        .connection(remaining)
        .pipe(Effect.flatMap((url) => options.resolve({ url })));

      if (closing) return yield* failure(Reasons.Closed.make({}));

      const socket = yield* Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.try({
            try: () => {
              if (closing) throw new Error("Observation connection is closed");
              const ws = options.constructor(url);

              ws.addEventListener(
                "close",
                () => {
                  Deferred.doneUnsafe(closed, Effect.void);
                },
                { once: true },
              );
              closeSocket = Effect.try({
                try: () => {
                  ws.close(1000);
                },
                catch: () => failure(),
              }).pipe(
                Effect.andThen(Deferred.await(closed)),
                Effect.timeoutOrElse({
                  duration: 1500,
                  orElse: () => Effect.fail(failure(Reasons.Timeout.make({}))),
                }),
              );

              return ws;
            },
            catch: () =>
              new Socket.SocketError({
                reason: new Socket.SocketOpenError({
                  kind: "Unknown",
                  cause: "Observation connection failed",
                }),
              }),
          }),
          (ws) =>
            Effect.sync(() => {
              ws.close(1000);
            }),
        ),
        { openTimeout: Math.min(remaining, 5000), highWaterMark: maxMessageBytes },
      );

      const pull = yield* Socket.readerString(socket).pipe(
        Scope.provide(scope),
        Effect.mapError(() => failure()),
      );

      writer = yield* socket.writer.pipe(Scope.provide(scope));
      // One bounded supervisor handles acknowledgement deadlines, including a stalled source
      // that stops producing frames before the finite pending-command capacity is reached.
      yield* Effect.forever(
        Effect.sleep(250).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const now = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;

              for (const [id, item] of pending) {
                if (item.deadline === undefined || item.deadline > now) continue;
                pending.delete(id);
                const error = failure(Reasons.Timeout.make({}));

                Deferred.doneUnsafe(item.reply, Effect.fail(error));
                const target =
                  item.sessionId === undefined ? undefined : targets.get(item.sessionId);

                if (target !== undefined && !target.released && !target.detached)
                  target.options.fail(error);
              }
            }),
          ),
        ),
      ).pipe(Effect.forkIn(scope));
      yield* Effect.forever(
        pull.pipe(
          Effect.mapError(() => failure()),
          Effect.flatMap((messages) => Effect.forEach(messages, dispatch, { discard: true })),
        ),
      ).pipe(
        Effect.catch((error) => (closing ? Effect.void : terminate(error))),
        Effect.catchCause(() =>
          closing ? Effect.void : terminate(failure(Reasons.Failed.make({}))),
        ),
        Effect.forkIn(scope),
      );
    }).pipe(Effect.tapError(terminate)),
  );

  const close = yield* Effect.cached(
    Effect.suspend(() => {
      closing = true;

      return closeSocket.pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );

  // Provider checked cleanup calls close first. This finalizer also covers failed acquisition.
  yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));

  const source = (capture: CaptureTarget): CaptureSource => {
    let attached: string | undefined;
    let state: Target | undefined;
    const isDetached = () => state?.detached === true;

    return {
      start: Effect.fnUntraced(function* (start: CaptureStart) {
        yield* connect;

        const value = yield* request({
          method: "Target.attachToTarget",
          params: { targetId: capture.targetId, flatten: true },
        });

        const attachment = yield* decode(Attachment, value).pipe(Effect.tapError(terminate));

        attached = attachment.sessionId;
        const target: Target = { options: start, opened: false, detached: false, released: false };

        state = target;
        targets.set(attached, target);
        yield* request({ method: "Page.enable", sessionId: attached });
        yield* request({ method: "Page.getFrameTree", sessionId: attached }, (value) =>
          decode(FrameTree, value).pipe(
            Effect.map(({ frameTree: { frame } }) => {
              target.frameId = frame.id;
              target.opened = true;
              start.opened?.(frame.url);
            }),
          ),
        );
        yield* request({
          method: "Page.startScreencast",
          sessionId: attached,
          params: {
            format: "jpeg",
            quality: start.quality,
            maxWidth: start.size?.width ?? 800,
            maxHeight: start.size?.height ?? 800,
          },
        });
      }),
      stop: Effect.gen(function* () {
        const sessionId = attached;

        if (terminal !== undefined) return yield* close;
        if (sessionId === undefined || isDetached()) return;
        // Detaching this observation attachment confirms the screencast ended even if the
        // page disappeared between the control owner's close and its observation stop.
        yield* request({ method: "Page.stopScreencast", sessionId }).pipe(Effect.exit);
        if (terminal !== undefined) return yield* close;
        if (isDetached()) return;
        if (state !== undefined) state.released = true;

        const detached = yield* request({
          method: "Target.detachFromTarget",
          params: { sessionId },
        }).pipe(Effect.exit);

        if (Exit.isFailure(detached) && !isDetached())
          return yield* Effect.failCause(detached.cause);
        targets.delete(sessionId);
      }),
      release: () => {
        if (state !== undefined) state.released = true;
        if (attached !== undefined) targets.delete(attached);
      },
    };
  };

  return { source, close };
});
