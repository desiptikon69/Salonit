import { z } from "zod";
import { confirmPhoneChange } from "@/server/change-phone";
import { actorFor, bodyFor, json, rateLimit, route } from "@/server/http";

export const POST=route(async req=>{
  const body=z.object({changeId:z.uuid(),code:z.string().regex(/^\d{6}$/,"Введите код из 6 цифр")}).parse(await bodyFor(req));
  const actor=await actorFor(req);
  await rateLimit("phone-change-verify:"+actor.id,8,300);
  return json(await confirmPhoneChange(actor,req.headers,body.changeId,body.code));
});
