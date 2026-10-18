import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Actor, Client, Resource, Service, Shift, Slot, Staff, Visit, VisitItem } from "@/lib/contracts";
import { overlaps, planVisit, resourceReady, type Allocation, type Plan } from "@/domain/scheduling";
import { first, pool, rows, transaction, type SqlClient } from "./db";
import { audit, getRecord, listRecords, saveRecord } from "./records";
import { AppError, requireCondition as check } from "./errors";
import { authorize } from "./permissions";
import { clientVisit } from "./queries";

const selection = z.object({ serviceIds: z.array(z.string().min(1).max(100)).min(1).max(6), mode: z.enum(["sequential", "parallel"]), staffId: z.string().min(1).max(100).optional() });
const start = z.string().datetime({ offset: true });
const holdSchema = selection.extend({ startAt: start, name: z.string().trim().min(2).max(100), phone: z.string().regex(/^\+7\d{10}$/) });
const confirmationSchema = z.object({ holdId: z.string().uuid(), holdToken: z.string().min(40).max(100), phone: z.string().regex(/^\+7\d{10}$/) });
type Selection = z.infer<typeof selection>;
type StoredVisit = { id:string;reference:string;client_id:string;status:Visit["status"];start_at:Date;end_at:Date;items:VisitItem[];total_minor:string;paid_minor:string;materials:Visit["materials"];version:number;receipt_status:string;note:string;closed_at:Date|null;parent_id:string|null;hold_phone:string|null;hold_token_hash:string|null;hold_expires_at:Date|null };
const iso = (date:Date|string|number) => new Date(date).toISOString();
const day = (date:Date|string|number) => new Intl.DateTimeFormat("en-CA", {timeZone:"Europe/Moscow"}).format(new Date(date));
const hash = (value:string) => createHash("sha256").update(value).digest("hex");
const clockMinutes = (value:string) => { const [h,m] = value.split(":").map(Number); return h*60+m; };
const localMinutes = (value:string) => clockMinutes(new Intl.DateTimeFormat("en-GB", {timeZone:"Europe/Moscow",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value)));

