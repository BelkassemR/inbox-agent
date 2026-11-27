import type { Contact } from "../domain.ts";
import type { Queryable } from "./pool.ts";

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  organization: string | null;
  tags: string[];
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

const toContact = (r: ContactRow): Contact => ({
  id: r.id,
  name: r.name,
  email: r.email,
  organization: r.organization,
  tags: r.tags,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function findContactByEmail(db: Queryable, email: string): Promise<Contact | null> {
  const res = await db.query<ContactRow>("SELECT * FROM contacts WHERE lower(email) = lower($1)", [email]);
  return res.rows[0] ? toContact(res.rows[0]) : null;
}

export async function searchContactsByName(db: Queryable, name: string, limit = 5): Promise<Contact[]> {
  // Escape LIKE wildcards so user-supplied text is matched literally.
  const pattern = `%${name.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const res = await db.query<ContactRow>(
    "SELECT * FROM contacts WHERE lower(name) LIKE $1 OR lower(organization) LIKE $1 ORDER BY updated_at DESC LIMIT $2",
    [pattern, limit],
  );
  return res.rows.map(toContact);
}

export interface UpsertContactInput {
  name: string;
  email: string;
  organization?: string | null;
  tags?: string[];
  note?: string | null;
}

/** Insert or update by email. Notes are appended, never overwritten, so history is kept. */
export async function upsertContact(db: Queryable, c: UpsertContactInput): Promise<{ contact: Contact; created: boolean }> {
  const res = await db.query<ContactRow & { inserted: boolean }>(
    `INSERT INTO contacts (name, email, organization, tags, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE
       SET name = EXCLUDED.name,
           organization = COALESCE(EXCLUDED.organization, contacts.organization),
           tags = ARRAY(SELECT DISTINCT unnest(contacts.tags || EXCLUDED.tags)),
           notes = CASE
             WHEN EXCLUDED.notes IS NULL THEN contacts.notes
             WHEN contacts.notes IS NULL THEN EXCLUDED.notes
             ELSE contacts.notes || E'\n' || EXCLUDED.notes END,
           updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [c.name, c.email, c.organization ?? null, c.tags ?? [], c.note ?? null],
  );
  const row = res.rows[0]!;
  return { contact: toContact(row), created: row.inserted };
}
