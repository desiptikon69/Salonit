import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../src/lib/contracts";
import { auth, getActor } from "../../src/server/auth";
import { hasClientDeviceProof, issueClientDevice, requirePhoneOwnership } from "../../src/server/client-access";
import { confirmPhoneChange, startPhoneChange } from "../../src/server/change-phone";
import { first, pool, rows } from "../../src/server/db";
import { getRecord, saveRecord } from "../../src/server/records";
import { POST as send } from "../../src/app/api/account/phone/otp/route";
import { POST as confirm } from "../../src/app/api/account/phone/confirm/route";

const suffix=randomUUID(), accountId="phone-change:"+suffix, clientId="phone-person:"+suffix;
const oldPhone="+79008882341", newPhone="+79008882342", occupiedPhone="+79008882343";
const actor:Actor={id:accountId,name:"Phone Test",role:"client",clientId};
const origin=process.env.BETTER_AUTH_URL??"http://localhost:3000";
let headers:Headers, deviceCookie:string, accessKey:string;
async function code(phone:string){return (await first<{code:string}>("SELECT code FROM demo_otp WHERE phone=$1",[phone]))!.code;}
function request(path:string,body:unknown,authenticated=true,requestOrigin=origin) {
  const h=new Headers(authenticated?headers:undefined);
  h.set("content-type","application/json");h.set("origin",requestOrigin);
  return new Request(origin+path,{method:"POST",headers:h,body:JSON.stringify(body)});
}
describe("Verified client phone changes",()=>{
  beforeAll(()=>{if(!process.env.DATABASE_URL?.includes("salonit_test"))throw new Error("Use isolated salonit_test database");});
  beforeEach(async()=>{
    await rows('DELETE FROM auth."user" WHERE phone_number=ANY($1::text[]) OR id=$2',[[oldPhone,newPhone,occupiedPhone],accountId]);
    await rows("DELETE FROM records WHERE data->>'accountId'=$1 OR id=$2",[accountId,clientId]);
    await rows("DELETE FROM request_limits WHERE key LIKE 'phone-change-%'");
    await rows('INSERT INTO auth."user"(id,name,email,phone_number,phone_number_verified,role,client_id) VALUES($1,\'Phone Test\',$2,$3,true,\'client\',$4)',[accountId,oldPhone.replace(/\D/g,"")+"@phone.salonit.invalid",oldPhone,clientId]);
    await saveRecord("client",clientId,{name:"Phone Test",phone:oldPhone,accountId});
    await auth.api.sendPhoneNumberOTP({body:{phoneNumber:oldPhone}});
    const session=await auth.api.verifyPhoneNumber({body:{phoneNumber:oldPhone,code:await code(oldPhone)},asResponse:true});
    expect(session.ok).toBe(true);
    const device=await issueClientDevice(actor,true);deviceCookie=device.cookie;accessKey=device.accessKey!;
    headers=new Headers({cookie:[...session.headers.getSetCookie().map(v=>v.split(";")[0]),deviceCookie.split(";")[0]].join("; ")});
  });
  afterAll(async()=>{
    await rows("DELETE FROM audit_events WHERE entity_id=$1",[clientId]);
    await rows("DELETE FROM records WHERE data->>'accountId'=$1 OR id=$2",[accountId,clientId]);
    await rows('DELETE FROM auth."user" WHERE phone_number=ANY($1::text[]) OR id=$2',[[oldPhone,newPhone,occupiedPhone],accountId]);
    await rows("DELETE FROM demo_otp WHERE phone=ANY($1::text[])",[[oldPhone,newPhone,occupiedPhone]]);
    await rows("DELETE FROM request_limits WHERE key LIKE 'phone-change-%'");
    await pool.end();
  });
  it("changes only the proven client's number, preserving account, key, device and visits identity",async()=>{
    const sent=await send(request("/api/account/phone/otp",{phone:newPhone}));
    expect(sent.status).toBe(200);
    const pending=await sent.json();expect(pending.demoCode).toBe(await code(newPhone));
    const verified=await confirm(request("/api/account/phone/confirm",{changeId:pending.changeId,code:pending.demoCode}));
    expect(verified.status).toBe(200);expect(await verified.json()).toEqual({ok:true,phone:newPhone});
    expect(await getActor(headers)).toMatchObject({id:accountId,clientId});
    expect(await getRecord("client",clientId)).toMatchObject({phone:newPhone,accountId});
    expect(await hasClientDeviceProof(accountId,clientId,headers)).toBe(true);
    expect((await requirePhoneOwnership(newPhone,new Headers(),accessKey))?.id).toBe(accountId);
    expect(await requirePhoneOwnership(oldPhone,new Headers())).toBeUndefined();
    expect(await auth.api.verifyPhoneNumber({body:{phoneNumber:newPhone,code:pending.demoCode},headers,asResponse:true})).toHaveProperty("ok",false);
  });
  it("denies an unproven device and cross-origin requests before sending OTP",async()=>{
    expect((await send(request("/api/account/phone/otp",{phone:newPhone},false))).status).toBe(401);
    const h=new Headers(headers);h.set("cookie",h.get("cookie")!.split(";").filter(v=>!v.trim().startsWith("salonit_client_device=")).join(";"));
    const unproven=request("/api/account/phone/otp",{phone:newPhone});
    expect((await send(new Request(unproven,{headers:h}))).status).toBe(403); // no origin is also rejected
    expect((await send(request("/api/account/phone/otp",{phone:newPhone},true,"https://other.invalid"))).status).toBe(403);
    await expect(startPhoneChange(actor,h,newPhone)).rejects.toMatchObject({status:403});
  });
  it("refuses another account's number and a broken account-to-client link without merging",async()=>{
    await rows('INSERT INTO auth."user"(id,name,email,phone_number,role) VALUES($1,\'Other\',$2,$3,\'client\')',["phone-occupied:"+suffix,suffix+"@other.invalid",occupiedPhone]);
    await expect(startPhoneChange(actor,headers,occupiedPhone)).rejects.toMatchObject({status:409});
    await saveRecord("client",clientId,{name:"Other link",phone:oldPhone,accountId:"someone-else"});
    await expect(startPhoneChange(actor,headers,newPhone)).rejects.toMatchObject({status:409});
    expect((await first<{phone_number:string}>('SELECT phone_number FROM auth."user" WHERE id=$1',[accountId]))?.phone_number).toBe(oldPhone);
  });
  it("rejects incorrect and expired codes without changing contacts",async()=>{
    const pending=await startPhoneChange(actor,headers,newPhone);
    const wrong=pending.demoCode==="000000"?"111111":"000000";
    await expect(confirmPhoneChange(actor,headers,pending.changeId,wrong)).rejects.toMatchObject({status:400});
    const journal=await getRecord<Record<string,unknown>>("phone_change","phone-change:"+accountId);
    await saveRecord("phone_change","phone-change:"+accountId,{...journal,expiresAt:new Date(Date.now()-1000).toISOString()});
    await expect(confirmPhoneChange(actor,headers,pending.changeId,pending.demoCode!)).rejects.toMatchObject({status:410});
    expect(await getRecord("client",clientId)).toMatchObject({phone:oldPhone});
  });
  it("resumes an interrupted auth-to-profile update and audits exactly once",async()=>{
    const pending=await startPhoneChange(actor,headers,newPhone);
    const authOnly=await auth.api.verifyPhoneNumber({body:{phoneNumber:newPhone,code:pending.demoCode!,updatePhoneNumber:true},headers,asResponse:true});
    expect(authOnly.ok).toBe(true);
    expect(await getRecord("client",clientId)).toMatchObject({phone:oldPhone});
    const previous=(await rows("SELECT id FROM audit_events WHERE entity_id=$1 AND action='client.phone.change'",[clientId])).length;
    expect(await confirmPhoneChange(actor,headers,pending.changeId,"000000")).toEqual({ok:true,phone:newPhone});
    expect(await confirmPhoneChange(actor,headers,pending.changeId,"000000")).toEqual({ok:true,phone:newPhone});
    expect((await rows("SELECT id FROM audit_events WHERE entity_id=$1 AND action='client.phone.change'",[clientId])).length).toBe(previous+1);
  });
  it("lets a future old-number owner create a separate account without the previous client's history",async()=>{
    const pending=await startPhoneChange(actor,headers,newPhone);
    await confirmPhoneChange(actor,headers,pending.changeId,pending.demoCode!);
    await auth.api.sendPhoneNumberOTP({body:{phoneNumber:oldPhone}});
    const fresh=await auth.api.verifyPhoneNumber({body:{phoneNumber:oldPhone,code:await code(oldPhone)},asResponse:true});
    expect(fresh.ok).toBe(true);
    const other=await first<{id:string;client_id:string|null}>('SELECT id,client_id FROM auth."user" WHERE phone_number=$1',[oldPhone]);
    expect(other?.id).not.toBe(accountId);expect(other?.client_id).toBeNull();
    expect(await getRecord("client",clientId)).toMatchObject({phone:newPhone,accountId});
  });
});
