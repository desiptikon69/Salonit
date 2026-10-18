import "dotenv/config";
import { pool } from "../src/server/db";
import { runWorkerTick } from "../src/server/jobs";

let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let wake: (() => void) | undefined;
function stop() { stopping = true; if (timer) clearTimeout(timer); wake?.(); }
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
async function main() {
  console.log("SalonIt worker started. External messaging is not configured.");
  try {
    do {
      try { const result = await runWorkerTick(); if (result.expiredHolds || result.processed) console.log(JSON.stringify(result)); }
      catch (error) {
        console.error("Worker tick failed; transaction rolled back:", error instanceof Error ? error.message : "Unknown error");
        if (process.argv.includes("--once")) process.exitCode = 1;
      }
      if (process.argv.includes("--once")) break;
      if (!stopping) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 5000); });
    } while (!stopping);
  } finally { await pool.end(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
