import { Effect } from "effect";
import * as Bootstrap from "effect-browserbase/bootstrap";

import { Call, PollMillis, Reply } from "./Cues.ts";
import { Director } from "./Director.ts";
import { Telemetry } from "./Telemetry.ts";

/**
 * The page's half of the performance: a drawn pointer, and a loop that asks the
 * host for its next cue.
 *
 * A screencast carries rendered pixels and the operating system's pointer is
 * not one of them, so footage without this shows controls changing under no
 * visible hand. Motion is played here, inside the page, because that is the
 * only place it can run at display rate; a host that sent one position per
 * round trip would film its own network latency.
 *
 * The script only draws and measures. It never clicks, types or navigates:
 * every change to the page remains one of the session's bounded actions.
 */

const BindingName = "footageCue";

/**
 * Kept as source text rather than a stringified function: a transpiler may
 * rewrite a function body to call helpers that do not exist in the page.
 */
const script = String.raw`(() => {
  if (window.top !== window || globalThis.__stagehand) return;

  const StorageKey = "__stagehand_pointer";
  const pointer = { x: Math.round(innerWidth * 0.62), y: Math.round(innerHeight * 0.58) };

  // The pointer keeps its place across same-origin navigations, as a real one does.
  try {
    const saved = JSON.parse(sessionStorage.getItem(StorageKey) ?? "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) Object.assign(pointer, saved);
  } catch {}

  const remember = () => {
    try { sessionStorage.setItem(StorageKey, JSON.stringify(pointer)); } catch {}
  };

  // A closed shadow root keeps the page's CSS out, and keeps the overlay out of
  // the page's own text, so observations and reads never see it.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = [
    "<style>",
    ".pointer{position:absolute;left:0;top:0;width:24px;height:24px;will-change:transform;",
    "filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}",
    ".pointer svg{position:absolute;left:0;top:0;width:24px;height:24px;display:none;",
    "transform-origin:var(--hot);transition:transform 90ms ease-out}",
    ".pointer[data-shape=arrow] .arrow,.pointer[data-shape=hand] .hand,.pointer[data-shape=text] .text{display:block}",
    ".pointer[data-pressed] svg{transform:scale(.84)}",
    ".ripple{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;",
    "background:rgba(255,255,255,.35);border:2px solid rgba(20,20,20,.55);animation:ripple 480ms ease-out forwards}",
    "@keyframes ripple{from{transform:scale(.25);opacity:1}to{transform:scale(1);opacity:0}}",
    ".caption{position:absolute;left:50%;bottom:22px;transform:translate(-50%,12px);opacity:0;",
    "max-width:70%;padding:10px 18px;border-radius:10px;background:rgba(17,17,17,.88);color:#fff;",
    "font:500 17px/1.35 system-ui,sans-serif;text-align:center;transition:opacity 260ms ease,transform 260ms ease}",
    ".caption[data-shown]{opacity:1;transform:translate(-50%,0)}",
    "</style>",
    "<div class=caption></div>",
    "<div class=pointer data-shape=arrow>",
    "<svg class=arrow style='--hot:0 0' viewBox='0 0 24 24'><path d='M3 2v17.2l4.6-4.4 3 7 2.9-1.2-3-6.9H17z' fill='#111' stroke='#fff' stroke-width='1.4' stroke-linejoin='round'/></svg>",
    "<svg class=hand style='--hot:9px 2px' viewBox='0 0 24 24'><path d='M9 2.8a1.7 1.7 0 0 1 1.7 1.7v6l.6-.1V9.3a1.6 1.6 0 0 1 3.2 0v1.4l.5-.1a1.6 1.6 0 0 1 3 .7v.6a1.6 1.6 0 0 1 2.7 1.2v3.6c0 3.2-2.3 5.6-5.6 5.6h-1.9c-2 0-3.5-.9-4.7-2.6l-3.3-4.8a1.6 1.6 0 0 1 2.5-2l1.6 1.7V4.5A1.7 1.7 0 0 1 9 2.8z' fill='#fff' stroke='#111' stroke-width='1.3' stroke-linejoin='round'/></svg>",
    "<svg class=text style='--hot:12px 12px' viewBox='0 0 24 24'><path d='M8 3h3a1 1 0 0 1 1 1 1 1 0 0 1 1-1h3M8 21h3a1 1 0 0 0 1-1 1 1 0 0 0 1 1h3M12 4v16' fill='none' stroke='#fff' stroke-width='3.4' stroke-linecap='round'/><path d='M8 3h3a1 1 0 0 1 1 1 1 1 0 0 1 1-1h3M8 21h3a1 1 0 0 0 1-1 1 1 0 0 0 1 1h3M12 4v16' fill='none' stroke='#111' stroke-width='1.5' stroke-linecap='round'/></svg>",
    "</div>",
  ].join("");

  const glyph = root.querySelector(".pointer");
  const caption = root.querySelector(".caption");
  const hotspots = { arrow: [0, 0], hand: [9, 2], text: [12, 12] };

  // The shape follows what the page says a pointer should look like there.
  const shapeAt = (x, y) => {
    const element = document.elementFromPoint(x, y);
    const wanted = element ? getComputedStyle(element).cursor : "auto";
    if (wanted === "pointer") return "hand";
    if (wanted === "text") return "text";
    return element && element.matches("input:not([type=button]):not([type=submit]),textarea") ? "text" : "arrow";
  };

  const draw = () => {
    const shape = shapeAt(pointer.x, pointer.y);
    const [hotX, hotY] = hotspots[shape];
    glyph.dataset.shape = shape;
    glyph.style.transform = "translate(" + (pointer.x - hotX) + "px," + (pointer.y - hotY) + "px)";
  };

  const mount = () => {
    if (!document.documentElement) return void requestAnimationFrame(mount);
    document.documentElement.append(host);
    draw();
  };
  mount();

  // Presses are drawn from the real input events, so a ripple on film is
  // evidence that the session's own click reached the page.
  addEventListener("mousedown", () => {
    glyph.dataset.pressed = "";
    const ripple = document.createElement("div");
    ripple.className = "ripple";
    ripple.style.left = pointer.x + "px";
    ripple.style.top = pointer.y + "px";
    ripple.addEventListener("animationend", () => ripple.remove());
    root.append(ripple);
  }, true);
  addEventListener("mouseup", () => setTimeout(() => delete glyph.dataset.pressed, 70), true);
  addEventListener("scroll", draw, { passive: true });
  addEventListener("pagehide", remember);

  const round = (value) => Math.round(value * 100) / 100;

  const stage = () => ({
    pointer: { x: round(pointer.x), y: round(pointer.y) },
    viewport: { width: innerWidth, height: innerHeight },
    scroll: {
      top: round(scrollY),
      maximumTop: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    },
  });

  // Plays a timed track against the animation clock, interpolating between samples.
  const play = (origin, samples, apply) => new Promise((resolve) => {
    const started = performance.now();
    let previous = { ...origin, atMillis: 0 };
    let index = 0;

    const frame = (now) => {
      const elapsed = now - started;
      while (index < samples.length && samples[index].atMillis <= elapsed) previous = samples[index++];
      if (index >= samples.length) return void (apply(previous), resolve());
      const next = samples[index];
      const span = next.atMillis - previous.atMillis;
      const mix = span <= 0 ? 1 : (elapsed - previous.atMillis) / span;
      const blended = {};
      for (const key of Object.keys(origin)) blended[key] = previous[key] + (next[key] - previous[key]) * mix;
      apply(blended);
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  });

  const perform = async (cue) => {
    switch (cue._tag) {
      case "Locate": {
        const element = document.querySelector(cue.selector);
        const rect = element ? element.getBoundingClientRect() : undefined;
        if (!rect || rect.width < 1 || rect.height < 1) return { _tag: "Missing", id: cue.id };
        const box = { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
        return { _tag: "Located", id: cue.id, box, stage: stage() };
      }
      case "Glide":
        await play({ x: pointer.x, y: pointer.y }, cue.path, (at) => { Object.assign(pointer, at); draw(); });
        remember();
        return { _tag: "Played", id: cue.id, stage: stage() };
      case "Scroll":
        await play({ top: scrollY }, cue.track, (at) => scrollTo({ top: at.top, behavior: "instant" }));
        return { _tag: "Played", id: cue.id, stage: stage() };
      case "Caption":
        if (cue.text) caption.textContent = cue.text;
        caption.toggleAttribute("data-shown", cue.text !== "");
        return { _tag: "Played", id: cue.id, stage: stage() };
      default:
        return { _tag: "Waiting", stage: stage() };
    }
  };

  const pause = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

  // An init script runs before the document has an element to measure.
  const parsed = new Promise((resolve) =>
    document.readyState === "loading" ? addEventListener("DOMContentLoaded", resolve, { once: true }) : resolve());

  const clockNow = () => performance.timeOrigin + performance.now();

  const attend = async () => {
    await parsed;
    let report = { _tag: "Waiting", stage: stage() };
    let clock;
    for (;;) {
      try {
        const pageSentMillis = clockNow();
        const reply = await globalThis[${JSON.stringify(BindingName)}](clock ? { report, clock } : { report });
        clock = {
          pageSentMillis,
          hostReceivedMillis: reply.hostReceivedMillis,
          hostRepliedMillis: reply.hostRepliedMillis,
          pageReceivedMillis: clockNow(),
        };
        report = await perform(reply.cue);
      } catch {
        // A rejected call means the host is busy or gone; ask again, slowly.
        await pause(250);
        report = { _tag: "Waiting", stage: stage() };
        clock = undefined;
      }
    }
  };

  const loaded = new Promise((resolve) =>
    document.readyState === "complete" ? resolve() : addEventListener("load", resolve, { once: true }));

  // Ready means the first frame is worth filming: laid out, with its real fonts.
  globalThis.__stagehand = loaded.then(() => document.fonts.ready).then(() => true);
  void attend();
})();`;