async function translate<T>(work:()=>Promise<T>):Promise<T> {
  try { return await work(); } catch(error) {
    if(error instanceof z.ZodError) throw new AppError(400,error.issues.map(i=>i.message).join("; "));
    if((error as {code?:string})?.code==="23P01") throw new AppError(409,"Это время уже занято. Выберите другое");
    throw error;
  }
}
function validateFuture(startAt:string) {
  const value=new Date(startAt).getTime();
  check(value>Date.now()+60000&&value<Date.now()+61*86400000,400,"Выберите время от текущего момента до 60 дней вперёд");
}
async function bookingLock(tx:SqlClient) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('booking',0))");
  await tx.query("UPDATE allocations SET active=false WHERE appointment_id IN (SELECT id FROM appointments WHERE status='hold' AND hold_expires_at<=now())");
  await tx.query("UPDATE appointments SET status='cancelled',version=version+1 WHERE status='hold' AND hold_expires_at<=now()");
}
async function busyAllocations(tx:SqlClient, excludeId?:string):Promise<Allocation[]> {
  const result=await rows<{resource_key:string;start_at:Date;end_at:Date}>("SELECT a.resource_key,a.start_at,a.end_at FROM allocations a JOIN appointments v ON v.id=a.appointment_id WHERE a.active AND (v.status<>'hold' OR v.hold_expires_at>now()) AND ($1::uuid IS NULL OR v.id<>$1)",[excludeId??null],tx);
  const clients=await rows<{client_id:string;start_at:Date;end_at:Date}>("SELECT client_id,start_at,end_at FROM appointments WHERE client_id<>'' AND status IN ('confirmed','arrived','in_progress','completed') AND closed_at IS NULL AND ($1::uuid IS NULL OR id<>$1)",[excludeId??null],tx);
  return [...result.map(a=>({resourceKey:a.resource_key,startAt:iso(a.start_at),endAt:iso(a.end_at)})),...clients.map(v=>({resourceKey:"client:"+v.client_id,startAt:iso(v.start_at),endAt:iso(v.end_at)}))];
}
async function scheduleData(tx:SqlClient,date:string) {
  const allStaff=await listRecords<Staff>("staff",tx);
  const resources=await listRecords<Resource>("resource",tx);
  const shifts=await listRecords<Shift>("shift",tx);
  const staff=allStaff.flatMap(member=>{
    const entries=shifts.filter(s=>s.staffId===member.id&&s.date===date);
    if(!entries.length) return [member];
    const available=entries.filter(s=>["planned","confirmed","active"].includes(s.status));
    return available.map(s=>({...member,workStart:s.start,workEnd:s.end}));
  });
  return {staff,resources};
}
async function newPlan(tx:SqlClient,p:Selection,startAt:string,busy:Allocation[]):Promise<Plan> {
  const allServices=await listRecords<Service>("service",tx);
  const schedule=await scheduleData(tx,day(startAt));
  const services=p.serviceIds.map(id=>allServices.find(s=>s.id===id));
  check(services.every(Boolean),400,"Услуга не найдена");
  const plan=planVisit({services:services as Service[],...schedule,startAt,mode:p.mode,busy,staffId:p.staffId});
  check(plan,409,"Нет свободного мастера, места или готовых инструментов");
  return plan;
}
async function insertAllocations(tx:SqlClient,id:string,allocations:Allocation[]) {
  for(const a of allocations) await tx.query("INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at) VALUES($1,$2,$3,$4,$5)",[randomUUID(),id,a.resourceKey,a.startAt,a.endAt]);
}
async function visitDto(tx:SqlClient,v:StoredVisit):Promise<Visit> {
  const client=await getRecord<Client>("client",v.client_id,tx);
  return {id:v.id,reference:v.reference,clientId:v.client_id,clientName:client?.name??"",clientPhone:client?.phone??"",startAt:iso(v.start_at),endAt:iso(v.end_at),status:v.status,items:v.items,totalMinor:Number(v.total_minor),paidMinor:Number(v.paid_minor),materials:v.materials,version:v.version,receiptStatus:v.receipt_status,note:v.note,closedAt:v.closed_at?iso(v.closed_at):null,parentId:v.parent_id};
}
async function readVisit(tx:SqlClient,id:string,lock=false) {
  const result=await first<StoredVisit>(`SELECT * FROM appointments WHERE id=$1${lock?" FOR UPDATE":""}`,[id],tx);
  check(result,404,"Визит не найден"); return result;
}
function canMove(actor:Actor,v:StoredVisit) {
  authorize(actor,["owner","admin","client"]);
  check(actor.role!=="client"||actor.clientId===v.client_id,403,"Нельзя перенести чужой визит");
  check(v.status==="confirmed"&&!v.closed_at,409,"Перенести можно только подтверждённый визит");
  check(actor.role!=="client"||v.start_at.getTime()>Date.now(),409,"Время визита уже наступило. Обратитесь к администратору");
}
async function shiftedPlan(tx:SqlClient,v:StoredVisit,startAt:string,busy:Allocation[]):Promise<Plan> {
  const offset=new Date(startAt).getTime()-v.start_at.getTime();
  const shift=(value:Date|string)=>iso(new Date(value).getTime()+offset);
  const old=await rows<{resource_key:string;start_at:Date;end_at:Date}>("SELECT resource_key,start_at,end_at FROM allocations WHERE appointment_id=$1 AND resource_key NOT LIKE 'client:%'",[v.id],tx);
  check(old.length>0,409,"У визита отсутствует схема ресурсов");
  const allocations=old.map(a=>({resourceKey:a.resource_key,startAt:shift(a.start_at),endAt:shift(a.end_at)}));
  allocations.push({resourceKey:"client:"+v.client_id,startAt,endAt:shift(v.end_at)});
  const schedule=await scheduleData(tx,day(startAt));
  for(const a of allocations) {
    check(day(a.startAt)===day(a.endAt),409,"Визит должен завершиться в тот же день");
    check(!busy.some(b=>b.resourceKey===a.resourceKey&&overlaps(Date.parse(a.startAt),Date.parse(a.endAt),Date.parse(b.startAt),Date.parse(b.endAt))),409,"Выбранное время занято");
    if(a.resourceKey.startsWith("staff:")) check(schedule.staff.some(s=>s.id===a.resourceKey.slice(6)&&s.active&&localMinutes(a.startAt)>=clockMinutes(s.workStart)&&localMinutes(a.endAt)<=clockMinutes(s.workEnd)),409,"Мастер не работает в это время");
    if(a.resourceKey.startsWith("resource:")) check(schedule.resources.some(r=>r.id===a.resourceKey.slice(9)&&resourceReady(r)),409,"Ресурс не готов к использованию");
  }
  return {startAt:iso(startAt),endAt:shift(v.end_at),items:v.items.map(i=>({...i,startAt:shift(i.startAt),endAt:shift(i.endAt),reservations:i.reservations?.map(r=>({...r,startAt:shift(r.startAt),endAt:shift(r.endAt)}))})),allocations,totalMinor:Number(v.total_minor)};
}

