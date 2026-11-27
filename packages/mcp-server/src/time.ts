export const TIMEZONE = "Europe/Amsterdam";

/** Offset of `tz` from UTC in minutes at instant `d` (e.g. +120 in CEST). */
export function tzOffsetMinutes(d: Date, tz: string = TIMEZONE): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Interpret a wall-clock date + time in `tz` and return the UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string = TIMEZONE): Date {
  const naive = new Date(`${date}T${time}:00Z`);
  return new Date(naive.getTime() - tzOffsetMinutes(naive, tz) * 60_000);
}

/** YYYY-MM-DD of instant `d` in `tz`. */
export function localDate(d: Date, tz: string = TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function localTime(d: Date, tz: string = TIMEZONE): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
