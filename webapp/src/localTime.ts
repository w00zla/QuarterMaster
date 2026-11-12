// Times in the singleuser settings view (pure: tested in test/webapp-local.test.ts).

const clock = (d: Date, lang: string) => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(d);

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * A local time the short way: today only the clock ("14:32"), yesterday and tomorrow with the day ("Gestern, 21:05"),
 * any other day with its date. "" for a missing or invalid time.
 */
export function shortTime(iso: string | null | undefined, now: Date, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock(d, lang);
  if (days === -1 || days === 1) {
    const word = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(days, "day");
    return `${word.charAt(0).toLocaleUpperCase(lang)}${word.slice(1)}, ${clock(d, lang)}`;
  }
  return `${new Intl.DateTimeFormat(lang, { day: "2-digit", month: "2-digit", year: "numeric" }).format(d)}, ${clock(d, lang)}`;
}

/** The same with "Today" for today: where a plain "14:32" would be read as a duration ("Checked: Heute, 14:32"). */
export function dayTime(iso: string | null | undefined, now: Date, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (startOfDay(d) !== startOfDay(now)) return shortTime(iso, now, lang);
  const word = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(0, "day");
  return `${word.charAt(0).toLocaleUpperCase(lang)}${word.slice(1)}, ${clock(d, lang)}`;
}

/** "12 / 45 MB": downloaded and total in megabytes (one decimal below 10 MB of the total), the unit once. */
export function megabytes(done: number, total: number, lang: string): string {
  const mb = (n: number) => n / 1_048_576;
  const digits = mb(total) < 10 ? 1 : 0;
  const f = new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${f.format(mb(Math.min(done, total)))} / ${f.format(mb(total))} MB`;
}