export async function getBookingSlots(input:Selection & {date:string;visitId?:string},actor?:Actor|null):Promise<Slot[]> {
  return translate(async()=>{
    const p=selection.extend({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),visitId:z.string().uuid().optional()}).parse(input);
    const startDay=Date.parse(p.date+"T00:00:00+03:00");
    check(Number.isFinite(startDay)&&day(startDay)===p.date,400,"Некорректная дата");
    check(p.date>=day(Date.now())&&startDay<Date.now()+61*86400000,400,"Дата вне доступного периода");
    let moving:StoredVisit|undefined;
    if(p.visitId) { authorize(actor??null,["owner","admin","client"]);moving=await readVisit(pool,p.visitId);canMove(actor!,moving); }
    const busy=await busyAllocations(pool,p.visitId), result:Slot[]=[];
    for(let minute=0;minute<24*60;minute+=30) {
      const startAt=iso(startDay+minute*60000); if(Date.parse(startAt)<=Date.now()+60000) continue;
      try {
        const plan=moving?await shiftedPlan(pool,moving,startAt,busy):await newPlan(pool,p,startAt,busy);
        if(actor?.clientId&&busy.some(b=>b.resourceKey==="client:"+actor.clientId&&overlaps(Date.parse(startAt),Date.parse(plan.endAt),Date.parse(b.startAt),Date.parse(b.endAt)))) continue;
        result.push({startAt:plan.startAt,endAt:plan.endAt,priceMinor:plan.totalMinor,staffNames:[...new Set(plan.items.filter(i=>i.status!=="cancelled").map(i=>i.staffName))]});
      } catch(error) { if(!(error instanceof AppError&&error.status===409)) throw error; }
    }
    return result;
  });
}

export async function createBookingHold(payload:unknown) {
  return translate(async()=>{
    const p=holdSchema.parse(payload);validateFuture(p.startAt);
    return transaction(async tx=>{
      await bookingLock(tx);
      const count=await first<{n:string}>("SELECT count(*) n FROM appointments WHERE status='hold' AND hold_phone=$1 AND hold_expires_at>now()",[p.phone],tx);
      check(Number(count?.n??0)<3,429,"Слишком много незавершённых записей. Подождите 10 минут");
      const plan=await newPlan(tx,p,p.startAt,await busyAllocations(tx));
      const id=randomUUID(),token=randomBytes(32).toString("base64url"),expiresAt=iso(Date.now()+10*60000);
      await tx.query("INSERT INTO appointments(id,reference,status,start_at,end_at,items,total_minor,hold_token_hash,hold_phone,hold_expires_at) VALUES($1,$2,'hold',$3,$4,$5,$6,$7,$8,$9)",[id,"SI-"+id.slice(0,8).toUpperCase(),plan.startAt,plan.endAt,JSON.stringify(plan.items),plan.totalMinor,hash(token),p.phone,expiresAt]);
      await saveRecord("hold_profile","hold:"+id,{name:p.name,phone:p.phone},tx);
      await insertAllocations(tx,id,plan.allocations);
      return {holdId:id,holdToken:token,expiresAt,totalMinor:plan.totalMinor};
    });
  });
}

