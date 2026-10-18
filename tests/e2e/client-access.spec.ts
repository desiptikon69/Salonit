import {test,expect,type APIRequestContext} from "@playwright/test";
const origin="http://127.0.0.1:3000";
async function post(api:APIRequestContext,path:string,data:unknown){const result=await api.post(path,{headers:{Origin:origin},data});return {status:result.status(),body:await result.json()};}
test("phone OTP on a new device requires a personal key; managed reset revokes old access",async({browser,playwright})=>{
 const phone="+7901"+String(Date.now()).slice(-7);
 const first=await browser.newContext(),second=await browser.newContext();
 const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
 const hold=async(api:APIRequestContext,offset:number)=>{const {slots}=await (await api.get(`${origin}/api/booking/slots?date=${day(offset)}&services=hair-men&mode=sequential`)).json();expect(slots.length).toBeGreaterThan(0);const result=await post(api,origin+"/api/booking/hold",{serviceIds:["hair-men"],mode:"sequential",startAt:slots[0].startAt,name:"Тест владения карточкой",phone});expect(result.status).toBe(200);return result.body;};
 const otp=async(api:APIRequestContext)=>{const result=await post(api,origin+"/api/booking/otp",{phone});expect(result.status).toBe(200);return result.body.demoCode as string;};
 const initial=await hold(first.request,9);const created=await post(first.request,origin+"/api/booking/confirm",{...initial,phone,code:await otp(first.request)});expect(created.status).toBe(200);expect(created.body.accessKey).toBeTruthy();
 expect((await first.request.get(origin+"/api/portal")).status()).toBe(200);
 const next=await hold(second.request,10),code=await otp(second.request);
 const denied=await post(second.request,origin+"/api/booking/confirm",{...next,phone,code});expect(denied.status).toBe(403);expect(denied.body.code).toBe("OWNERSHIP_REQUIRED");
 expect((await second.request.get(origin+"/api/portal")).status()).toBe(401);
 const allowed=await post(second.request,origin+"/api/booking/confirm",{...next,phone,code,accessKey:created.body.accessKey});expect(allowed.status).toBe(200);expect(allowed.body.accessKey).toBeUndefined();
 const portal=await (await second.request.get(origin+"/api/portal")).json();expect(portal.visits).toHaveLength(2);
 const admin=await playwright.request.newContext();expect((await post(admin,origin+"/api/demo/login",{role:"owner"})).status).toBe(200);
 const reset=await post(admin,origin+"/api/commands",{action:"client.access.reset",payload:{clientId:created.body.visit.clientId,evidence:"Личная проверка владельца по независимым сведениям",reason:"Проверка отзыва устройств в тестовом сценарии"},commandId:crypto.randomUUID()});expect(reset.status).toBe(200);expect(reset.body.result.accessKey).toBeTruthy();
 expect((await first.request.get(origin+"/api/portal")).status()).toBe(401);expect((await second.request.get(origin+"/api/portal")).status()).toBe(401);
 expect((await post(second.request,origin+"/api/auth/phone-number/verify",{phoneNumber:phone,code:"000000"})).status).toBe(403);
 await first.close();await second.close();await admin.dispose();
});
