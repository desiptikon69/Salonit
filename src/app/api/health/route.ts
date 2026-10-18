import { pool } from "@/server/db";
import { json, route } from "@/server/http";

/**
 * Liveness probe for App Platform and Docker.
 *
 * It must stay 2xx while PostgreSQL is briefly unavailable: otherwise the
 * platform restarts a healthy container instead of letting the pool reconnect.
 * Use /api/ready when a monitoring system needs the database state.
 */
export const GET = route(async () => {
  let database: "ok" | "unavailable" = "ok";
  try {
    await pool.query("SELECT 1");
  } catch {
    database = "unavailable";
  }
  return json({ status: "ok", database });
});
