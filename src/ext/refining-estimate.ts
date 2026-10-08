// Estimates for a refinery job from the method values (ext.refining_method) and the UEX station bonus.
// Pure: shared by the server and the web app's SPA, so no server imports here.
// Measured in game (quotes at CRU-L1, 2026-10-07/08): the station bonus multiplies the method's yield
// (45 % with -2 % = 45 % x 0.98), and the terminal cuts time and yield off instead of rounding.

export interface RefiningMethodValues {
  // Base yield in % of the ore
  yieldPct: number;
  secondsPerScu: number;
}

export interface JobEstimate {
  // Processing time, whole seconds
  seconds: number;
  // Refined SCU, cut off to cSCU (0.01) as the terminal shows it
  yieldScu: number;
}

// Floating point noise (0.45 x 100 = 45.00000000000001 or 44.99999999999999) must not cost a whole unit
const EPSILON = 1e-9;

/** Time and yield for `amountScu` of ore; `bonusPct` is the station's UEX bonus for the ore (none: 0). */
export function estimateJob(amountScu: number, method: RefiningMethodValues, bonusPct = 0): JobEstimate {
  return {
    seconds: Math.floor(amountScu * method.secondsPerScu + EPSILON),
    yieldScu: Math.floor(amountScu * method.yieldPct * (1 + bonusPct / 100) + EPSILON) / 100,
  };
}
