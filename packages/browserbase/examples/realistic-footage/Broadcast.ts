import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Deferred, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";
import * as Capture from "effect-browser/capture";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import type { View } from "./Presentation.ts";
import { Metrics, Telemetry } from "./Telemetry.ts";

/**
 * The same frames the camera films, shown to whoever is watching while the
 * session is still running.
 *
 * Each viewer is sent motion JPEG: every captured frame, as it arrives, as one
 * part of a `multipart/x-mixed-replace` response that an `<img>` plays with no
 * script (`Capture.multipart`). There is no encoder and no segmenting between
 * the capture and the viewer, so the only latency this adds is one write. A
 * still page sends nothing and the viewer keeps the last picture, which is the
 * right answer for a live view and the reason this needs no constant-rate step.
 *
 * An encoded stream (HLS, RTMP, WHIP) is the other shape. It does need
 * a constant rate, and it cannot wait for the page's next repaint to get one:
 * drive `Reel` from a clock, repeating the held picture every slot, and point
 * FFmpeg at a muxer instead of a file. That buys reach at the cost of seconds.
 */

const viewer = `<!doctype html><meta charset="utf-8"><title>Live · realistic footage</title>
<style>
body{margin:0;display:grid;grid-template-columns:1fr 320px;min-height:100vh;background:#0e1116;color:#e6e8eb;font:13px/1.5 ui-monospace,"DejaVu Sans Mono",monospace}
figure{margin:0;display:grid;place-items:center;padding:24px}
.stage{position:relative;max-width:100%;line-height:0}#artwork{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}#caption{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);font:20px/1.4 sans-serif;text-align:center;background:#111c;padding:8px 16px;border-radius:6px;max-width:90%}#caption:empty{display:none}#qualification{font-size:11px}#pulse{transition:opacity .35s;opacity:0}
img{max-width:100%;max-height:calc(100vh - 48px);border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.6);background:#000}
aside{padding:24px;border-left:1px solid #232831;overflow:auto}
h1{margin:0 0 16px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#8b93a1}
h1 i{display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:#ff5a1f}
dl{display:grid;grid-template-columns:1fr auto;gap:6px 12px;margin:0 0 24px}
dt{color:#8b93a1}dd{margin:0;text-align:right}
p{color:#8b93a1}
</style>
<figure><div class="stage"><img id="picture" src="/live.mjpeg" alt="The filmed page, live"><svg id="artwork"><circle id="pulse" r="15" fill="none" stroke="#ff5a1f" stroke-width="2"/><path id="cursor" d="M0 0L0 25L7 18L13 28L17 26L11 16L21 16Z" fill="white" stroke="#111" stroke-width="1.5"/></svg><div id="caption"></div></div></figure>
<aside><h1><i></i>Live</h1><dl id="numbers"></dl>
<p id="qualification">Pointer position unknown</p><p>Latency is presentation in the browser to receipt on the filming host, corrected by a measured clock offset. The hop from that host to this page is yours to measure.</p></aside>
<script>
const ms = (value) => value === null || value === undefined ? "–" : value.toFixed(1) + " ms";
const spread = (d) => d ? ms(d.p50) + " / " + ms(d.p95) + " / " + ms(d.max) : "–";
let motion = 0, glideId = null, pulseTimer;
const place = p => { cursor.setAttribute("transform", "translate(" + p.x + " " + p.y + ")"); cursor.style.display = ""; };
const source = new EventSource("/presentation");
source.onmessage = event => {
  const v = JSON.parse(event.data), nextGlide = v.glide ? v.glide.id : null;
  const changed = nextGlide !== glideId;
  if (changed) { glideId = nextGlide; motion++; }
  const token = motion;
  if (v.viewport) artwork.setAttribute("viewBox", "0 0 " + v.viewport.width + " " + v.viewport.height);
  caption.textContent = v.caption;
  qualification.textContent = v.qualification === "intended-aim" ? "Pointer and press marker show intended aim" : v.qualification === "commanded-point" ? "Pointer shows commanded native point" : "Pointer position unknown";
  if (!v.glide || changed) { if (v.cursor) place(v.cursor); else cursor.style.display = "none"; }
  clearTimeout(pulseTimer);
  pulse.style.opacity = 0;
  if (v.pulse) { pulse.setAttribute("cx", v.pulse.position.x); pulse.setAttribute("cy", v.pulse.position.y); pulse.style.opacity = 1; pulseTimer = setTimeout(() => { pulse.style.opacity = 0; }, v.pulse.remainingMillis); }
  if (changed && v.glide && v.glide.samples.length) {
    const began = performance.now() + v.glide.delayMillis, points = v.glide.samples;
    const draw = () => {
      if (token !== motion) return;
      const elapsed = performance.now() - began;
      let index = 0;
      while (index + 1 < points.length && points[index + 1].afterMillis <= elapsed) index++;
      const a = points[index], b = points[Math.min(points.length - 1, index + 1)];
      const u = Math.max(0, Math.min(1, (elapsed - a.afterMillis) / Math.max(1, b.afterMillis - a.afterMillis)));
      place({x:a.position.x + (b.position.x-a.position.x)*u, y:a.position.y + (b.position.y-a.position.y)*u});
      if (elapsed < points[points.length-1].afterMillis) requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }
};
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
    ["documents", String(m.documents.length)],
    ["held at navigations", m.documents.flatMap((d) => d.heldMillis === null ? [] : [ms(d.heldMillis)]).join(", ") || "–"],
    ["discarded here", m.capture.interval ? String(m.capture.interval.discarded) : "–"],
    ["native return to next frame", spread(m.control.nativeReturnToNextFrameMillis)],
    ["timeline graphics / metrics gaps", m.control.timeline.gaps.graphics + " / " + m.control.timeline.gaps.metrics],
    ...Object.entries(m.control.actionMillis).map(([kind, d]) => [kind + " p50/p95/max", spread(d)]),
  ]);
}, 500);
</script>`;

