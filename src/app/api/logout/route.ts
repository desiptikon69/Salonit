import {auth} from "@/server/auth";
import {json,route,sameOrigin} from "@/server/http";
export const POST=route(async req=>{sameOrigin(req);const response=await auth.api.signOut({headers:req.headers,asResponse:true});return json({ok:true},200,response.headers);});
