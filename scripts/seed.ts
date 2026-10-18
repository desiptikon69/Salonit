import "dotenv/config";import {seedDemo} from "../src/server/seed";import {pool} from "../src/server/db";seedDemo().then(()=>console.log("SalonIt seed ready")).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());

