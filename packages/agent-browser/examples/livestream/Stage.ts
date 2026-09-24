import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect";
import * as Capture from "effect-browser/capture";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import { viewer } from "./Viewer.ts";

/** What viewers are shown beside the picture, as of the moment on air. */
export interface OnAir {
  /** Origin and path only: a query or fragment can carry a token. */
  readonly address: string | null;
  readonly title: string | null;
  readonly caption: string | null;
}

/**
 * Where viewers watch. Each viewer gets its own motion-JPEG response and event stream over one
 * fan-out, so a slow viewer skips pictures without slowing the browser or another viewer, and a
 * new one is shown the current picture and state at once. Nothing but pictures and `OnAir`
 * reaches a viewer: no session, page or target identifier.
 */
export class Stage extends Context.Service<
  Stage,
  {
    /** Where to watch. */
    readonly url: string;
    readonly show: (frame: Capture.CapturedFrame) => Effect.Effect<void>;
    readonly update: (change: Partial<OnAir>) => Effect.Effect<void>;
  }
>()("effect-agent-browser/examples/livestream/Stage") {
  /**
   * Serve viewers on loopback by default; port `0` takes any free port. The filmed browser may
   * show anything the session can see, so reaching it from elsewhere is a choice to make.
   */
  static readonly layer = (options: { readonly port: number; readonly host?: string }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const pictures = yield* PubSub.sliding<Capture.CapturedFrame>({ capacity: 2, replay: 1 });
        const states = yield* PubSub.sliding<OnAir>({ capacity: 8, replay: 1 });
        // A server waits for its open responses, so they end first.
        const closing = yield* Deferred.make<void>();

        const live = Effect.map(
          Capture.multipart(Stream.fromPubSub(pictures)),
          ({ contentType, body }) =>
            HttpServerResponse.stream(body.pipe(Stream.interruptWhen(Deferred.await(closing))), {
              contentType,
              headers: { "cache-control": "no-store" },
            }),
        );

        const initial: OnAir = { address: null, title: null, caption: null };
        const current = yield* Ref.make(initial);

        // A viewer that joins is replayed the latest state, then follows it.
        yield* PubSub.publish(states, initial);

        const events = Stream.fromPubSub(states).pipe(
          Stream.map((state): Sse.Event => ({
            _tag: "Event",
            event: "state",
            id: undefined,
            data: JSON.stringify(state),
          })),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
          Stream.interruptWhen(Deferred.await(closing)),
        );

        const routes = Layer.mergeAll(
          HttpRouter.add("GET", "/", HttpServerResponse.html(viewer)),
          HttpRouter.add("GET", "/live.mjpeg", Effect.orDie(live)),
          HttpRouter.add(
            "GET",
            "/events",
            HttpServerResponse.stream(events, {
              contentType: "text/event-stream",
              headers: { "cache-control": "no-store" },
            }),
          ),
        );

        return Layer.effect(
          Stage,
          Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer;

            yield* Effect.addFinalizer(() => Deferred.succeed(closing, undefined));

            return Stage.of({
              url: HttpServer.formatAddress(server.address),
              show: (frame) => Effect.asVoid(PubSub.publish(pictures, frame)),
              update: (change) =>
                Ref.updateAndGet(current, (state) => ({ ...state, ...change })).pipe(
                  Effect.flatMap((state) => PubSub.publish(states, state)),
                  Effect.asVoid,
                ),
            });
          }),
        ).pipe(
          Layer.provideMerge(
            Layer.fresh(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true })),
          ),
          Layer.provide(
            NodeHttpServer.layer(createServer, {
              host: options.host ?? "127.0.0.1",
              port: options.port,
            }),
          ),
        );
      }),
    );
}
