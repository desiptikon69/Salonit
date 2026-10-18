import {z} from "zod";
import {auth,isDemo} from "@/server/auth";
import {bodyFor,json,route,rateLimit} from "@/server/http";
import {AppError} from "@/server/errors";
export const POST=route(async req=>{if(!isDemo())throw new AppError(404,"Страница не найдена");const {role}=z.object({role:z.enum(["owner","admin","master","stock","accountant","operator","client"])}).parse(await bodyFor(req));await rateLimit("demo-login",100);const response=await auth.api.signInEmail({body:{email:role+"@demo.salonit.invalid",password:process.env.DEMO_PASSWORD!},headers:req.headers,asResponse:true});if(!response.ok)return response;return json({ok:true},200,response.headers);});