/**
 * The registrations one filmed session needs. `origins` are exact, as the
 * library requires: the stagehand exists only on the documents being filmed.
 * The handler's `Director` and `Telemetry` requirements stay visible on the plan
 * and are captured when the session is acquired.
 */
export const plan = (origins: ReadonlyArray<string>) =>
  Bootstrap.combine(
    Bootstrap.binding({
      name: BindingName,
      origins,
      input: Call,
      output: Reply,
      // A replaced document can leave one call behind while its successor starts another.
      maxConcurrent: 4,
      maxInputBytes: 4 * 1024,
      maxOutputBytes: 256 * 1024,
      timeoutMillis: PollMillis * 3,
      failureMode: "reject-call",
      handle: Effect.fnUntraced(function* (call) {
        const director = yield* Director;
        const telemetry = yield* Telemetry;
        const hostReceivedMillis = yield* telemetry.now;

        if (call.clock !== undefined) yield* telemetry.clock(call.clock);
        const cue = yield* director.exchange(call.report);

        return { cue, hostReceivedMillis, hostRepliedMillis: yield* telemetry.now };
      }),
    }),
    Bootstrap.init({
      id: "stagehand",
      origins,
      content: script,
      readiness: {
        expression: "globalThis.__stagehand",
        timeoutMillis: 15_000,
        existingDocuments: "RequireFreshNavigation",
      },
    }),
  );