export async function confirmBookingHold(payload:unknown,actor:Actor):Promise<Visit> {
  return translate(async()=>{
    const p=confirmationSchema.parse(payload);authorize(actor,["client"]);
    return transaction(async tx=>{
      await bookingLock(tx);const v=await readVisit(tx,p.holdId,true);
      check(v.hold_token_hash&&timingSafeEqual(Buffer.from(hash(p.holdToken),"hex"),Buffer.from(v.hold_token_hash,"hex"))&&v.hold_phone===p.phone,403,"Недействительное подтверждение записи");
      const user=await first<{client_id:string|null;phone_number:string;phone_number_verified:boolean}>('SELECT client_id,phone_number,phone_number_verified FROM auth."user" WHERE id=$1 FOR UPDATE',[actor.id],tx);
      check(user?.phone_number_verified&&user.phone_number===p.phone,403,"Подтвердите телефон одноразовым кодом");
      if(v.status==="confirmed"&&user.client_id===v.client_id) return clientVisit(await visitDto(tx,v));
      check(v.status==="hold"&&v.hold_expires_at&&v.hold_expires_at.getTime()>Date.now(),409,"Время удержания истекло. Выберите запись заново");
      validateFuture(iso(v.start_at));
      const profile=await getRecord<{name:string;phone:string}>("hold_profile","hold:"+v.id,tx);check(profile,409,"Данные записи утрачены");
      let clientId=user.client_id;
      if(!clientId) {
        clientId=randomUUID();
        await saveRecord("client",clientId,{name:profile.name,phone:p.phone,email:"",notes:"",marketingConsent:false,createdAt:iso(Date.now()),accountId:actor.id},tx);
        await tx.query('UPDATE auth."user" SET client_id=$2,name=$3 WHERE id=$1',[actor.id,clientId,profile.name]);
      } else { check(await getRecord("client",clientId,tx),409,"Профиль клиента не найден"); }
      // The account link, never a phone match, establishes ownership.
      const conflict=await first("SELECT 1 FROM appointments WHERE client_id=$1 AND id<>$2 AND status IN ('confirmed','arrived','in_progress','completed') AND closed_at IS NULL AND start_at<$4 AND end_at>$3",[clientId,v.id,v.start_at,v.end_at],tx);
      check(!conflict,409,"Это время уже занято другим визитом клиента");
      await insertAllocations(tx,v.id,[{resourceKey:"client:"+clientId,startAt:iso(v.start_at),endAt:iso(v.end_at)}]);
      await tx.query("UPDATE appointments SET client_id=$2,status='confirmed',version=version+1 WHERE id=$1",[v.id,clientId]);
      await tx.query("DELETE FROM records WHERE id=$1 AND kind='hold_profile'",["hold:"+v.id]);
      await audit(tx,actor,"booking.confirm",v.id,{clientId});
      await tx.query("INSERT INTO outbox(id,kind,payload) VALUES($1,'booking.confirmed',$2)",[randomUUID(),JSON.stringify({visitId:v.id,clientId,version:v.version+1})]);
      return clientVisit(await visitDto(tx,await readVisit(tx,v.id)));
    });
  });
}

