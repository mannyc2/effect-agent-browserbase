import { Schema } from "effect";
import type { Frame, JSHandle } from "playwright-core";

import { Reasons } from "../../Errors.ts";
import type { SettledEvidence, SettledOptions } from "../../PlanData.ts";
import { failure, safeDecode, sanitize } from "./NativeCalls.ts";
import type { WaitTicket } from "./Owner.ts";

const Evidence = Schema.Struct({
  quietMillis: Schema.Finite,
  withinMillis: Schema.Finite,
  observedMillis: Schema.Finite,
  signals: Schema.Tuple([
    Schema.Literal("dom-mutation"),
    Schema.Literal("scroll"),
    Schema.Literal("root-geometry"),
    Schema.Literal("viewport"),
  ]),
  samples: Schema.Natural,
  mutations: Schema.Natural,
  scrollChanges: Schema.Natural,
  geometryChanges: Schema.Natural,
  viewportChanges: Schema.Natural,
  visibility: Schema.Literals(["visible", "hidden"]),
});

const Reply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("quiet"), evidence: Evidence }),
  Schema.Struct({ status: Schema.Literals(["timeout", "interrupted", "stale", "malformed"]) }),
]);

type NativeReply = typeof Reply.Type;

interface QuietObserver {
  readonly completed: Promise<NativeReply>;
  readonly stop: () => void;
}

/**
 * One self-contained observer in the pinned document. Geometry means the root and scrolling
 * element's box and dimensions; it does not measure every descendant animation or painted pixel.
 * Timers work without requestAnimationFrame, including when the document is hidden. Browser
 * throttling can still prevent positive quiet evidence before the original host deadline.
 */
