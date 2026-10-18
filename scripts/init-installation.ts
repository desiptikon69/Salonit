import "dotenv/config";
import { pool, transaction } from "../src/server/db";
import { saveRecord } from "../src/server/records";
import { services, resources, bundles, settings } from "../src/server/sample-data";

async function main() {
  const mode = process.env.APP_MODE;
  const installationId = process.env.INSTALLATION_ID?.trim();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (mode !== "live" && mode !== "demo") throw new Error("APP_MODE must be live or demo.");
  if (!installationId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,79}$/.test(installationId)) {
    throw new Error("INSTALLATION_ID must contain 3–80 letters, digits, underscores or hyphens.");
  }
  await transaction(async tx => {
    // A table lock also prevents two concurrent initializers from both passing the empty check.
    await tx.query("LOCK TABLE records IN EXCLUSIVE MODE");
    const tables = await tx.query<{ schemaname: string; tablename: string }>(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','auth') AND tablename <> 'schema_migrations' ORDER BY schemaname,tablename",
    );
    if (!tables.rows.some(table => table.schemaname === "auth" && table.tablename === "user")) {
      throw new Error("Apply database migrations before initialization.");
    }
    for (const table of tables.rows) {
      const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
      const qualified = `${quote(table.schemaname)}.${quote(table.tablename)}`;
      await tx.query(`LOCK TABLE ${qualified} IN EXCLUSIVE MODE`);
      if ((await tx.query(`SELECT 1 FROM ${qualified} LIMIT 1`)).rowCount) {
        throw new Error("Installation initialization requires an empty migrated database. Existing data was not changed.");
      }
    }
    // These are editable templates. They must not expose estimated prices or fictional availability as live offers.
    for (const service of services) {
      await saveRecord("service", service.id, { ...service, active: false, norms: [] }, tx);
    }
    for (const resource of resources) {
      await saveRecord("resource", resource.id, { ...resource, ready: false, status: "maintenance" }, tx);
    }
    for (const bundle of bundles) await saveRecord("bundle", bundle.id, bundle, tx);
    await saveRecord("settings", "salon-settings", {
      ...settings, mode, address: "", phone: "", hours: "", installationId,
    }, tx);
    await saveRecord("installation", `installation:${installationId}`, {
      name: "SalonIt", installationId, domain: "", codeVersion: "", dbVersion: "", status: "setup", region: "",
    }, tx);
  });
  console.log("Clean installation initialized. Catalog templates are inactive; resources are unavailable until configured. No accounts, clients, employees, stock balances or history were created.");
}

void main().catch(error => {
  const databaseError = error && typeof error === "object" && "code" in error;
  console.error(databaseError ? "Initialization failed. Check migrations and database access; no partial initialization was saved." : error instanceof Error ? error.message : "Initialization failed.");
  process.exitCode = 1;
}).finally(() => pool.end());
