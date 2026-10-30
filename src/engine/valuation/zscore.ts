export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation. */
export function stdDev(xs: number[], m: number = mean(xs)): number {
  if (xs.length === 0) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/** z-score; returns 0 when stdDev is 0. */
export function zScore(x: number, m: number, sd: number): number {
  return sd === 0 ? 0 : (x - m) / sd;
}
