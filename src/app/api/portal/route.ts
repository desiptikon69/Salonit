import {getPortal} from "@/server/queries";
import {actorFor,json,route} from "@/server/http";
export const GET=route(async req=>json(await getPortal(await actorFor(req))));
