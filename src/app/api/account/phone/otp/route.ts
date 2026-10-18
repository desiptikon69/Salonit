import { z } from "zod";
import { startPhoneChange } from "@/server/change-phone";
import { actorFor, bodyFor, json, phoneSchema, rateLimit, route } from "@/server/http";

export const POST=route(async req=>{
  const body=z.object({phone:phoneSchema}).parse(await bodyFor(req));
  const actor=await actorFor(req);
  await rateLimit("phone-change-send:"+actor.id,5,300);
  await rateLimit("phone-change-target:"+body.phone,5,300);
  return json(await startPhoneChange(actor,req.headers,body.phone));
});
