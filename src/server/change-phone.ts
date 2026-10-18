import { createHash, randomUUID } from "node:crypto";
import type { Actor, Client } from "@/lib/contracts";
import { auth, isDemo } from "./auth";
import { hasClientDeviceProof } from "./client-access";
import { first, pool, transaction, type SqlClient } from "./db";
import { AppError } from "./errors";
import { audit, getRecord, saveRecord } from "./records";

type UserPhone = { id:string; client_id:string|null; phone_number:string|null; phone_number_verified:boolean };
type Change = { changeId:string; accountId:string; clientId:string; oldPhone:string; phone:string; expiresAt:string; completedAt?:string };
const journalId=(accountId:string)=>"phone-change:"+accountId;
function check(value:unknown,status:number,message:string):asserts value { if(!value)throw new AppError(status,message); }

async function connection(actor:Actor,headers:Headers,sql:SqlClient=pool,lock=false) {
  check(actor.role==="client"&&actor.clientId,403,"Смена телефона доступна в личном кабинете клиента");
  check(await hasClientDeviceProof(actor.id,actor.clientId,headers,sql),403,"Подтвердите устройство личным ключом доступа");
  const user=await first<UserPhone>('SELECT id,client_id,phone_number,phone_number_verified FROM auth."user" WHERE id=$1'+(lock?' FOR UPDATE':''),[actor.id],sql);
  const person=await getRecord<Client>("client",actor.clientId,sql,lock);
  check(user?.client_id===actor.clientId&&person?.accountId===actor.id,409,"Связь профиля изменилась. Обратитесь к администратору");
  return {user,person};
}
async function withLocks<T>(actor:Actor,phones:string[],fn:()=>Promise<T>) {
  const sql=await pool.connect();
  const keys=["client-phone-account:"+actor.id,...[...new Set(phones)].sort().map(phone=>"client-access-phone:"+phone)];
  const acquired:string[]=[];
  try {
    for(const key of keys){await sql.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[key]);acquired.push(key);}
    return await fn();
  } finally {
    for(const key of acquired.reverse())await sql.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[key]);
    sql.release();
  }
}
async function unused(phone:string,accountId:string) {
  const other=await first('SELECT id FROM auth."user" WHERE phone_number=$1 AND id<>$2',[phone,accountId]);
  check(!other,409,"Номер уже связан с аккаунтом. Обратитесь к администратору для проверки; объединение профилей автоматически не выполняется");
}
async function finish(actor:Actor,headers:Headers,change:Change) {
  return transaction(async sql=>{
    const {user,person}=await connection(actor,headers,sql,true);
    const saved=await getRecord<Change>("phone_change",journalId(actor.id),sql,true);
    check(saved?.changeId===change.changeId,409,"Запрос на смену номера изменился");
    check(user.phone_number===saved.phone&&user.phone_number_verified,409,"Новый номер ещё не подтверждён");
    if(!saved.completedAt){
      // Release the original synthetic email too, so a future owner of the old
      // number can create their own account without inheriting this profile.
      const oldAlias=saved.oldPhone.replace(/\D/g,"")+"@phone.salonit.invalid";
      const stableAlias="account-"+createHash("sha256").update(actor.id).digest("hex")+"@phone.salonit.invalid";
      await sql.query('UPDATE auth."user" SET email=$1 WHERE id=$2 AND email=$3',[stableAlias,actor.id,oldAlias]);
      await saveRecord("client",person.id,{...person,phone:saved.phone},sql);
      await saveRecord("phone_change",journalId(actor.id),{...saved,completedAt:new Date().toISOString()},sql);
      await audit(sql,actor,"client.phone.change",person.id,{oldPhone:saved.oldPhone,phone:saved.phone,changeId:saved.changeId});
    }
    return {ok:true,phone:saved.phone};
  });
}
export async function startPhoneChange(actor:Actor,headers:Headers,phone:string) {
  const initial=await connection(actor,headers);
  return withLocks(actor,[initial.user.phone_number??"",phone],async()=>{
    const {user}=await connection(actor,headers);
    const previous=await getRecord<Change>("phone_change",journalId(actor.id));
    // A crash after Better Auth changed the number is reconciled before replacing the journal.
    if(previous&&!previous.completedAt&&user.phone_number===previous.phone&&user.phone_number_verified)await finish(actor,headers,previous);
    check(user.phone_number!==phone,400,"Этот номер уже указан в профиле");
    await unused(phone,actor.id);
    const change:Change={changeId:randomUUID(),accountId:actor.id,clientId:actor.clientId!,oldPhone:user.phone_number??"",phone,expiresAt:new Date(Date.now()+300000).toISOString()};
    await saveRecord("phone_change",journalId(actor.id),change);
    const response=await auth.api.sendPhoneNumberOTP({body:{phoneNumber:phone},headers,asResponse:true});
    check(response.ok,response.status,"Не удалось отправить код. Повторите запрос");
    const otp=isDemo()?await first<{code:string}>("SELECT code FROM demo_otp WHERE phone=$1 AND expires_at>now()",[phone]):undefined;
    return {ok:true,changeId:change.changeId,phone,expiresAt:change.expiresAt,...(otp?{demoCode:otp.code}:{})};
  });
}
export async function confirmPhoneChange(actor:Actor,headers:Headers,changeId:string,code:string) {
  await connection(actor,headers);
  const initial=await getRecord<Change>("phone_change",journalId(actor.id));
  check(initial?.changeId===changeId,409,"Запрос смены номера не найден. Запросите новый код");
  return withLocks(actor,[initial.oldPhone,initial.phone],async()=>{
    const {user}=await connection(actor,headers);
    const change=await getRecord<Change>("phone_change",journalId(actor.id));
    check(change?.changeId===changeId&&change.accountId===actor.id&&change.clientId===actor.clientId,409,"Запрос смены номера изменился");
    if(user.phone_number===change.phone&&user.phone_number_verified)return finish(actor,headers,change);
    check(!change.completedAt&&Date.parse(change.expiresAt)>Date.now(),410,"Код истёк. Запросите новый код");
    check(user.phone_number===change.oldPhone,409,"Телефон аккаунта изменился. Обратитесь к администратору");
    await unused(change.phone,actor.id);
    const response=await auth.api.verifyPhoneNumber({body:{phoneNumber:change.phone,code,updatePhoneNumber:true},headers,asResponse:true});
    check(response.ok,response.status,"Не удалось подтвердить код. Проверьте код или запросите новый");
    // Auth and application storage use distinct transactions. This durable journal
    // lets a retry complete the profile/audit after a crash without reusing the OTP.
    return finish(actor,headers,change);
  });
}
