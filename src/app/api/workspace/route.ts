import {getWorkspace} from "@/server/queries";
import {actorFor,json,route} from "@/server/http";
export const GET=route(async req=>{
  const params = new URL(req.url).searchParams;
  return json(await getWorkspace(await actorFor(req), {
    dateFrom: params.get("dateFrom") ?? undefined,
    dateTo: params.get("dateTo") ?? undefined,
  }));
});
