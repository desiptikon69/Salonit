import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor, Resource, Service, Staff, VisitItem } from "../../src/lib/contracts";
import { pool, rows } from "../../src/server/db";
import { saveRecord } from "../../src/server/records";
import { runOperation } from "../../src/server/operations";
import { createBookingHold } from "../../src/server/booking";

const owner:Actor={id:"expiry-owner",name:"Owner",role:"owner"};
const command=(action:string,payload:unknown)=>runOperation(owner,action,payload,randomUUID());
const tool:Resource={id:"expiry-tool",name:"Manicure tools",type:"tools-hands",status:"ready",ready:true,readyUntil:new Date(Date.now()-1000).toISOString(),processingValidityHours:24};
const service:Service={id:"expiry-service",name:"Manicure",category:"Ногти",description:"",durationMinutes:45,bufferMinutes:10,priceMinor:100000,skill:"hands",resourceType:"nail-chair",active:true,norms:[]};
const staff:Staff={id:"expiry-staff",name:"Master",title:"",initials:"M",color:"green",skills:["hands"],commissionBps:4000,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true,workStart:"09:00",workEnd:"21:00"};
const future=new Date(Date.now()+2*86400000).toISOString().slice(0,10)+"T10:00:00+03:00";
const input={serviceIds:[service.id],mode:"sequential" as const,startAt:future,name:"Demo Client",phone:"+79000000999"};
const current=async()=>({...((await rows<{data:Resource}>("SELECT data FROM records WHERE id=$1",[tool.id]))[0].data),id:tool.id});
async function visit() {
  const id=randomUUID();
  const item:VisitItem={id:"expiry-item",serviceId:service.id,serviceName:service.name,staffId:staff.id,staffName:staff.name,startAt:future,endAt:new Date(Date.parse(future)+45*60000).toISOString(),priceMinor:100000,commissionBps:4000,norms:[],status:"arrived",reservations:[{resourceKey:"resource:"+tool.id,startAt:future,endAt:new Date(Date.parse(future)+45*60000).toISOString()}]};
  await rows("INSERT INTO appointments(id,reference,status,start_at,end_at,items,total_minor) VALUES($1,$2,'arrived',$3,$4,$5,100000)",[id,id,item.startAt,item.endAt,JSON.stringify([item])]);
  return id;
}
describe("instrument cycle expiry",()=>{
  beforeEach(async()=>{
    if(new URL(process.env.DATABASE_URL??"").pathname!=="/salonit_test")throw new Error("Use isolated salonit_test database");
    await rows("TRUNCATE appointments,records,payments,consumptions,accruals,payouts,audit_events,outbox,commands,import_runs CASCADE");
    await saveRecord("resource",tool.id,tool);
    await saveRecord("resource","expiry-chair",{name:"Chair",type:"nail-chair",ready:true,status:"ready"});
    await saveRecord("staff",staff.id,staff);
    await saveRecord("service",service.id,service);
  });
  afterAll(()=>pool.end());
  it("rejects expired instruments for a new hold and service start",async()=>{
    await expect(createBookingHold(input)).rejects.toThrow("готовых инструментов");
    const id=await visit();
    await expect(command("visit.status",{id,version:1,status:"in_progress"})).rejects.toThrow("срок готовности истёк");
    expect((await rows<{version:number}>("SELECT version FROM appointments WHERE id=$1",[id]))[0].version).toBe(1);
  });
  it("configuration and forged readyUntil never renew an existing expired cycle",async()=>{
    for(const hours of [48,72])await command("resource.save",{...tool,processingValidityHours:hours,readyUntil:new Date(Date.now()+100*86400000).toISOString()});
    expect(await current()).toMatchObject({readyUntil:tool.readyUntil,processingValidityHours:72});
    expect(await rows("SELECT id FROM records WHERE kind='resource_cycle'")).toHaveLength(0);
    await expect(createBookingHold(input)).rejects.toThrow();
    await expect(command("resource.save",{...tool,processingValidityHours:721})).rejects.toThrow();
  });
  it("successful new control creates a fresh bounded cycle and immutable validity snapshot",async()=>{
    await command("resource.save",{...tool,processingValidityHours:36});
    const before=Date.now();
    for(const event of ["start","cleaned","sterilized","control_pass"])await command("resource.process",{id:tool.id,event});
    const resource=await current();
    expect(Date.parse(resource.readyUntil!)).toBeGreaterThanOrEqual(before+36*3600000);
    expect(Date.parse(resource.readyUntil!)).toBeLessThanOrEqual(Date.now()+36*3600000);
    const log=(await rows<{data:{validUntil:string;validityHours:number}}>("SELECT data FROM records WHERE kind='resource_cycle' AND data->>'event'='control_pass'"))[0].data;
    expect(log).toMatchObject({validUntil:resource.readyUntil,validityHours:36});
    await command("resource.save",{...resource,processingValidityHours:72});
    expect((await current()).readyUntil).toBe(resource.readyUntil);
    expect((await rows<{data:unknown}>("SELECT data FROM records WHERE kind='resource_cycle' AND data->>'event'='control_pass'"))[0].data).toEqual(log);
  });
  it("allows future reservations beyond current expiry but rechecks readiness at execution",async()=>{
    await saveRecord("resource",tool.id,{...tool,readyUntil:new Date(Date.now()+3600000).toISOString()});
    expect(await createBookingHold(input)).toHaveProperty("holdId");
    await saveRecord("resource",tool.id,tool);
    const id=await visit();
    await expect(command("visit.status",{id,version:1,status:"in_progress"})).rejects.toThrow("срок готовности истёк");
  });
  it("grandfathers initial demo readiness only until its next recorded processing cycle",async()=>{
    const legacy={...tool};delete legacy.readyUntil;
    await saveRecord("resource",tool.id,legacy);
    expect(await createBookingHold(input)).toHaveProperty("holdId");
    for(const event of ["start","cleaned","sterilized","control_pass"])await command("resource.process",{id:tool.id,event});
    expect((await current()).readyUntil).toBeTruthy();
  });
});
