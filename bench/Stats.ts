// The statistics a report states, over counts: exact paired tests between two arms, Holm's
// correction across a family of tests, pass^k, and binomial intervals. The bench's counts stay in
// the hundreds, so sums over exact terms are cheap and accurate.

/** log C(n, k). */
const logChoose = (n: number, k: number) => {
  let sum = 0;

  for (let index = 1; index <= k; index++) sum += Math.log(n - k + index) - Math.log(index);

  return sum;
};

/** P(X ≤ k) for X ~ Binomial(n, 1/2). */
const fairTail = (k: number, n: number) => {
  let total = 0;

  for (let index = 0; index <= k; index++) total += Math.exp(logChoose(n, index) - n * Math.LN2);

  return Math.min(1, total);
};

/**
 * McNemar's exact test, two-sided: among pairs where exactly one arm passed, whether either arm
 * passed more often than a fair coin would say. Pooling the discordant pairs of several tasks gives
 * the test stratified by task, as Mantel and Haenszel's is for matched pairs.
 */
export const mcnemar = (onlyFirst: number, onlySecond: number): number => {
  const discordant = onlyFirst + onlySecond;

  return discordant === 0
    ? 1
    : Math.min(1, 2 * fairTail(Math.min(onlyFirst, onlySecond), discordant));
};

/** Holm's step-down adjustment of a family of p-values, in their given order. */
export const holm = (pValues: ReadonlyArray<number>): ReadonlyArray<number> => {
  const ranked = pValues
    .map((p, index) => ({ p, index }))
    .toSorted((left, right) => left.p - right.p);

  const adjusted = pValues.map(() => 1);
  let floor = 0;

  for (const [rank, { p, index }] of ranked.entries()) {
    floor = Math.max(floor, Math.min(1, (pValues.length - rank) * p));
    adjusted[index] = floor;
  }

  return adjusted;
};

/**
 * pass^k: the chance that k trials of one task all pass, estimated without bias from n trials with
 * c passes as C(c, k) / C(n, k), as τ-bench defines it. Undefined for k above n.
 */
export const passHatK = (passes: number, trials: number, k: number): number =>
  k > trials ? Number.NaN : passes < k ? 0 : Math.exp(logChoose(passes, k) - logChoose(trials, k));

/** Wilson's 95% interval for a proportion: inside [0, 1], and sensible at 0 and at n. */
export const wilson = (successes: number, n: number) => {
  if (n === 0) return { low: 0, high: 1 };

  const z = 1.959963984540054;
  const p = successes / n;
  const shrink = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / shrink;
  const half = (z / shrink) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));

  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
};
