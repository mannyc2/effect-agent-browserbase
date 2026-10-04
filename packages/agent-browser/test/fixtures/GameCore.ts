import { Schema } from "effect";

export const GameKind = Schema.Literals(["reels", "reels-dom"]);
export type GameKind = typeof GameKind.Type;

export const GameMoment = Schema.Literals([
  "ordinary",
  "near-miss",
  "big-win",
  "bonus",
  "losing-streak",
]);

export type GameMoment = typeof GameMoment.Type;

export const GameState = Schema.Struct({
  phase: Schema.Literals(["idle", "spinning", "result"]),
  spin: Schema.Int,
  bet: Schema.Int,
  balance: Schema.Int,
  grid: Schema.Array(Schema.Array(Schema.Int)),
  lastWin: Schema.Int,
  stoppedReels: Schema.Int,
  banner: Schema.NullOr(GameMoment),
  notable: Schema.NullOr(GameMoment),
});

export type GameState = typeof GameState.Type;

const common = { spin: Schema.Int, atMillis: Schema.Finite };

const result = {
  grid: Schema.Array(Schema.Array(Schema.Int)),
  win: Schema.Int,
  balanceAfter: Schema.Int,
  moment: GameMoment,
};

export const TruthEvent = Schema.Union([
  Schema.Struct({ ...common, tag: Schema.Literal("ready") }),
  Schema.Struct({ ...common, tag: Schema.Literal("focus"), focused: Schema.Boolean }),
  Schema.Struct({
    ...common,
    tag: Schema.Literal("spinStart"),
    bet: Schema.Int,
    balanceAfter: Schema.Int,
    durationMillis: Schema.Int,
  }),
  Schema.Struct({ ...common, tag: Schema.Literal("reelStop"), reel: Schema.Int }),
  Schema.Struct({ ...common, tag: Schema.Literal("result"), ...result }),
  Schema.Struct({ ...common, tag: Schema.Literal("betChange"), bet: Schema.Int }),
  Schema.Struct({ ...common, tag: Schema.Literal("bannerShown"), moment: GameMoment }),
  Schema.Struct({ ...common, tag: Schema.Literal("bannerHidden") }),
  Schema.Struct({ ...common, tag: Schema.Literal("idle") }),
]);

export type TruthEvent = typeof TruthEvent.Type;

export interface ReelOutcome {
  readonly grid: ReadonlyArray<ReadonlyArray<number>>;
  readonly win: number;
  readonly moment: GameMoment;
  readonly durationMillis: number;
}

/** A counter-based xorshift stream: a spin's result never depends on rendering or input timing. */
export const reelOutcome = (seed: number, spin: number, bet: number): ReelOutcome => {
  let random = (seed ^ Math.imul(spin, 0x9e3779b9)) >>> 0;

  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;

    return random >>> 0;
  };

  const durationMillis = 2000 + (next() % 1501);
  // Preserve the payout stream while adding symbols around the original center rows.
  const originalGrid = Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => next() % 6));
  const symbol = originalGrid[0]?.[1];
  const ordinaryWin = originalGrid.every((column) => column[1] === symbol);
  const grid = originalGrid.map((column) => [next() % 6, ...column, next() % 6]);

  grid.push(Array.from({ length: 5 }, () => next() % 6));
  const position = (spin - 1 + (seed >>> 0)) % 10;
  let moment: GameMoment = "ordinary";
  let multiplier = 0;

  if (position === 0) {
    moment = "near-miss";
    for (let reel = 0; reel < 6; reel++) {
      const column = grid[reel];

      if (column !== undefined) column[2] = reel === 5 ? 1 : 0;
    }
  } else if (position === 2 || position === 4) {
    moment = position === 2 ? "big-win" : "bonus";
    multiplier = position === 2 ? 50 : 12;
    for (const column of grid) column[2] = position === 2 ? 4 : 5;
  } else if (position >= 6) {
    moment = "losing-streak";
    for (let reel = 0; reel < 6; reel++) {
      const column = grid[reel];

      if (column !== undefined) column[2] = reel % 6;
    }
  } else if (ordinaryWin) {
    multiplier = 5;
    const column = grid[5];

    if (column !== undefined && symbol !== undefined) column[2] = symbol;
  }

  return { grid, win: multiplier * bet, moment, durationMillis };
};

