// Estimates for a refinery job from the community method values (ext.refining_method) and the UEX
// station bonus. Pure: shared by the server and the web app's SPA, so no server imports here.
// ASSUMPTION (unverified in game): the station bonus multiplies the method's yield, as Regolith
// computes it (93.3 % with +5 % = 93.3 % x 1.05).

export interface RefiningMethodValues {
  // Base yield in % of the ore
  yieldPct: number;
  secondsPerScu: number;
}

export interface JobEstimate {
  // Processing time, whole seconds
  seconds: number;
  // Refined SCU, rounded to cSCU (0.01) as the terminal shows it
  yieldScu: number;
}

/** Time and yield for `amountScu` of ore; `bonusPct` is the station's UEX bonus for the ore (none: 0). */
export function estimateJob(amountScu: number, method: RefiningMethodValues, bonusPct = 0): JobEstimate {
  return {
    seconds: Math.round(amountScu * method.secondsPerScu),
    yieldScu: Math.round(amountScu * method.yieldPct * (1 + bonusPct / 100)) / 100,
  };
}
