import pg from "pg";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on("error", () => {});
  return pool;
}

/** Run `fn` inside a transaction, rolling back on any error. */
export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
