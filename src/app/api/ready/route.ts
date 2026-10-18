import { pool } from "@/server/db";
import { json, route } from "@/server/http";

/** Readiness probe for external monitoring: 503 until PostgreSQL answers. */
export const GET = route(async () => {
  try {
    await pool.query("SELECT 1");
    return json({ status: "ready" });
  } catch {
    return json({ status: "not-ready" }, 503);
  }
});
