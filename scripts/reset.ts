import "dotenv/config";import {resetDemo} from "../src/server/seed";import {pool} from "../src/server/db";resetDemo().then(()=>console.log("DEMO reset complete")).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());

