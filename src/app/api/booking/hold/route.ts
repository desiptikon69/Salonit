import {createBookingHold} from "@/server/booking";
import {bodyFor,json,route,phoneSchema,rateLimit} from "@/server/http";
export const POST=route(async req=>{const body=await bodyFor(req);body.phone=phoneSchema.parse(body.phone);await rateLimit("hold:"+body.phone,5,600);return json(await createBookingHold(body));});
