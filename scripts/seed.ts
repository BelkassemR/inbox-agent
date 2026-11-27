/**
 * Seed demo data: rate cards, a calendar with confirmed shows, and a few CRM contacts.
 *   DATABASE_URL=... pnpm db:seed
 */
import { createPool, insertEvent, migrate, upsertContact, upsertRate } from "@inbox/core";
import { zonedToUtc } from "@inbox/mcp-server";
import { saturdaysFrom, SHOW_WEEKS } from "./demo-data.ts";

const db = createPool(process.env.DATABASE_URL ?? "postgres://inbox:inbox@localhost:5432/inbox_agent", 2);
await migrate(db);
await db.query("TRUNCATE audit_log, calendar_events, contacts, rate_cards, requests RESTART IDENTITY CASCADE");

const rates: [string, string, number, string][] = [
  ["festival", "NL", 15_000, "Main stage; headline slot +40%"],
  ["festival", "BE", 14_000, "Excl. travel"],
  ["festival", "default", 18_000, "Outside Benelux: incl. flights for 4"],
  ["club_show", "NL", 6_000, "Max 75 min set"],
  ["club_show", "BE", 6_500, null as unknown as string],
  ["club_show", "default", 8_000, null as unknown as string],
  ["private_event", "default", 25_000, "Only on free weekdays or approved by management"],
  ["brand_deal", "default", 30_000, "Per campaign; exclusivity extra"],
  ["feature", "default", 10_000, "Plus 50/50 master split negotiable"],
];
for (const [eventType, region, minFeeEur, notes] of rates) await upsertRate(db, { eventType, region, minFeeEur, notes });

const venues = ["Ziggo Dome, Amsterdam", "Lotto Arena, Antwerpen", "Paradiso, Amsterdam", "TivoliVredenburg, Utrecht", "Ancienne Belgique, Brussel", "013, Tilburg", "Doornroosje, Nijmegen", "Effenaar, Eindhoven"];
const shows = saturdaysFrom(new Date(), SHOW_WEEKS);
for (const [i, date] of shows.entries()) {
  await insertEvent(db, { title: `Show – ${venues[i]!.split(",")[0]}`, kind: "show", startsAt: zonedToUtc(date, "20:00"), endsAt: zonedToUtc(date, "23:30"), location: venues[i] });
}
const [studio] = saturdaysFrom(new Date(), [1]);
const studioStart = new Date(`${studio}T00:00:00Z`);
studioStart.setUTCDate(studioStart.getUTCDate() - 3);
const s = studioStart.toISOString().slice(0, 10);
await insertEvent(db, { title: "Studio – album sessions", kind: "studio", startsAt: zonedToUtc(s, "11:00"), endsAt: zonedToUtc(s, "19:00"), location: "Studio 21, Hilversum" });

await upsertContact(db, { name: "Sanne de Vries", email: "sanne@zomerfest.nl", organization: "Zomerfest", tags: ["promoter"], note: "2026: booked for Zomerfest, smooth production, paid on time." });
await upsertContact(db, { name: "Kevin Janssens", email: "kevin@lottoarena-events.be", organization: "Arena Events", tags: ["promoter"], note: "Promoter for Lotto Arena." });
await upsertContact(db, { name: "Ilse Bakker", email: "ilse@sneakerlab.com", organization: "SneakerLab", tags: ["brand"], note: "2025: Instagram campaign, good collaboration." });

console.log(`Seeded ${rates.length} rate cards, ${shows.length + 1} calendar events, 3 contacts.`);
console.log(`Booked show dates: ${shows.join(", ")}`);
await db.end();
