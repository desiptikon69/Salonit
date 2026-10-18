import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import {existsSync,mkdirSync} from "node:fs";
import {resolve} from "node:path";
const dir=resolve(".data/postgres");mkdirSync(resolve(".data"),{recursive:true});
const pg=new EmbeddedPostgres({databaseDir:dir,user:"salonit",password:"salonit_local",port:55432,persistent:true,initdbFlags:["--encoding=UTF8","--locale=C"],postgresFlags:["-h","127.0.0.1"]});
async function main(){if(!existsSync(resolve(dir,"PG_VERSION")))await pg.initialise();await pg.start();const client=pg.getPgClient();await client.connect();for(const name of ["salonit","salonit_test"]){if(!(await client.query("SELECT 1 FROM pg_database WHERE datname=$1",[name])).rowCount)await client.query('CREATE DATABASE "'+name+'"');}await client.end();console.log("PostgreSQL ready: localhost:55432 (salonit, salonit_test)");}
main().catch(e=>{console.error(e);process.exitCode=1;});
process.on("SIGINT",()=>{void pg.stop().then(()=>process.exit());});process.on("SIGTERM",()=>{void pg.stop().then(()=>process.exit());});

