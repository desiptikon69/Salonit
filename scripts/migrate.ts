import "dotenv/config";
import { readFile,readdir } from "node:fs/promises";
import { pool } from "../src/server/db";
async function main(){
 await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
 for(const file of (await readdir("migrations")).filter(f=>f.endsWith(".sql")).sort()){
  if((await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1",[file])).rowCount)continue;
  const client=await pool.connect();
  try{await client.query("BEGIN");await client.query(await readFile("migrations/"+file,"utf8"));await client.query("INSERT INTO schema_migrations(name) VALUES($1)",[file]);await client.query("COMMIT");console.log("Applied",file);}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
 }
 await pool.end();
}
main().catch(e=>{console.error(e);process.exitCode=1;void pool.end();});

