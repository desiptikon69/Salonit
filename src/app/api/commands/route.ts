import {z} from "zod";
import {actorFor,bodyFor,json,route} from "@/server/http";
import {runOperation} from "@/server/operations";
import {runBookingCommand} from "@/server/booking";
import {resetDemo} from "@/server/seed";
import {authorize} from "@/server/permissions";
import {runFinancialCorrection} from "@/server/financial-corrections";
import {runClientAccessCommand} from "@/server/client-access";
export const POST=route(async req=>{const actor=await actorFor(req);const {action,payload,commandId}=z.object({action:z.string().min(1).max(60),payload:z.unknown(),commandId:z.string().uuid()}).parse(await bodyFor(req));if(action==="demo.reset"){authorize(actor,["owner"]);await resetDemo();return json({ok:true});}const result=action.startsWith("finance.correction.")?await runFinancialCorrection(actor,action,payload,commandId):action==="client.access.reset"?await runClientAccessCommand(actor,action,payload,commandId):action==="visit.move"||action==="visit.rework"||action==="visit.addService"?await runBookingCommand(actor,action,payload,commandId):await runOperation(actor,action,payload,commandId);return json({ok:true,result});});


