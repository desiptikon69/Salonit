import {getActor} from "@/server/auth";
import {getBookingSlots} from "@/server/booking";
import {json,route} from "@/server/http";
export const GET=route(async req=>{const p=new URL(req.url).searchParams;return json({slots:await getBookingSlots({date:p.get("date")??"",serviceIds:(p.get("services")??"").split(","),mode:p.get("mode") as "parallel"|"sequential",staffId:p.get("staffId")??undefined,visitId:p.get("visitId")??undefined},await getActor(req.headers))});});
