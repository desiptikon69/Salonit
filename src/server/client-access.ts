import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/lib/contracts";
import { first, pool, transaction, type SqlClient } from "./db";
import { audit, getRecord, saveRecord } from "./records";
import { AppError } from "./errors";

function check(condition:unknown,status:number,message:string,code="VALIDATION_ERROR"):asserts condition {
  if(!condition)throw new AppError(status,message,code);
}

const cookieName = "salonit_client_device";
const lifetime = 365 * 24 * 60 * 60;
type Access = { accountId:string; clientId:string; keyHash:string; version:number };
type Device = { accountId:string; clientId:string; version:number; expiresAt:string };
type PhoneAccount = { id:string; role:string; client_id:string|null };
const digest = (value:string) => createHash("sha256").update(value).digest("hex");
const credentialId = (accountId:string) => "client-access:" + accountId;
const newSecret = () => randomBytes(32).toString("base64url");
function equalHash(value:string, hash:string) {
  return /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(digest(value),"hex"),Buffer.from(hash,"hex"));
}
function deviceToken(headers:Headers) {
  const cookie=headers.get("cookie")?.split(";").map(value=>value.trim()).find(value=>value.startsWith(cookieName+"="));
  return cookie?.slice(cookieName.length+1) ?? "";
}
export function clientDeviceCookie(token:string) {
  const secure = process.env.BETTER_AUTH_URL?.startsWith("https:") ? "; Secure" : "";
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${secure}`;
}
export async function hasClientDeviceProof(accountId:string, clientId:string|null, headers:Headers, client:SqlClient=pool) {
  const token=deviceToken(headers);
  if(!clientId||!/^[A-Za-z0-9_-]{43}$/.test(token))return false;
  const access=await getRecord<Access>("client_access",credentialId(accountId),client);
  const device=await getRecord<Device>("client_device","client-device:"+digest(token),client);
  return !!access && !!device && access.accountId===accountId && access.clientId===clientId && device.accountId===accountId && device.clientId===clientId && device.version===access.version && Date.parse(device.expiresAt)>Date.now();
}
export async function requirePhoneOwnership(phone:string, headers:Headers, accessKey?:string, client:SqlClient=pool):Promise<PhoneAccount|undefined> {
  const account=await first<PhoneAccount>('SELECT id,role,client_id FROM auth."user" WHERE phone_number=$1',[phone],client);
  if(!account)return undefined;
  // Team accounts cannot acquire client access through the public phone flow.
  check(account.role==="client",403,"Для этого аккаунта используйте вход команды","OWNERSHIP_REQUIRED");
  if(await hasClientDeviceProof(account.id,account.client_id,headers,client))return account;
  const access=await getRecord<Access>("client_access",credentialId(account.id),client);
  if(access && account.client_id===access.clientId && accessKey && equalHash(accessKey,access.keyHash))return account;
  throw new AppError(403,"Для входа с нового устройства нужен личный ключ доступа. Если ключ утерян, обратитесь к администратору салона для проверки владельца.","OWNERSHIP_REQUIRED");
}
// Serialize account creation and recovery with confirmation for this phone. The
// auth adapter owns separate transactions, so use a dedicated advisory session lock.
export async function withPhoneOwnership<T>(phone:string, headers:Headers, accessKey:string|undefined, fn:(existing:PhoneAccount|undefined)=>Promise<T>) {
  const lock=await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))",["client-access-phone:"+phone]);
    const existing=await requirePhoneOwnership(phone,headers,accessKey,lock);
    return await fn(existing);
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",["client-access-phone:"+phone]);
    lock.release();
  }
}
export async function issueClientDevice(actor:Actor, allowFirstKey:boolean) {
  check(actor.role==="client"&&actor.clientId,403,"Клиентский аккаунт не связан с карточкой");
  const clientId=actor.clientId;
  return transaction(async client=>{
    const user=await first<{client_id:string}>('SELECT client_id FROM auth."user" WHERE id=$1 FOR UPDATE',[actor.id],client);
    check(user?.client_id===actor.clientId,409,"Связь аккаунта изменилась");
    let access=await getRecord<Access>("client_access",credentialId(actor.id),client,true);
    let accessKey:string|undefined;
    if(!access) {
      check(allowFirstKey,403,"Восстановите доступ через администратора салона","OWNERSHIP_REQUIRED");
      accessKey=newSecret();
      access={accountId:actor.id,clientId,keyHash:digest(accessKey),version:1};
      await saveRecord("client_access",credentialId(actor.id),access,client);
    }
    check(access.clientId===actor.clientId,403,"Связь доступа изменилась","OWNERSHIP_REQUIRED");
    const device=newSecret();
    await saveRecord("client_device","client-device:"+digest(device),{accountId:actor.id,clientId:actor.clientId,version:access.version,expiresAt:new Date(Date.now()+lifetime*1000).toISOString()},client);
    return {accessKey,cookie:clientDeviceCookie(device)};
  });
}

export function nativePhoneRouteBlocked(request:Request) {
  const path=new URL(request.url).pathname;
  return path.startsWith("/api/auth/phone-number/")||path==="/api/auth/sign-in/phone-number";
}

export async function runClientAccessCommand(actor:Actor,action:string,payload:unknown,commandId:string):Promise<{clientId:string;reset:true;accessKey?:string;replayed?:true}> {
  check(actor.role==="owner"||actor.role==="admin",403,"Восстановление доступа доступно владельцу и администратору");
  check(action==="client.access.reset",400,"Неизвестная команда восстановления");
  const p=z.object({clientId:z.string().min(1).max(200),evidence:z.string().trim().min(10).max(3000),reason:z.string().trim().min(10).max(1000)}).parse(payload);
  z.string().min(8).max(200).parse(commandId);
  // Same lock as the phone confirmation prevents an old device winning a race.
  const target=await first<{id:string;phone_number:string|null}>('SELECT id,phone_number FROM auth."user" WHERE client_id=$1',[p.clientId]);
  check(target?.phone_number,404,"Для карточки нет связанного телефонного аккаунта");
  const lock=await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))",["client-access-phone:"+target.phone_number]);
    return await transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["command:"+commandId]);
      const replay=await first<{actor_id:string;action:string;result:Record<string,unknown>}>("SELECT actor_id,action,result FROM commands WHERE id=$1",[commandId],client);
      if(replay) { check(replay.actor_id===actor.id&&replay.action===action&&replay.result.clientId===p.clientId,409,"Ключ команды уже использован");return {clientId:p.clientId,reset:true,replayed:true}; }
      const user=await first<{id:string;client_id:string}>('SELECT id,client_id FROM auth."user" WHERE id=$1 FOR UPDATE',[target.id],client);
      const person=await getRecord<{accountId?:string}>("client",p.clientId,client,true);
      check(user?.client_id===p.clientId&&person?.accountId===user.id,409,"Подтвердите фактическую связь карточки и аккаунта");
      const previous=await getRecord<Access>("client_access",credentialId(user.id),client,true);
      const accessKey=newSecret();
      await saveRecord("client_access",credentialId(user.id),{accountId:user.id,clientId:p.clientId,keyHash:digest(accessKey),version:(previous?.version??0)+1},client);
      await client.query("DELETE FROM records WHERE kind='client_device' AND data->>'accountId'=$1",[user.id]);
      await client.query("DELETE FROM auth.session WHERE user_id=$1",[user.id]);
      await audit(client,actor,action,p.clientId,{accountId:user.id,evidence:p.evidence,reason:p.reason,reviewedAt:new Date().toISOString()});
      const result={clientId:p.clientId,reset:true as const};
      await client.query("INSERT INTO commands(id,actor_id,action,result) VALUES($1,$2,$3,$4)",[commandId,actor.id,action,JSON.stringify(result)]);
      return {...result,accessKey};
    });
  } finally { await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",["client-access-phone:"+target.phone_number]);lock.release(); }
}
