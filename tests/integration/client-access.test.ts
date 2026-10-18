import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../src/lib/contracts";
import { pool, rows } from "../../src/server/db";
import { saveRecord } from "../../src/server/records";
import { auth, getActor } from "../../src/server/auth";
import { sessionFromResponse } from "../../src/server/http";
import { hasClientDeviceProof, issueClientDevice, requirePhoneOwnership, runClientAccessCommand } from "../../src/server/client-access";
import { POST as confirm } from "../../src/app/api/booking/confirm/route";
import { GET as nativeGet, POST as nativePost } from "../../src/app/api/auth/[...all]/route";

const suffix=randomUUID();
const accountId="access-test:"+suffix, clientId="access-person:"+suffix;
const phone="+79008881234";
const actor:Actor={id:accountId,name:"Access Test",role:"client",clientId};
const owner:Actor={id:"access-owner:"+suffix,name:"Access Owner",role:"owner"};
const deviceHeaders=(cookie:string)=>new Headers({cookie:cookie.split(";")[0]});
const origin=process.env.BETTER_AUTH_URL??"http://localhost:3000";
const request=(path:string,body:unknown)=>new Request(origin+path,{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(body)});

describe("Client ownership independent of phone OTP",()=>{
  beforeAll(async()=>{
    if(!process.env.DATABASE_URL?.includes("salonit_test"))throw new Error("Use isolated salonit_test database");
    await rows('INSERT INTO auth."user"(id,name,email,phone_number,phone_number_verified,role,client_id) VALUES($1,\'Access Test\',$2,$3,true,\'client\',$4)',[accountId,suffix+"@phone.salonit.invalid",phone,clientId]);
    await saveRecord("client",clientId,{name:"Access Test",phone,accountId});
  });
  beforeEach(async()=>{
    await rows("DELETE FROM records WHERE kind IN ('client_access','client_device') AND data->>'accountId'=$1",[accountId]);
    await rows("DELETE FROM auth.session WHERE user_id=$1",[accountId]);
  });
  afterAll(async()=>{
    await rows("DELETE FROM records WHERE id=$1 OR data->>'accountId'=$2",[clientId,accountId]);
    await rows("DELETE FROM commands WHERE actor_id=$1",[owner.id]);
    await rows("DELETE FROM audit_events WHERE entity_id=$1",[clientId]);
    await rows("DELETE FROM request_limits WHERE key=$1",["verify:"+phone]);
    await rows("DELETE FROM demo_otp WHERE phone=$1",[phone]);
    await rows('DELETE FROM auth."user" WHERE id=$1',[accountId]);
    await pool.end();
  });

  it("stores only high entropy key and device hashes and binds proof to account and client",async()=>{
    const issued=await issueClientDevice(actor,true);
    expect(issued.accessKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.cookie).toContain("HttpOnly; SameSite=Lax");
    const stored=await rows<{data:Record<string,unknown>}>("SELECT data FROM records WHERE data->>'accountId'=$1",[accountId]);
    expect(JSON.stringify(stored)).not.toContain(issued.accessKey!);
    expect(JSON.stringify(stored)).not.toContain(issued.cookie.split(";")[0].split("=")[1]);
    expect(await hasClientDeviceProof(accountId,clientId,deviceHeaders(issued.cookie))).toBe(true);
    expect(await hasClientDeviceProof("other",clientId,deviceHeaders(issued.cookie))).toBe(false);
    expect(await hasClientDeviceProof(accountId,"other",deviceHeaders(issued.cookie))).toBe(false);
    expect((await issueClientDevice(actor,false)).accessKey).toBeUndefined();
  });
  it("requires the key on a new device, including legacy accounts without a credential",async()=>{
    await expect(requirePhoneOwnership(phone,new Headers())).rejects.toMatchObject({code:"OWNERSHIP_REQUIRED"});
    const issued=await issueClientDevice(actor,true);
    await expect(requirePhoneOwnership(phone,new Headers(),"incorrect")).rejects.toMatchObject({code:"OWNERSHIP_REQUIRED"});
    expect((await requirePhoneOwnership(phone,new Headers(),issued.accessKey))?.id).toBe(accountId);
    expect((await requirePhoneOwnership(phone,deviceHeaders(issued.cookie)))?.id).toBe(accountId);
  });
  it("rejects unknown device before consuming an otherwise valid OTP",async()=>{
    await issueClientDevice(actor,true);
    await auth.api.sendPhoneNumberOTP({body:{phoneNumber:phone}});
    const otp=(await rows<{code:string}>("SELECT code FROM demo_otp WHERE phone=$1",[phone]))[0].code;
    const response=await confirm(request("/api/booking/confirm",{phone,code:otp,holdId:randomUUID(),holdToken:"x".repeat(43)}));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:"OWNERSHIP_REQUIRED"});
    const verified=await auth.api.verifyPhoneNumber({body:{phoneNumber:phone,code:otp},asResponse:true});
    expect(verified.ok).toBe(true);
    const internalActor=await sessionFromResponse(verified,phone);
    expect(internalActor.id).toBe(accountId);
    const headers=new Headers({cookie:verified.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ")});
    expect(await getActor(headers)).toBeNull();
    const device=await issueClientDevice(actor,false);
    headers.set("cookie",headers.get("cookie")+"; "+device.cookie.split(";")[0]);
    expect((await getActor(headers))?.clientId).toBe(clientId);
  });
  it("blocks native phone verification/send/update endpoints for both HTTP methods",async()=>{
    for(const path of ["send-otp","verify","update-phone-number","request-password-reset"]) {
      expect((await nativePost(request("/api/auth/phone-number/"+path,{phoneNumber:phone,code:"123456"}))).status).toBe(403);
      expect((await nativeGet(new Request(origin+"/api/auth/phone-number/"+path))).status).toBe(403);
    }
    expect((await nativePost(request("/api/auth/sign-in/phone-number",{phoneNumber:phone,password:"irrelevant"}))).status).toBe(403);
  });
  it("requires reviewed evidence, revokes sessions/proofs, and never repeats the replacement key",async()=>{
    const old=await issueClientDevice(actor,true);
    await rows('INSERT INTO auth.session(id,token,user_id,expires_at) VALUES($1,$2,$3,now()+interval \'1 day\')',["session:"+suffix,randomUUID(),accountId]);
    const payload={clientId,evidence:"Личная проверка владельца и известной записи в салоне",reason:"Клиент утратил личный ключ и сменил устройство"};
    await expect(runClientAccessCommand({...owner,role:"master"},"client.access.reset",payload,randomUUID())).rejects.toMatchObject({status:403});
    await expect(runClientAccessCommand(owner,"client.access.reset",{...payload,evidence:""},randomUUID())).rejects.toThrow();
    const command=randomUUID();
    const reset=await runClientAccessCommand(owner,"client.access.reset",payload,command);
    expect(reset).toHaveProperty("accessKey");
    expect(await rows("SELECT id FROM auth.session WHERE user_id=$1",[accountId])).toHaveLength(0);
    expect(await hasClientDeviceProof(accountId,clientId,deviceHeaders(old.cookie))).toBe(false);
    await expect(requirePhoneOwnership(phone,new Headers(),old.accessKey)).rejects.toMatchObject({code:"OWNERSHIP_REQUIRED"});
    expect((await requirePhoneOwnership(phone,new Headers(),String(reset.accessKey)))?.id).toBe(accountId);
    expect(await runClientAccessCommand(owner,"client.access.reset",payload,command)).toEqual({clientId,reset:true,replayed:true});
    const audit=(await rows<{details:Record<string,unknown>}>("SELECT details FROM audit_events WHERE entity_id=$1 AND action='client.access.reset'",[clientId]))[0];
    expect(audit.details.evidence).toBe(payload.evidence);
    const privateRows=await rows("SELECT result FROM commands WHERE id=$1",[command]);
    expect(JSON.stringify(privateRows)).not.toContain(String(reset.accessKey));
  });
});
