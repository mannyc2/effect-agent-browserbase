import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect";
import type { CapturedFrame } from "effect-browser/capture";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import { Metrics, Telemetry } from "./Telemetry.ts";

/**
 * The same frames the camera films, shown to whoever is watching while the
 * session is still running.
 *
 * Each viewer is sent motion JPEG: every captured frame, as it arrives, as one
 * part of a `multipart/x-mixed-replace` response that an `<img>` plays with no
 * script. There is no encoder and no segmenting between the capture and the
 * viewer, so the only latency this adds is one write. A still page sends
 * nothing and the viewer keeps the last picture, which is the right answer for
 * a live view and the reason this needs no constant-rate step.
 *
 * An encoded stream (HLS, RTMP, WHIP) is the other shape. It does need
 * a constant rate, and it cannot wait for the page's next repaint to get one:
 * drive `Reel` from a clock, repeating the held picture every slot, and point
 * FFmpeg at a muxer instead of a file. That buys reach at the cost of seconds.
 */

const Boundary = "footage-frame";

const encoder = new TextEncoder();

/** One multipart part. Its headers let a scripted viewer date each frame on the browser's clock. */
const part = (frame: CapturedFrame) => {
  const head = encoder.encode(
    `--${Boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(frame.bytes.byteLength)}\r\n` +
      `X-Sequence: ${String(frame.sequence)}\r\nX-Source-Time-Millis: ${String(frame.sourceTimeMillis)}\r\n\r\n`,
  );

  const bytes = new Uint8Array(head.byteLength + frame.bytes.byteLength + 2);

  bytes.set(head, 0);
  bytes.set(frame.bytes, head.byteLength);
  bytes.set(encoder.encode("\r\n"), head.byteLength + frame.bytes.byteLength);

  return bytes;
};

const viewer = `<!doctype html><meta charset="utf-8"><title>Live · realistic footage</title>
<style>
body{margin:0;display:grid;grid-template-columns:1fr 320px;min-height:100vh;background:#0e1116;color:#e6e8eb;font:13px/1.5 ui-monospace,"DejaVu Sans Mono",monospace}
figure{margin:0;display:grid;place-items:center;padding:24px}
img{max-width:100%;max-height:calc(100vh - 48px);border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.6);background:#000}
aside{padding:24px;border-left:1px solid #232831;overflow:auto}
h1{margin:0 0 16px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#8b93a1}
h1 i{display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:#ff5a1f}
dl{display:grid;grid-template-columns:1fr auto;gap:6px 12px;margin:0 0 24px}
dt{color:#8b93a1}dd{margin:0;text-align:right}
p{color:#8b93a1}
</style>
<figure><img src="/live.mjpeg" alt="The filmed page, live"></figure>
<aside><h1><i></i>Live</h1><dl id="numbers"></dl>
<p>Latency is presentation in the browser to receipt on the filming host, corrected by a measured clock offset. The hop from that host to this page is yours to measure.</p></aside>
<script>
const ms = (value) => value === null || value === undefined ? "–" : value.toFixed(1) + " ms";
const spread = (d) => d ? ms(d.p50) + " / " + ms(d.p95) + " / " + ms(d.max) : "–";
const show = (rows) => numbers.replaceChildren(...rows.flatMap(([name, value]) => {
  const dt = document.createElement("dt"), dd = document.createElement("dd");
  dt.textContent = name; dd.textContent = value; return [dt, dd];
}));
setInterval(async () => {
  const m = await (await fetch("/metrics")).json();
  show([
    ["frames received", String(m.capture.frames)],
    ["frames / second", m.capture.framesPerSecond ? m.capture.framesPerSecond.toFixed(1) : "–"],
    ["capture latency p50/p95/max", spread(m.capture.latencyMillis)],
    ["clock offset", m.capture.clock ? ms(m.capture.clock.offsetMillis) + " ± " + ms(m.capture.clock.uncertaintyMillis) : "measuring"],
    ["frame gap p50/p95/max", spread(m.capture.interFrameMillis)],
    ["takes", String(m.takes.length + 1)],
    ["discarded here", String(m.takes.reduce((sum, take) => sum + take.discarded, 0))],
    ["uncovered at cuts", m.uncoveredMillis.map(ms).join(", ") || "–"],
    ["cue round trip p50/p95/max", spread(m.control.cueRoundTripMillis)],
    ["click to next frame", spread(m.control.clickToFrameMillis)],
    ...Object.entries(m.control.actionMillis).map(([kind, d]) => [kind + " p50/p95/max", spread(d)]),
  ]);
}, 500);
</script>`;

export class Broadcast extends Context.Service<
  Broadcast,
  {
    readonly publish: (frame: CapturedFrame) => Effect.Effect<void>;
    /** Where to watch, or `null` when nothing is being served. */
    readonly url: string | null;
    readonly viewers: Effect.Effect<number>;
  }
>()("effect-browserbase/examples/realistic-footage/Broadcast") {
  /** Film to a file only. */
  static readonly silent = Layer.succeed(
    Broadcast,
    Broadcast.of({ publish: () => Effect.void, url: null, viewers: Effect.succeed(0) }),
  );

  /**
   * Serve the live view. Port `0` takes any free port. The host defaults to
   * loopback: a filmed page may show anything the session can see, so reaching
   * it from elsewhere should be a tunnel someone chose to open.
   */
  static readonly layer = (options: { readonly port: number; readonly host?: string }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        // A viewer slower than the capture skips frames rather than queueing them, and a new
        // viewer is shown the current picture without waiting for the page to repaint.
        const frames = yield* PubSub.sliding<CapturedFrame>({ capacity: 2, replay: 1 });
        const viewers = yield* Ref.make(0);

        const live = Stream.fromPubSub(frames).pipe(
          Stream.map(part),
          Stream.onStart(Ref.update(viewers, (count) => count + 1)),
          Stream.ensuring(Ref.update(viewers, (count) => count - 1)),
        );

        const routes = Layer.mergeAll(
          HttpRouter.add("GET", "/", HttpServerResponse.html(viewer)),
          HttpRouter.add(
            "GET",
            "/live.mjpeg",
            HttpServerResponse.stream(live, {
              contentType: `multipart/x-mixed-replace; boundary=${Boundary}`,
              headers: { "cache-control": "no-store" },
            }),
          ),
          HttpRouter.add(
            "GET",
            "/metrics",
            Effect.flatMap(telemetry.metrics, HttpServerResponse.schemaJson(Metrics)).pipe(
              Effect.orDie,
            ),
          ),
        );

        return Layer.effect(
          Broadcast,
          Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer;

            return Broadcast.of({
              publish: (frame) => Effect.asVoid(PubSub.publish(frames, frame)),
              url: HttpServer.formatAddress(server.address),
              viewers: Ref.get(viewers),
            });
          }),
        ).pipe(
          // Its own router: the filmed site may be served from this same program.
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
