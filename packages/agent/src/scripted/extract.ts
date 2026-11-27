/**
 * Small rule-based extractor used by the scripted model. It is deliberately simple:
 * it exists so the whole pipeline can run offline (CI, demos without an API key),
 * not to compete with Claude.
 */

const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, january: 1, janvier: 1,
  feb: 2, februari: 2, february: 2, fevrier: 2, février: 2,
  mrt: 3, maart: 3, mar: 3, march: 3, mars: 3,
  apr: 4, april: 4, avril: 4,
  mei: 5, may: 5, mai: 5,
  jun: 6, juni: 6, june: 6, juin: 6,
  jul: 7, juli: 7, july: 7, juillet: 7,
  aug: 8, augustus: 8, august: 8, aout: 8, août: 8,
  sep: 9, sept: 9, september: 9, septembre: 9,
  okt: 10, oct: 10, oktober: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11,
  dec: 12, december: 12, décembre: 12, decembre: 12,
};

const CITIES: [string, string][] = [
  ["amsterdam", "NL"], ["rotterdam", "NL"], ["utrecht", "NL"], ["den haag", "NL"], ["eindhoven", "NL"],
  ["groningen", "NL"], ["tilburg", "NL"], ["breda", "NL"], ["nijmegen", "NL"], ["arnhem", "NL"], ["almere", "NL"],
  ["antwerpen", "BE"], ["antwerp", "BE"], ["brussel", "BE"], ["brussels", "BE"], ["bruxelles", "BE"],
  ["gent", "BE"], ["ghent", "BE"], ["leuven", "BE"], ["hasselt", "BE"], ["liège", "BE"], ["luik", "BE"],
];

const pad = (n: number) => String(n).padStart(2, "0");

export function extractDate(text: string, today: string): string | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
  if (dmy) return `${dmy[3]}-${pad(+dmy[2]!)}-${pad(+dmy[1]!)}`;
  const named = t.match(/\b(\d{1,2})(?:st|nd|rd|th|e|er)?\s+([a-zéû]+)\.?(?:\s+(20\d{2}))?/);
  const named2 = t.match(/\b([a-zéû]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(20\d{2}))?/);
  for (const [day, month, year] of [
    named && [named[1], named[2], named[3]],
    named2 && [named2[2], named2[1], named2[3]],
  ].filter(Boolean) as [string, string, string | undefined][]) {
    const m = MONTHS[month];
    if (!m) continue;
    let y = year ? Number(year) : Number(today.slice(0, 4));
    const candidate = `${y}-${pad(m)}-${pad(Number(day))}`;
    if (!year && candidate < today) y += 1;
    return `${y}-${pad(m)}-${pad(Number(day))}`;
  }
  return null;
}

export function extractCity(text: string): { city: string; region: string } | null {
  const t = text.toLowerCase();
  for (const [city, region] of CITIES) {
    if (new RegExp(`\\b${city}\\b`).test(t)) return { city: city.replace(/\b\w/g, (c) => c.toUpperCase()), region };
  }
  return null;
}

function parseAmount(raw: string, suffix?: string): number {
  let n = Number(raw.replace(/[.\s](?=\d{3}\b)/g, "").replace(",", "."));
  if (suffix && /^k$/i.test(suffix)) n *= 1000;
  return n;
}

export function extractBudget(text: string): number | null {
  const m =
    text.match(/(?:€|eur(?:o)?)\s?(\d{1,3}(?:[.\s]\d{3})+|\d+(?:,\d+)?)(k)?/i) ??
    text.match(/(\d{1,3}(?:[.\s]\d{3})+|\d+(?:,\d+)?)\s?(k)?\s?(?:€|eur(?:o)?s?)\b/i);
  return m ? parseAmount(m[1]!, m[2]) : null;
}

export function extractAudience(text: string): number | null {
  const m = text.match(/(\d{1,3}(?:[.\s]\d{3})+|\d+)\s*(?:bezoekers|visitors|people|mensen|gasten|guests|personen|attendees|spectateurs)/i);
  return m ? parseAmount(m[1]!) : null;
}

export function detectLanguage(text: string): "nl" | "en" | "fr" {
  const t = ` ${text.toLowerCase()} `;
  const score = (words: string[]) => words.reduce((s, w) => s + (t.includes(` ${w} `) ? 1 : 0), 0);
  const nl = score(["de", "het", "een", "wij", "we", "jullie", "graag", "voor", "met", "zijn", "hoi", "groet", "groeten"]);
  const en = score(["the", "and", "we", "would", "love", "you", "your", "for", "with", "hi", "regards", "best"]);
  const fr = score(["le", "la", "les", "nous", "vous", "bonjour", "pour", "avec", "est", "cordialement"]);
  if (fr > nl && fr > en) return "fr";
  return nl >= en ? "nl" : "en";
}

export type Kind = "booking" | "collaboration" | "press" | "fan" | "spam" | "other";

export function classify(text: string): { category: Kind; eventType: string | null } {
  const t = text.toLowerCase();
  if (/(crypto|bitcoin|wire transfer|gift card|click here|verify your account|lottery|winnaar van)/.test(t)) return { category: "spam", eventType: null };
  if (/(festival)/.test(t)) return { category: "booking", eventType: "festival" };
  if (/(club|clubshow|club show|nightclub)/.test(t)) return { category: "booking", eventType: "club_show" };
  if (/(bruiloft|wedding|mariage|anniversaire|verjaardag|birthday|bedrijfsfeest|company party|private event|soirée privée|personeelsfeest)/.test(t)) return { category: "booking", eventType: "private_event" };
  if (/(boeken|booking|book you|optreden|show|performance|concert)/.test(t)) return { category: "booking", eventType: "club_show" };
  if (/(campagne|campaign|brand|merk|sponsor|endorsement|ambassador)/.test(t)) return { category: "collaboration", eventType: "brand_deal" };
  if (/(feature|collab|samenwerking|samenwerken|track|remix)/.test(t)) return { category: "collaboration", eventType: "feature" };
  if (/(interview|podcast|journalist|artikel|article|krant|magazine|press|pers)/.test(t)) return { category: "press", eventType: "press" };
  if (/(fan|love your music|je muziek|grootste fan|biggest fan|handtekening|signed)/.test(t)) return { category: "fan", eventType: null };
  return { category: "other", eventType: null };
}

export function looksLikeInjection(text: string): boolean {
  return /(ignore (all |the )?(previous|prior|above) instructions|negeer (alle )?(vorige|eerdere) instructies|you are now|system prompt|as an ai|developer mode|reveal|disregard your rules)/i.test(text);
}
