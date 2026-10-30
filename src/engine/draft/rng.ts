/** Deterministic seeded PRNG (mulberry32) with Box-Muller normals. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal N(0,1). */
  normal(): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  let spare = 0;
  let hasSpare = false;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (): number => {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    const u = 1 - next(); // (0,1]
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    const ang = 2 * Math.PI * v;
    spare = r * Math.sin(ang);
    hasSpare = true;
    return r * Math.cos(ang);
  };
  return { next, normal };
}
