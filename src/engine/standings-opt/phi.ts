/** Standard normal CDF by table + linear interpolation (|error| < 1e-6); fast enough for the rollout hot loops. */
const PHI_N = 1600;
const PHI_LO = -4;
const PHI_STEP = 8 / PHI_N;
const PHI = (() => {
  const t = new Float64Array(PHI_N + 2);
  const erf = (x: number) => {
    // Abramowitz-Stegun 7.1.26 (|err| < 1.5e-7)
    const s = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    const tt = 1 / (1 + 0.3275911 * a);
    const y = 1 - ((((1.061405429 * tt - 1.453152027) * tt + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-a * a);
    return s * y;
  };
  for (let i = 0; i < t.length; i++) t[i] = 0.5 * (1 + erf((PHI_LO + i * PHI_STEP) / Math.SQRT2));
  return t;
})();

export function phi(z: number): number {
  if (z <= PHI_LO) return 0;
  if (z >= -PHI_LO) return 1;
  const f = (z - PHI_LO) / PHI_STEP;
  const i = f | 0;
  return PHI[i] + (PHI[i + 1] - PHI[i]) * (f - i);
}
