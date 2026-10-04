import type { createGameArtwork } from "./GameArtwork.ts";
import type { GameEngine, GameKind, TruthEvent } from "./GameCore.ts";

/** Serialized into the frame; all dependencies are explicit arguments. */
export const gameClient = (
  engine: GameEngine,
  kind: GameKind,
  artwork: typeof createGameArtwork,
) => {
  const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
  const context = canvas?.getContext("2d");

  if (canvas === null || context === null || context === undefined)
    throw new Error("Canvas unavailable");
  const draw = artwork(canvas);
  let sequence = 0;
  let delivery = Promise.resolve();
  let deliveryFailures = 0;

  const report = (event: TruthEvent) => {
    const body = JSON.stringify({ kind, sequence: ++sequence, event });

    delivery = delivery
      .then(async () => {
        const response = await fetch("/truth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(2000),
        });

        if (!response.ok) throw new Error(`Truth delivery failed: ${response.status}`);
      })
      .catch(() => {
        // This event is never retried: a lost response may have followed an accepted mutation.
        // Resolve the queue so later, independent reports are still attempted and can expose gaps.
        deliveryFailures++;
      });
  };

  const flush = () => {
    for (const event of engine.drainEvents()) report(event);
  };

  const spin = () => {
    engine.startSpin(performance.now());
    flush();
  };

  const changeBet = (delta: number) => {
    engine.changeBet(delta, performance.now());
    flush();
  };

  canvas.addEventListener("focus", () => {
    report({ tag: "focus", spin: engine.state().spin, atMillis: performance.now(), focused: true });
  });
  canvas.addEventListener("blur", () => {
    report({
      tag: "focus",
      spin: engine.state().spin,
      atMillis: performance.now(),
      focused: false,
    });
  });
  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    if (kind !== "reels") return;
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) * 960) / bounds.width;
    const y = ((event.clientY - bounds.top) * 540) / bounds.height;

    if (y >= 440 && y <= 515) {
      if (x >= 700 && x <= 930) spin();
      else if (x >= 340 && x <= 400) changeBet(-1);
      else if (x >= 490 && x <= 550) changeBet(1);
    }
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.code === "Space" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      if (event.repeat) return;
      if (event.code === "Space") spin();
      else changeBet(event.key === "ArrowUp" ? 1 : -1);
    }
  });
  document.querySelector("#spin")?.addEventListener("click", spin);
  document.querySelector("#bet-up")?.addEventListener("click", () => changeBet(1));
  document.querySelector("#bet-down")?.addEventListener("click", () => changeBet(-1));
  Object.assign(window, {
    __fixture: { state: engine.state, deliveryFailures: () => deliveryFailures },
  });
  report({ tag: "ready", spin: 0, atMillis: performance.now() });
  canvas.focus();
  let paintedIdle: string | undefined;

  const paint = (time: number) => {
    engine.advance(time);
    flush();
    const state = engine.state();
    const status = document.querySelector("#result-status");

    const statusText =
      state.notable === null
        ? state.phase === "spinning"
          ? "Spinning"
          : "Ready"
        : `Notable: ${state.notable}`;

    if (status !== null && status.textContent !== statusText) status.textContent = statusText;

    const idlePicture = state.phase === "idle" ? `${state.spin}:${state.bet}` : undefined;

    // Repainting an identical cached scene still sends native screencast frames. Keep idle
    // pictures in place instead of exhausting retention with unchanged decorative pixels.
    if (idlePicture === undefined || idlePicture !== paintedIdle) draw(state, time, kind);
    paintedIdle = idlePicture;
    if (kind === "reels-dom") {
      for (const [selector, value] of [
        ["#balance", `Balance: ${state.balance} demo credits`],
        ["#bet", `Bet: ${state.bet}`],
        ["#last-win", `Last win: ${state.lastWin}`],
        ["#phase", state.phase],
      ]) {
        const element = document.querySelector(selector ?? "");

        if (element !== null && element.textContent !== value) element.textContent = value ?? "";
      }
      for (const button of document.querySelectorAll<HTMLButtonElement>("button"))
        if (button.disabled !== (state.phase !== "idle")) button.disabled = state.phase !== "idle";
    }
    requestAnimationFrame(paint);
  };

  requestAnimationFrame(paint);
};
