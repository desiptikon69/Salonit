import {toNextJsHandler} from "better-auth/next-js";
import {auth} from "@/server/auth";
import {nativePhoneRouteBlocked} from "@/server/client-access";
const handlers=toNextJsHandler(auth);
const blocked=()=>Response.json({error:"Подтверждение телефона доступно только через защищённую форму записи.",code:"PHONE_FLOW_REQUIRED"},{status:403,headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request){return nativePhoneRouteBlocked(request)?blocked():handlers.GET(request);}
export async function POST(request:Request){return nativePhoneRouteBlocked(request)?blocked():handlers.POST(request);}
