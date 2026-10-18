import {z} from "zod";
import {confirmBookingHold} from "@/server/booking";
import {bodyFor,json,route,phoneSchema,verifyOtp,sessionFromResponse,rateLimit} from "@/server/http";
import {issueClientDevice,withPhoneOwnership} from "@/server/client-access";
export const POST=route(async req=>{
 const body=z.object({phone:phoneSchema,code:z.string().regex(/^\d{6}$/),holdId:z.string().uuid(),holdToken:z.string().min(20),accessKey:z.string().trim().max(200).optional()}).parse(await bodyFor(req));
 await rateLimit("verify:"+body.phone,8,300);
 return withPhoneOwnership(body.phone,req.headers,body.accessKey,async existing=>{
  const response=await verifyOtp(req,body.phone,body.code);if(!response.ok)return response;
  const actor=await sessionFromResponse(response,body.phone);
  const visit=await confirmBookingHold(body,actor);
  const access=await issueClientDevice({...actor,clientId:visit.clientId},!existing);
  const headers=new Headers(response.headers);headers.append("Set-Cookie",access.cookie);
  return json({visit,...(access.accessKey?{accessKey:access.accessKey}:{})},200,headers);
 });
});
