import { createPool, type Db } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://inbox:inbox@localhost:5432/inbox_agent_test";

/** Connect to the test database, apply migrations and wipe all data. */
export async function setupTestDb(): Promise<Db> {
  const db = createPool(TEST_DATABASE_URL, 5);
  await migrate(db);
  await resetTestDb(db);
  return db;
}

export async function resetTestDb(db: Db): Promise<void> {
  await db.query("TRUNCATE audit_log, calendar_events, contacts, rate_cards, requests RESTART IDENTITY CASCADE");
}
