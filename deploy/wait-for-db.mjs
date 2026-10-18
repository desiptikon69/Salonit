import pg from "pg";

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
const deadline = Date.now() + 90_000;

for (;;) {
  try {
    await pool.query("SELECT 1");
    await pool.end();
    console.log("Database is ready");
    process.exit(0);
  } catch (error) {
    if (Date.now() > deadline) {
      console.error("Database did not become ready in 90s:", error instanceof Error ? error.message : error);
      await pool.end().catch(() => undefined);
      process.exit(1);
    }
    console.log("Waiting for database...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
