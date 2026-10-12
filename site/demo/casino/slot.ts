// Opal Crown's maths: five reels of three rows, ten lines paying left to right, and a wild on the
// middle three reels. The game server decides every spin with it, so the spins it records are what
// the game showed, whatever the canvas drew.

export const symbols = [
  "TEN",
  "JACK",
  "QUEEN",
  "KING",
  "ACE",
  "EMERALD",
  "SAPPHIRE",
  "RUBY",
  "CROWN",
  "WILD",
] as const;

export type Symbol = (typeof symbols)[number];

/** The names a player would use for each symbol, as the paytable shows them. */
export const names: { readonly [S in Symbol]: string } = {
  TEN: "10",
  JACK: "J",
  QUEEN: "Q",
  KING: "K",
  ACE: "A",
  EMERALD: "Emerald",
  SAPPHIRE: "Sapphire",
  RUBY: "Ruby",
  CROWN: "Crown",
  WILD: "Wild",
};

/** What three, four and five in a line pay, in line bets: a tenth of the total bet. */
export const pays: { readonly [S in Exclude<Symbol, "WILD">]: readonly [number, number, number] } =
  {
    CROWN: [75, 250, 1000],
    RUBY: [40, 150, 500],
    SAPPHIRE: [25, 100, 300],
    EMERALD: [20, 75, 250],
    ACE: [15, 40, 150],
    KING: [15, 40, 150],
    QUEEN: [10, 30, 125],
    JACK: [10, 25, 100],
    TEN: [10, 25, 100],
  };

/** The ten lines, each a row from 0 (top) to 2 (bottom) on every reel. */
export const lines: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [1, 0, 1, 2, 1],
];

/** Total bets in cents. */
export const betLevels = [10, 20, 50, 100, 200, 500, 1000] as const;

export const defaultBet = 100;

export const startingBalance = 100_000;

// How many of each symbol a reel's strip holds. The wild is only on reels 2, 3 and 4.
const weights: { readonly [S in Symbol]: readonly [number, number, number, number, number] } = {
  TEN: [6, 6, 6, 6, 6],
  JACK: [6, 6, 6, 6, 6],
  QUEEN: [5, 5, 5, 5, 5],
  KING: [4, 4, 4, 4, 4],
  ACE: [4, 4, 4, 4, 4],
  EMERALD: [3, 3, 3, 3, 3],
  SAPPHIRE: [3, 3, 3, 3, 3],
  RUBY: [2, 2, 2, 2, 2],
  CROWN: [2, 2, 2, 2, 2],
  WILD: [0, 3, 3, 3, 0],
};

/** Seeded draws in [0, 1) (mulberry32). */
export const random = (seed: number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);

    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Each reel's strip, its symbols spread by a fixed shuffle so a reel never shows long runs.
export const strips: ReadonlyArray<ReadonlyArray<Symbol>> = [0, 1, 2, 3, 4].map((reel) => {
  const strip = symbols.flatMap((symbol) =>
    Array.from({ length: weights[symbol][reel] ?? 0 }, () => symbol),
  );

  const draw = random(0x0a1c0de + reel);

  for (let index = strip.length - 1; index > 0; index--) {
    const other = Math.floor(draw() * (index + 1));
    const kept = strip[index];

    strip[index] = strip[other] ?? kept!;
    strip[other] = kept!;
  }

  return strip;
});

/** Five reels, each its top, middle and bottom symbol. */
export type Grid = ReadonlyArray<readonly [Symbol, Symbol, Symbol]>;

export interface LineWin {
  /** 1 to 10. */
  readonly line: number;
  readonly symbol: Exclude<Symbol, "WILD">;
  readonly count: 3 | 4 | 5;
  /** Cents. */
  readonly pay: number;
}

/** The grid the reels stop on, from one draw per reel. */
export const stop = (draw: () => number): Grid =>
  strips.map((strip) => {
    const at = Math.floor(draw() * strip.length);

    return [0, 1, 2].map((row) => strip[(at + row) % strip.length]!) as unknown as readonly [
      Symbol,
      Symbol,
      Symbol,
    ];
  });

/** Every line's win on `grid` at a total bet of `bet` cents. */
export const evaluate = (grid: Grid, bet: number): ReadonlyArray<LineWin> =>
  lines.flatMap((rows, index) => {
    const shown = rows.map((row, reel) => grid[reel]![row]!);
    const first = shown[0]!;

    if (first === "WILD") return [];
    let count = 1;

    while (count < 5 && (shown[count] === first || shown[count] === "WILD")) count++;
    if (count < 3) return [];
    const tenths = pays[first][count - 3]!;

    return [
      {
        line: index + 1,
        symbol: first,
        count: count as 3 | 4 | 5,
        pay: Math.round((bet * tenths) / 10),
      },
    ];
  });
