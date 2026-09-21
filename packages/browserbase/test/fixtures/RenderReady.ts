import { Effect, Option, Schedule, Schema } from "effect";

/**
 * A provider hands out a browser that can already draw; a freshly spawned Chromium cannot.
 *
 * Its DevTools port opens, and navigations commit, well before its GPU process can composite.
 * Measured on the pinned build, the first frame lands about 80ms after that process finishes
 * starting: 2-4ms after navigation on an idle host, over a second later on one loaded core,
 * and longer still on a starved runner. Screencast frames are compositor frames, so until then
 * no tab produces one and a capture interval opened in that gap honestly receives nothing.
 *
 * One screenshot of the initial tab is the narrowest proof that the whole pipeline draws. The
 * socket closes before the adapter connects, so this is never a second controller.
 */
export class RenderReadyError extends Schema.TaggedError<RenderReadyError>()("RenderReadyError", {
  step: Schema.Literals(["target", "socket", "screenshot", "timeout"]),
}) {}

const Targets = Schema.Array(
  Schema.Struct({ type: Schema.String, webSocketDebuggerUrl: Schema.optionalKey(Schema.String) }),
);

const Reply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Number),
    error: Schema.optionalKey(Schema.Unknown),
  }),
);

const screenshotRequest = JSON.stringify({
  id: 1,
  method: "Page.captureScreenshot",
  params: { format: "jpeg", quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } },
});

/** The initial tab can register a moment after the port opens, so an empty list is retried. */
const initialPage = (endpoint: string) =>
  Effect.tryPromise({
    try: () => globalThis.fetch(`${endpoint}/json/list`).then((response) => response.json()),
    catch: () => RenderReadyError.make({ step: "target" }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Targets)),
    Effect.map((targets) => targets.find((target) => target.type === "page")),
    Effect.flatMap((page) => Effect.fromNullishOr(page?.webSocketDebuggerUrl)),
    Effect.mapError(() => RenderReadyError.make({ step: "target" })),
    Effect.retry(Schedule.spaced(20)),
  );

const screenshot = (address: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new WebSocket(address)),
    (socket) =>
      Effect.callback<void, RenderReadyError>((resume) => {
        socket.onopen = () => socket.send(screenshotRequest);
        socket.onerror = () => resume(Effect.fail(RenderReadyError.make({ step: "socket" })));
        socket.onmessage = (event) => {
          const reply = Option.getOrUndefined(Schema.decodeUnknownOption(Reply)(event.data));

          if (reply?.id !== 1) return;
          resume(
            reply.error === undefined
              ? Effect.void
              : Effect.fail(RenderReadyError.make({ step: "screenshot" })),
          );
        };
      }),
    (socket) => Effect.sync(() => socket.close()),
  );

export const renderReady = (endpoint: string, budgetMillis: number) =>
  initialPage(endpoint).pipe(
    Effect.flatMap(screenshot),
    Effect.timeoutOrElse({
      duration: budgetMillis,
      orElse: () => Effect.fail(RenderReadyError.make({ step: "timeout" })),
    }),
  );
