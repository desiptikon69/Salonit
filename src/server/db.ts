import "dotenv/config";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export type SqlClient = Pool | PoolClient;
const globalDb = globalThis as unknown as { salonitPool?: Pool };
export const pool = globalDb.salonitPool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
if (process.env.NODE_ENV !== "production") globalDb.salonitPool = pool;
export const db = drizzle(pool);
export async function rows<T = Record<string, unknown>>(text: string, values: unknown[] = [], client: SqlClient = pool): Promise<T[]> {
  return (await client.query<QueryResultRow>(text, values)).rows as T[];
}
export async function first<T = Record<string, unknown>>(text: string, values: unknown[] = [], client: SqlClient = pool): Promise<T | undefined> {
  return (await rows<T>(text, values, client))[0];
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

