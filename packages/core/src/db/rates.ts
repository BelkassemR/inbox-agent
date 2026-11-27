import type { RateCard } from "../domain.ts";
import type { Queryable } from "./pool.ts";

interface RateRow {
  id: string;
  event_type: string;
  region: string;
  min_fee_eur: number;
  notes: string | null;
}

const toRate = (r: RateRow): RateCard => ({
  id: r.id,
  eventType: r.event_type,
  region: r.region,
  minFeeEur: r.min_fee_eur,
  notes: r.notes,
});

/** Exact (type, region) match first, then the type's "default" region. */
export async function lookupRate(db: Queryable, eventType: string, region: string): Promise<RateCard | null> {
  const res = await db.query<RateRow>(
    `SELECT * FROM rate_cards
      WHERE lower(event_type) = lower($1) AND lower(region) IN (lower($2), 'default')
      ORDER BY (lower(region) = lower($2)) DESC
      LIMIT 1`,
    [eventType, region],
  );
  return res.rows[0] ? toRate(res.rows[0]) : null;
}

export async function listRates(db: Queryable): Promise<RateCard[]> {
  const res = await db.query<RateRow>("SELECT * FROM rate_cards ORDER BY event_type, region");
  return res.rows.map(toRate);
}

export async function upsertRate(
  db: Queryable,
  r: { eventType: string; region: string; minFeeEur: number; notes?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO rate_cards (event_type, region, min_fee_eur, notes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_type, region) DO UPDATE SET min_fee_eur = EXCLUDED.min_fee_eur, notes = EXCLUDED.notes`,
    [r.eventType, r.region, r.minFeeEur, r.notes ?? null],
  );
}
