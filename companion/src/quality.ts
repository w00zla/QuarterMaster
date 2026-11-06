// The level of a quality as the web app and the bot show it (from sc-quartermaster's src/stock/quality.ts).

/** Star level of a quality: one per 100 from 500 (500-599 = 1 ... 900-999 = 5). */
export const qualityStars = (q: number) => Math.min(5, Math.floor(q / 100) - 4);

/** The level of a quality: "◌" (below 500, not usable), "★" to "★★★★★", "♛" (1000) */
export const qMark = (q: number) => (q < 500 ? "◌" : q === 1000 ? "♛" : "★".repeat(qualityStars(q)));
