import type { GameEngine, GameKind, TruthEvent } from "./GameCore.ts";

/** Serialized into the frame; all dependencies are explicit arguments. */
export const gameClient = (engine: GameEngine, kind: GameKind) => {
  const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
  const context = canvas?.getContext("2d");

  if (canvas === null || context === null || context === undefined)
    throw new Error("Canvas unavailable");
  const labels = ["SUN", "MOON", "LEAF", "WAVE", "STAR", "GEM"];
  const colors = ["#ffd16a", "#9dbeff", "#8cdfaa", "#75e1e6", "#e6a5ff", "#ff8d9f"];
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

    context.fillStyle = "#111827";
    context.fillRect(0, 0, 960, 540);
    context.font = "bold 30px sans-serif";
    context.fillStyle = "#e5e7eb";
    context.fillText("ESTUARY REELS · DEMO", 32, 48);
    context.font = "18px sans-serif";
    context.fillText("Demo credits only", 32, 78);
    context.fillStyle = "#253047";
    context.fillRect(28, 95, 904, 326);
    for (let reel = 0; reel < 5; reel++) {
      for (let row = 0; row < 3; row++) {
        const moving = state.phase === "spinning" && reel >= state.stoppedReels;

        const symbol = moving
          ? (Math.floor(time / 75) + reel + row) % 6
          : (state.grid[reel]?.[row] ?? 0);

        const x = 44 + reel * 177;
        const y = 108 + row * 100;

        context.fillStyle = "#182235";
        context.fillRect(x, y, 164, 92);
        context.fillStyle = colors[symbol] ?? "white";
        context.font = "bold 25px sans-serif";
        context.fillText(labels[symbol] ?? "SUN", x + 32, y + 57);
      }
    }
    if (kind === "reels") {
      context.fillStyle = "#e5e7eb";
      context.font = "bold 23px sans-serif";
      context.fillText(`BALANCE ${state.balance}`, 32, 472);
      context.font = "18px sans-serif";
      context.fillText(`LAST WIN ${state.lastWin}`, 32, 507);
      context.fillText(`SPIN ${state.spin}`, 720, 425);
      context.fillStyle = "#3a4966";
      context.fillRect(340, 440, 60, 75);
      context.fillRect(490, 440, 60, 75);
      context.fillStyle = "white";
      context.font = "bold 30px sans-serif";
      context.fillText("−", 360, 488);
      context.fillText("+", 507, 488);
      context.font = "18px sans-serif";
      context.fillText(`BET ${state.bet}`, 410, 483);
      context.fillStyle = state.phase === "idle" ? "#1e9b71" : "#49566d";
      context.fillRect(700, 440, 230, 75);
      context.fillStyle = "white";
      context.font = "bold 30px sans-serif";
      context.fillText(
        state.phase === "idle" ? "SPIN" : state.phase === "spinning" ? "SPINNING" : "RESULT",
        747,
        488,
      );
    } else {
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
    if (state.banner !== null) {
      context.fillStyle = `rgba(250, 204, 21, ${0.83 + Math.sin(time / 90) * 0.12})`;
      context.fillRect(180, 200, 600, 115);
      context.fillStyle = "#111827";
      context.font = "bold 35px sans-serif";
      context.fillText(
        state.banner === "bonus" ? `BONUS! +${state.lastWin}` : `WIN! +${state.lastWin}`,
        305,
        272,
      );
    }
    requestAnimationFrame(paint);
  };

  requestAnimationFrame(paint);
};