const AudienceMetrics = Schema.Struct({
  ...Metrics.fields,
  documents: Schema.Array(
    Schema.Struct({
      document: Schema.Int,
      committedAtMillis: Schema.NullOr(Schema.Finite),
      heldMillis: Schema.NullOr(Schema.Finite),
    }),
  ),
});

interface PublishedView {
  readonly view: View;
  readonly publishedAtMillis: number;
}

export class Broadcast extends Context.Service<
  Broadcast,
  {
    readonly publish: (frame: Capture.CapturedFrame) => Effect.Effect<void>;
    readonly present: (view: View) => Effect.Effect<void>;
    /** Where to watch, or `null` when nothing is being served. */
    readonly url: string | null;
    readonly viewers: Effect.Effect<number>;
  }
>()("effect-browserbase/examples/realistic-footage/Broadcast") {
  /** Film to a file only. */
  static readonly silent = Layer.succeed(
    Broadcast,
    Broadcast.of({
      publish: () => Effect.void,
      present: () => Effect.void,
      url: null,
      viewers: Effect.succeed(0),
    }),
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
        const frames = yield* PubSub.sliding<Capture.CapturedFrame>({ capacity: 2, replay: 1 });
        const artwork = yield* PubSub.sliding<PublishedView>({ capacity: 2, replay: 1 });
        const viewers = yield* Ref.make(0);

        // A server waits for its open responses, so each one ends before it stops.
        const closing = yield* Deferred.make<void>();

        const live = Effect.map(
          Capture.multipart(
            Stream.fromPubSub(frames).pipe(
              Stream.onStart(Ref.update(viewers, (count) => count + 1)),
              Stream.ensuring(Ref.update(viewers, (count) => count - 1)),
              Stream.interruptWhen(Deferred.await(closing)),
            ),
          ),
          ({ contentType, body }) =>
            HttpServerResponse.stream(body, {
              contentType,
              headers: { "cache-control": "no-store" },
            }),
        );

        const routes = Layer.mergeAll(
          HttpRouter.add("GET", "/", HttpServerResponse.html(viewer)),
          HttpRouter.add("GET", "/live.mjpeg", Effect.orDie(live)),
          HttpRouter.add(
            "GET",
            "/presentation",
            HttpServerResponse.stream(
              Stream.fromPubSub(artwork).pipe(
                Stream.mapEffect(({ view, publishedAtMillis }) =>
                  Effect.gen(function* () {
                    const elapsed = Math.max(0, (yield* telemetry.now) - publishedAtMillis);
                    const remainingMillis = (view.pulse?.remainingMillis ?? 0) - elapsed;

                    const delivered: View = {
                      ...view,
                      glide:
                        view.glide === null
                          ? null
                          : { ...view.glide, delayMillis: view.glide.delayMillis - elapsed },
                      pulse:
                        view.pulse === null || remainingMillis <= 0
                          ? null
                          : { ...view.pulse, remainingMillis },
                    };

                    return new TextEncoder().encode(`data: ${JSON.stringify(delivered)}\n\n`);
                  }),
                ),
                Stream.interruptWhen(Deferred.await(closing)),
              ),
              { contentType: "text/event-stream", headers: { "cache-control": "no-store" } },
            ),
          ),
          HttpRouter.add(
            "GET",
            "/metrics",
            Effect.flatMap(telemetry.metrics, (metrics) =>
              HttpServerResponse.schemaJson(AudienceMetrics)({
                ...metrics,
                documents: metrics.documents.map(({ document, committedAtMillis, heldMillis }) => ({
                  document,
                  committedAtMillis,
                  heldMillis,
                })),
              }),
            ).pipe(Effect.orDie),
          ),
        );

        return Layer.effect(
          Broadcast,
          Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer;

            yield* Effect.addFinalizer(() => Deferred.succeed(closing, undefined));

            return Broadcast.of({
              publish: (frame) => Effect.asVoid(PubSub.publish(frames, frame)),
              present: (view) =>
                Effect.flatMap(telemetry.now, (publishedAtMillis) =>
                  Effect.asVoid(PubSub.publish(artwork, { view, publishedAtMillis })),
                ),
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
