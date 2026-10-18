import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, rows } from "../../src/server/db";
import { saveRecord } from "../../src/server/records";
import { confirmBookingHold, createBookingHold, getBookingSlots, runBookingCommand } from "../../src/server/booking";
import type { Actor, Resource, Service, Staff } from "../../src/lib/contracts";

const actor:Actor={id:"booking-user",name:"Booking Client",role:"client"};
const owner:Actor={id:"booking-owner",name:"Owner",role:"owner"};
const phone="+79012345678";
const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
const time=(hour:number)=>`${date}T${String(hour).padStart(2,"0")}:00:00+03:00`;
const service:Service={id:"booking-service",name:"Hair",category:"Волосы",description:"",durationMinutes:60,bufferMinutes:10,priceMinor:200000,skill:"hair",resourceType:"chair",active:true,norms:[]};
const staff:Staff={id:"booking-staff",name:"Staff",title:"",initials:"BS",color:"green",skills:["hair"],commissionBps:4000,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true,workStart:"09:00",workEnd:"21:00"};
const resource:Resource={id:"booking-chair",name:"Chair",type:"chair",ready:true,status:"ready"};
const input=(hour=10)=>({serviceIds:[service.id],mode:"sequential" as const,startAt:time(hour),name:"New Client",phone});
async function confirmed(hour=10){const hold=await createBookingHold(input(hour));return confirmBookingHold({...hold,phone},actor);}

