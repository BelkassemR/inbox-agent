/** Demo data relative to "today", so the demo always works no matter when it runs. */

export function saturdaysFrom(today: Date, weeks: number[]): string[] {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7)); // next Saturday
  return weeks.map((w) => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + w * 7);
    return x.toISOString().slice(0, 10);
  });
}

const NL_MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FR_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];
export const nlDate = (iso: string) => { const [y, m, d] = parts(iso); return `${d} ${NL_MONTHS[m - 1]} ${y}`; };
export const enDate = (iso: string) => { const [y, m, d] = parts(iso); return `${EN_MONTHS[m - 1]} ${d}, ${y}`; };
export const frDate = (iso: string) => { const [y, m, d] = parts(iso); return `${d} ${FR_MONTHS[m - 1]} ${y}`; };

/** Saturdays (weeks from now) with confirmed shows in the seeded calendar. */
export const SHOW_WEEKS = [3, 5, 8, 12, 16, 21, 26, 30];
/** Saturdays left free for the demo's booking requests. */
export const FREE_WEEKS = { festival: 28, club: 14, private: 18 };
