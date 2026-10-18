import {getCatalog} from "@/server/queries";
import {json,route} from "@/server/http";
export const GET=route(async()=>json(await getCatalog()));