async function addVisitService(actor:Actor,payload:unknown,commandId:string):Promise<Visit> {
  authorize(actor,["owner","admin"]);
  const p=z.object({id:z.string().uuid(),version:z.number().int().positive(),serviceId:z.string().min(1).max(100),staffId:z.string().min(1).max(100).optional(),startAt:start.optional(),reason:z.string().trim().min(3).max(1000)}).parse(payload);
  z.string().min(1).max(150).parse(commandId);
  return transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["command:"+commandId]);
    const existing=await first<{actor_id:string;action:string;result:Visit}>("SELECT actor_id,action,result FROM commands WHERE id=$1",[commandId],tx);
    if(existing) {check(existing.actor_id===actor.id&&existing.action==="visit.addService",409,"Ключ команды уже использован");return existing.result;}
    await bookingLock(tx);
    const v=await readVisit(tx,p.id,true);
    check(v.version===p.version,409,"Визит изменён. Обновите данные");
    check(!v.closed_at&&["confirmed","arrived","in_progress","completed"].includes(v.status),409,"Добавить услугу можно только в открытый визит");
    const activeItems=v.items.filter(i=>i.status!=="cancelled");
    check(activeItems.length<6,409,"В одном визите доступно до шести услуг");
    const allocationEnd=await first<{end_at:Date|null}>("SELECT max(end_at) end_at FROM allocations WHERE appointment_id=$1 AND active AND resource_key NOT LIKE 'client:%'",[v.id],tx);
    const earliest=Math.max(v.end_at.getTime(),allocationEnd?.end_at?.getTime()??0,...activeItems.flatMap(i=>(i.reservations??[]).map(r=>Date.parse(r.endAt))));
    const startAt=p.startAt??iso(Math.max(earliest,Math.ceil(Date.now()/60000)*60000));
    check(Date.parse(startAt)>=earliest&&Date.parse(startAt)>=Date.now()-60000,409,"Добавленная услуга должна начаться после текущих услуг и подготовки места");
    check(day(startAt)===day(v.start_at),409,"Дополнительная услуга должна пройти в день исходного визита");
    const busy=await busyAllocations(tx,v.id);
    const plan=await newPlan(tx,{serviceIds:[p.serviceId],mode:"sequential",staffId:p.staffId},startAt,busy);
    check(day(plan.endAt)===day(v.start_at),409,"Дополнительная услуга должна завершиться в день визита");
    if(v.client_id) check(!busy.some(a=>a.resourceKey==="client:"+v.client_id&&overlaps(v.start_at.getTime(),Date.parse(plan.endAt),Date.parse(a.startAt),Date.parse(a.endAt))),409,"Это время уже занято другим визитом клиента");
    const total=Number(v.total_minor)+plan.totalMinor;
    check(Number.isSafeInteger(total),400,"Сумма визита превышает допустимое значение");
    const items=[...v.items,...plan.items];
    if(await first("SELECT 1 FROM records WHERE kind='visit_material_fact' AND data->>'visitId'=$1",[v.id],tx))await saveRecord("material_review",`material-review:${v.id}`,{visitId:v.id,requiredVersion:v.version+1,reason:p.reason},tx);
    // Completed items keep their individual execution history when new work is appended.
    const status=v.status==="completed"?"arrived":v.status;
    await insertAllocations(tx,v.id,plan.allocations);
    await tx.query("DELETE FROM allocations WHERE appointment_id=$1 AND resource_key LIKE 'client:%'",[v.id]);
    if(v.client_id) await insertAllocations(tx,v.id,[{resourceKey:"client:"+v.client_id,startAt:iso(v.start_at),endAt:plan.endAt}]);
    await tx.query("UPDATE appointments SET items=$2,end_at=$3,total_minor=$4,status=$5,version=version+1 WHERE id=$1",[v.id,JSON.stringify(items),plan.endAt,total,status]);
    await audit(tx,actor,"visit.addService",v.id,{reason:p.reason,previousVersion:v.version,item:plan.items[0],previousTotalMinor:Number(v.total_minor),totalMinor:total});
    const result=await visitDto(tx,await readVisit(tx,v.id));
    await tx.query("INSERT INTO outbox(id,kind,payload) VALUES($1,'visit.addService',$2)",[randomUUID(),JSON.stringify({visitId:v.id,version:result.version})]);
    await tx.query("INSERT INTO commands(id,actor_id,action,result) VALUES($1,$2,'visit.addService',$3)",[commandId,actor.id,JSON.stringify(result)]);
    return result;
  });
}