const observeQuiet = (
  options: SettledOptions & { readonly maximumMillis: number },
): QuietObserver => {
  const originalDocument = document;
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const started = performance.now();
  let changed = started;
  let done = false;
  let timer: number | undefined;
  let observer: MutationObserver | undefined;
  let samples = 1;
  let mutations = 0;
  let scrollChanges = 0;
  let geometryChanges = 0;
  let viewportChanges = 0;
  let complete: (reply: NativeReply) => void = () => {};

  const completed = new Promise<NativeReply>((resolve) => {
    complete = resolve;
  });

  const valid = () =>
    document === originalDocument && document.documentElement === root && root.isConnected;

  const increment = (count: number, amount = 1) =>
    Math.min(Number.MAX_SAFE_INTEGER, count + amount);

  const mark = () => {
    changed = performance.now();
  };

  const scroll = () => {
    scrollChanges = increment(scrollChanges);
    mark();
  };

  const resize = () => {
    viewportChanges = increment(viewportChanges);
    mark();
  };

  const geometry = () => {
    const rectangle = root.getBoundingClientRect();
    const scrolling = document.scrollingElement ?? root;

    return [
      rectangle.x,
      rectangle.y,
      rectangle.width,
      rectangle.height,
      root.clientWidth,
      root.clientHeight,
      root.scrollWidth,
      root.scrollHeight,
      scrolling.clientWidth,
      scrolling.clientHeight,
      scrolling.scrollWidth,
      scrolling.scrollHeight,
    ];
  };

  const scrollPosition = () => {
    const scrolling = document.scrollingElement ?? root;

    return [window.scrollX, window.scrollY, scrolling.scrollLeft, scrolling.scrollTop];
  };

  const viewportMetrics = () => [
    window.innerWidth,
    window.innerHeight,
    window.devicePixelRatio,
    viewport?.width ?? window.innerWidth,
    viewport?.height ?? window.innerHeight,
    viewport?.offsetLeft ?? 0,
    viewport?.offsetTop ?? 0,
    viewport?.scale ?? 1,
  ];

  let previousGeometry = geometry();
  let previousScroll = scrollPosition();
  let previousViewport = viewportMetrics();

  const cleanup = () => {
    observer?.disconnect();
    window.clearTimeout(timer);
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pagehide", pageHide);
    viewport?.removeEventListener("resize", resize);
    viewport?.removeEventListener("scroll", resize);
    document.removeEventListener("visibilitychange", mark);
  };

  const finish = (reply: NativeReply) => {
    if (done) return;
    done = true;
    cleanup();
    complete(reply);
  };

  const pageHide = () => finish({ status: "stale" });

  const differs = (next: ReadonlyArray<number>, previous: ReadonlyArray<number>) =>
    next.some((value, index) => value !== previous[index]);

  const sample = () => {
    if (done) return;
    try {
      if (!valid()) {
        finish({ status: "stale" });

        return;
      }
      const now = performance.now();

      if (now - started >= options.maximumMillis) {
        finish({ status: "timeout" });

        return;
      }
      const nextGeometry = geometry();
      const nextScroll = scrollPosition();
      const nextViewport = viewportMetrics();

      samples = increment(samples);
      if (differs(nextGeometry, previousGeometry)) {
        geometryChanges = increment(geometryChanges);
        changed = now;
      }
      if (differs(nextScroll, previousScroll)) {
        scrollChanges = increment(scrollChanges);
        changed = now;
      }
      if (differs(nextViewport, previousViewport)) {
        viewportChanges = increment(viewportChanges);
        changed = now;
      }
      previousGeometry = nextGeometry;
      previousScroll = nextScroll;
      previousViewport = nextViewport;
      if (now - changed >= options.quietMillis) {
        finish({
          status: "quiet",
          evidence: {
            quietMillis: options.quietMillis,
            withinMillis: options.withinMillis,
            observedMillis: now - started,
            signals: ["dom-mutation", "scroll", "root-geometry", "viewport"],
            samples,
            mutations,
            scrollChanges,
            geometryChanges,
            viewportChanges,
            visibility: document.visibilityState === "visible" ? "visible" : "hidden",
          },
        });

        return;
      }
      timer = window.setTimeout(
        sample,
        Math.max(
          1,
          Math.min(
            25,
            options.quietMillis - (now - changed),
            options.maximumMillis - (now - started),
          ),
        ),
      );
    } catch {
      finish({ status: "malformed" });
    }
  };

  observer = new MutationObserver((records) => {
    mutations = increment(mutations, records.length);
    mark();
    if (!valid()) finish({ status: "stale" });
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  window.addEventListener("scroll", scroll, true);
  window.addEventListener("resize", resize);
  window.addEventListener("pagehide", pageHide);
  viewport?.addEventListener("resize", resize);
  viewport?.addEventListener("scroll", resize);
  document.addEventListener("visibilitychange", mark);
  timer = window.setTimeout(
    sample,
    Math.max(1, Math.min(25, options.quietMillis, options.maximumMillis)),
  );

  return { completed, stop: () => finish({ status: "interrupted" }) };
};

/**
 * Whether the observer's own execution context still answers. Its document being replaced or its
 * frame detached ends that context, and with it every timer and listener the observer owned.
 */
const answers = (handle: JSHandle<QuietObserver>): Promise<boolean> =>
  handle
    .evaluate(() => true)
    .then(
      () => true,
      () => false,
    );

export interface SettledResource {
  readonly wait: () => Promise<SettledEvidence>;
  readonly check: () => void;
  readonly dispose: () => Promise<void>;
}

/** The existing one-Page wait owner retains capacity until this exact resource is disposed. */
export const makeSettledResource = (
  frame: Frame,
  ticket: WaitTicket,
  options: SettledOptions,
): SettledResource => {
  let setup: Promise<JSHandle<QuietObserver>> | undefined;
  let waiting: Promise<SettledEvidence> | undefined;
  let disposal: Promise<void> | undefined;

  const check = () => {
    ticket.check();
    if (frame.isDetached()) throw failure(Reasons.Stale.make({}), "undispatched");
  };

  const dispose = (): Promise<void> => {
    disposal ??= sanitize(async () => {
      ticket.signal.removeEventListener("abort", abort);
      const pending = setup;

      if (pending === undefined) return;
      const handle = await pending;

      try {
        await handle.evaluate((resource) => resource.stop());
      } catch (error) {
        // A context that no longer answers took the observer with it: disposal is confirmed.
        if (await answers(handle)) throw error;
      } finally {
        await handle.dispose();
      }
    });

    return disposal;
  };

  const abort = () => {
    // Observe teardown even if its caller has left. The raw wait's finally awaits the same
    // Promise and refuses retirement on failure; this observer never fabricates disposal.
    void dispose().catch(() => undefined);
  };

  ticket.signal.addEventListener("abort", abort, { once: true });
  if (ticket.signal.aborted) abort();

  return {
    check,
    dispose,
    wait: () => {
      waiting ??= sanitize(async () => {
        check();
        if (disposal !== undefined) throw failure(Reasons.Interrupted.make({}), "undispatched");
        setup = frame.evaluateHandle(observeQuiet, {
          ...options,
          maximumMillis: Math.min(options.withinMillis, ticket.remainingMillis()),
        });
        const handle = await setup;

        check();

        const reply = safeDecode(
          Reply,
          await handle
            .evaluate((resource) => resource.completed)
            .catch(async (error: unknown) => {
              // The observed document was replaced before it could report its own pagehide.
              if (!(await answers(handle))) throw failure(Reasons.Stale.make({}), "undispatched");
              throw error;
            }),
        );

        check();
        switch (reply.status) {
          case "quiet":
            return reply.evidence;
          case "timeout":
            throw failure(Reasons.Timeout.make({}), "undispatched");
          case "interrupted":
            throw failure(Reasons.Interrupted.make({}), "undispatched");
          case "stale":
            throw failure(Reasons.Stale.make({}), "undispatched");
          case "malformed":
            throw failure(Reasons.Malformed.make({}), "undispatched");
        }
      });

      return waiting;
    },
  };
};