export interface GameEngine {
  readonly state: () => GameState;
  readonly startSpin: (atMillis: number) => boolean;
  readonly changeBet: (delta: number, atMillis: number) => boolean;
  readonly advance: (atMillis: number) => void;
  readonly drainEvents: () => ReadonlyArray<TruthEvent>;
}

/** Pure clock-driven machine. The fixture serializes this same implementation into its page. */
export const createGameEngine = (
  seed: number,
  credits: number,
  outcome: (seed: number, spin: number, bet: number) => ReelOutcome,
): GameEngine => {
  let state: GameState = {
    phase: "idle",
    spin: 0,
    bet: 10,
    balance: credits,
    grid: Array.from({ length: 6 }, (_, reel) =>
      Array.from({ length: 5 }, (_, row) => (reel + row) % 6),
    ),
    lastWin: 0,
    stoppedReels: 0,
    banner: null,
    notable: null,
  };

  let active: ReelOutcome | undefined;
  let started = 0;
  let resultAt = 0;
  let events: TruthEvent[] = [];

  return {
    state: () => ({ ...state, grid: state.grid.map((column) => [...column]) }),
    startSpin: (atMillis) => {
      if (state.phase !== "idle" || state.balance < state.bet) return false;
      started = atMillis;
      active = outcome(seed, state.spin + 1, state.bet);
      state = {
        ...state,
        phase: "spinning",
        spin: state.spin + 1,
        balance: state.balance - state.bet,
        lastWin: 0,
        stoppedReels: 0,
        banner: null,
        notable: null,
      };
      events.push({
        tag: "spinStart",
        spin: state.spin,
        atMillis,
        bet: state.bet,
        balanceAfter: state.balance,
        durationMillis: active.durationMillis,
      });

      return true;
    },
    changeBet: (delta, atMillis) => {
      if (state.phase !== "idle") return false;
      const bet = Math.min(100, Math.max(10, state.bet + Math.sign(delta) * 10));

      if (bet === state.bet) return false;
      state = { ...state, bet };
      events.push({ tag: "betChange", spin: state.spin, atMillis, bet });

      return true;
    },
    advance: (atMillis) => {
      if (state.phase === "spinning" && active !== undefined) {
        while (
          state.stoppedReels < 6 &&
          atMillis >= started + active.durationMillis - (5 - state.stoppedReels) * 200
        ) {
          const reel = state.stoppedReels;
          const symbols = active.grid[reel];

          events.push({ tag: "reelStop", spin: state.spin, atMillis, reel });
          state = {
            ...state,
            stoppedReels: reel + 1,
            grid: state.grid.map((column, index) =>
              index === reel && symbols !== undefined ? [...symbols] : column,
            ),
          };
        }
        if (state.stoppedReels === 6) {
          resultAt = atMillis;
          state = {
            ...state,
            phase: "result",
            grid: active.grid,
            lastWin: active.win,
            balance: state.balance + active.win,
            banner: active.win > 0 ? active.moment : null,
            notable: active.moment,
          };
          events.push({
            tag: "result",
            spin: state.spin,
            atMillis,
            grid: active.grid,
            win: active.win,
            balanceAfter: state.balance,
            moment: active.moment,
          });
          if (state.banner !== null)
            events.push({ tag: "bannerShown", spin: state.spin, atMillis, moment: state.banner });
        }
      }
      if (state.phase === "result" && atMillis >= resultAt + (state.lastWin > 0 ? 1500 : 0)) {
        if (state.banner !== null) events.push({ tag: "bannerHidden", spin: state.spin, atMillis });
        state = { ...state, phase: "idle", banner: null };
        active = undefined;
        events.push({ tag: "idle", spin: state.spin, atMillis });
      }
    },
    drainEvents: () => {
      const drained = events;

      events = [];

      return drained;
    },
  };
};
