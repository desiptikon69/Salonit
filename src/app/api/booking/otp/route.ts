import {auth,isDemo} from "@/server/auth";
import {bodyFor,json,route,phoneSchema,rateLimit} from "@/server/http";
import {first} from "@/server/db";
export const POST=route(async req=>{const body=await bodyFor(req);const phone=phoneSchema.parse(body.phone);await rateLimit("otp:"+phone,5,300);const response=await auth.api.sendPhoneNumberOTP({body:{phoneNumber:phone},headers:req.headers,asResponse:true});if(!response.ok)return response;const otp=isDemo()?await first<{code:string}>("SELECT code FROM demo_otp WHERE phone=$1 AND expires_at>now()",[phone]):null;return json({ok:true,...(otp?{demoCode:otp.code}:{})});});