describe("PostgreSQL booking reservations",()=>{
  beforeEach(async()=>{
    if(!process.env.DATABASE_URL?.includes("salonit_test")) throw new Error("Use isolated salonit_test database");
    await rows("TRUNCATE records,appointments,payments,consumptions,accruals,payouts,audit_events,outbox,commands CASCADE");
    await rows('DELETE FROM auth."user" WHERE id=$1',[actor.id]);
    await rows('INSERT INTO auth."user"(id,name,email,phone_number,phone_number_verified,role) VALUES($1,\'Client\',\'booking@example.invalid\',$2,true,\'client\')',[actor.id,phone]);
    await saveRecord("service",service.id,service);
    await saveRecord("staff",staff.id,staff);
    await saveRecord("resource",resource.id,resource);
  });
  afterAll(async()=>{await pool.end();});

  it("reserves the final resource once under concurrent requests and stores only a token hash",async()=>{
    const results=await Promise.allSettled(Array.from({length:30},()=>createBookingHold(input())));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const winner=results.find(r=>r.status==="fulfilled")!;
    if(winner.status!=="fulfilled")throw new Error("Missing winner");
    const stored=(await rows<{hold_token_hash:string}>("SELECT hold_token_hash FROM appointments"))[0];
    expect(stored.hold_token_hash).not.toBe(winner.value.holdToken);
    expect(stored.hold_token_hash).toHaveLength(64);
    expect(await rows("SELECT * FROM allocations WHERE active")).toHaveLength(2);
    const confirmation=await confirmBookingHold({...winner.value,phone},actor);
    expect(confirmation.status).toBe("confirmed");
    expect(await rows("SELECT id FROM appointments WHERE status='confirmed'")).toHaveLength(1);
  });
  it("expires reservations and refuses late confirmation while releasing capacity",async()=>{
    const hold=await createBookingHold(input());
    await rows("UPDATE appointments SET hold_expires_at=now()-interval '1 minute' WHERE id=$1",[hold.holdId]);
    await expect(confirmBookingHold({...hold,phone},actor)).rejects.toThrow(/истекло/);
    await expect(createBookingHold(input())).resolves.toHaveProperty("holdId");
  });
  it("requires a verified matching phone and valid token",async()=>{
    const hold=await createBookingHold(input());
    await expect(confirmBookingHold({...hold,phone,holdToken:"x".repeat(43)},actor)).rejects.toThrow(/Недействительное/);
    await rows('UPDATE auth."user" SET phone_number_verified=false WHERE id=$1',[actor.id]);
    await expect(confirmBookingHold({...hold,phone},actor)).rejects.toThrow(/телефон/);
    expect((await rows<{status:string}>("SELECT status FROM appointments"))[0].status).toBe("hold");
  });
  it("links by account rather than merging an unrelated person with the same phone; replay is safe",async()=>{
    await saveRecord("client","legacy-client",{name:"Someone else",phone,accountId:null});
    const hold=await createBookingHold(input());
    const visit=await confirmBookingHold({...hold,phone},actor);
    expect(visit.clientId).not.toBe("legacy-client");
    expect(await confirmBookingHold({...hold,phone},actor)).toEqual(visit);
    expect(await rows("SELECT * FROM records WHERE kind='client'")).toHaveLength(2);
    expect(await rows("SELECT * FROM outbox")).toHaveLength(1);
  });
  it("preserves the original reservation and version when a move conflicts",async()=>{
    const visit=await confirmed();
    await createBookingHold({...input(12),phone:"+79012345679"});
    await expect(runBookingCommand({...actor,clientId:visit.clientId},"visit.move",{id:visit.id,startAt:time(12),version:visit.version},randomUUID())).rejects.toThrow(/занято/);
    const current=(await rows<{start_at:Date;version:number}>("SELECT start_at,version FROM appointments WHERE id=$1",[visit.id]))[0];
    expect(current.start_at.toISOString()).toBe(visit.startAt);
    expect(current.version).toBe(visit.version);
    expect(await rows("SELECT * FROM allocations WHERE appointment_id=$1 AND active",[visit.id])).toHaveLength(3);
  });
  it("moves atomically, preserves price snapshots, and scopes both move and slots to ownership",async()=>{
    const visit=await confirmed();
    const client={...actor,clientId:visit.clientId};
    await expect(getBookingSlots({date,serviceIds:[service.id],mode:"sequential",visitId:visit.id},{...client,clientId:"other"})).rejects.toThrow(/чужой/);
    const slots=await getBookingSlots({date,serviceIds:[service.id],mode:"sequential",visitId:visit.id},client);
    expect(slots.some(s=>s.startAt===visit.startAt)).toBe(true);
    await saveRecord("service",service.id,{...service,priceMinor:999999,durationMinutes:120});
    const id=randomUUID(),payload={id:visit.id,startAt:time(14),version:visit.version};
    const moved=await runBookingCommand(client,"visit.move",payload,id);
    expect(moved.totalMinor).toBe(200000);
    expect(Date.parse(moved.endAt)-Date.parse(moved.startAt)).toBe(60*60000);
    expect(await runBookingCommand(client,"visit.move",payload,id)).toEqual(moved);
    await expect(runBookingCommand(owner,"visit.move",payload,id)).rejects.toThrow(/Ключ/);
  });
  it("respects explicit unavailable shifts",async()=>{
    await saveRecord("shift","day-off",{staffId:staff.id,date,start:"09:00",end:"21:00",status:"absent"});
    expect(await getBookingSlots({date,serviceIds:[service.id],mode:"sequential"})).toHaveLength(0);
    await expect(createBookingHold(input())).rejects.toThrow(/мастера/);
  });
  it("prevents overlapping confirmed appointments for the same account even with distinct staff and chairs",async()=>{
    const original=await confirmed();
    // Imported/older appointments may not yet have explicit client allocations.
    await rows("DELETE FROM allocations WHERE appointment_id=$1 AND resource_key LIKE 'client:%'",[original.id]);
    await saveRecord("staff","second-staff",{...staff,id:"second-staff"});
    await saveRecord("resource","second-chair",{...resource,id:"second-chair"});
    const hold=await createBookingHold(input());
    await expect(confirmBookingHold({...hold,phone},actor)).rejects.toThrow(/занято/);
    expect(await rows("SELECT * FROM appointments WHERE status='confirmed'")).toHaveLength(1);
  });
  it("creates a linked zero-price rework once without mutating the original financial record",async()=>{
    const visit=await confirmed();
    await rows("UPDATE appointments SET status='completed',closed_at=now(),paid_minor=total_minor WHERE id=$1",[visit.id]);
    await rows("UPDATE allocations SET active=false WHERE appointment_id=$1",[visit.id]);
    const payload={id:visit.id,startAt:time(15),reason:"Fix the haircut"};
    const rework=await runBookingCommand(owner,"visit.rework",payload,randomUUID());
    expect(rework.parentId).toBe(visit.id);expect(rework.totalMinor).toBe(0);
    await expect(runBookingCommand(owner,"visit.rework",payload,randomUUID())).rejects.toThrow(/уже создана/);
    expect(Number((await rows<{paid_minor:string}>("SELECT paid_minor FROM appointments WHERE id=$1",[visit.id]))[0].paid_minor)).toBe(200000);
  });
});