export async function runBookingCommand(actor:Actor,action:"visit.move"|"visit.rework"|"visit.addService",payload:unknown,commandId:string):Promise<Visit> {
  const response = (visit: Visit) => actor.role === "client" ? clientVisit(visit) : visit;
  return translate(async()=>{
    if(action==="visit.addService") return addVisitService(actor,payload,commandId);
    z.enum(["visit.move","visit.rework"]).parse(action);
    z.string().min(1).max(150).parse(commandId);
    const p=z.object({id:z.string().uuid(),startAt:start,version:z.number().int().positive().optional(),reason:z.string().trim().min(3).max(1000).optional()}).parse(payload);
    authorize(actor,action==="visit.rework"?["owner","admin"]:["owner","admin","client"]);
    return transaction(async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["command:"+commandId]);
      const existing=await first<{actor_id:string;action:string;result:Visit}>("SELECT actor_id,action,result FROM commands WHERE id=$1",[commandId],tx);
      if(existing) {check(existing.actor_id===actor.id&&existing.action===action,409,"Ключ команды уже использован");return response(existing.result);}
      validateFuture(p.startAt);await bookingLock(tx);const v=await readVisit(tx,p.id,true);
      check(p.version===undefined||p.version===v.version,409,"Визит изменён. Обновите данные");
      if(action==="visit.move") {check(p.version!==undefined,400,"Укажите версию визита");canMove(actor,v);}
      else {check(v.closed_at&&v.status==="completed",409,"Переделка доступна после закрытия исходного визита");check(p.reason,400,"Укажите причину переделки");check(!await first("SELECT 1 FROM appointments WHERE parent_id=$1 AND status NOT IN ('cancelled','no_show')",[v.id],tx),409,"Переделка уже создана");}
      const plan=await shiftedPlan(tx,v,p.startAt,await busyAllocations(tx,action==="visit.move"?v.id:undefined));
      let id=v.id;
      if(action==="visit.move") {
        await tx.query("DELETE FROM allocations WHERE appointment_id=$1",[id]);
        await tx.query("UPDATE appointments SET start_at=$2,end_at=$3,items=$4,version=version+1 WHERE id=$1",[id,plan.startAt,plan.endAt,JSON.stringify(plan.items)]);
      } else {
        id=randomUUID();const items=plan.items.filter(i=>i.status!=="cancelled").map(i=>({...i,id:randomUUID(),priceMinor:0,status:"planned"}));
        await tx.query("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor,parent_id,note) VALUES($1,$2,$3,'confirmed',$4,$5,$6,0,$7,$8)",[id,"SI-"+id.slice(0,8).toUpperCase(),v.client_id,plan.startAt,plan.endAt,JSON.stringify(items),v.id,p.reason]);
      }
      await insertAllocations(tx,id,plan.allocations);
      await audit(tx,actor,action,id,{parentId:action==="visit.rework"?v.id:undefined,previousStartAt:iso(v.start_at),startAt:plan.startAt,reason:p.reason});
      const result=await visitDto(tx,await readVisit(tx,id));
      await tx.query("INSERT INTO outbox(id,kind,payload) VALUES($1,$2,$3)",[randomUUID(),action,JSON.stringify({visitId:id,version:result.version})]);
      await tx.query("INSERT INTO commands(id,actor_id,action,result) VALUES($1,$2,$3,$4)",[commandId,actor.id,action,JSON.stringify(result)]);
      return response(result);
    });
  });
}

