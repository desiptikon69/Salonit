import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import type { Actor, Certificate, Client, Material, Purchase, Resource, Role, Staff, Usage, VisitItem } from "@/lib/contracts";
import { allocateMinor, certificateRelease, commissionMinor, payrollTotal, roundedRatio } from "@/domain/money";
import { first, rows, transaction, type SqlClient } from "./db";
import { audit, getRecord, listRecords, saveRecord } from "./records";
import { authorize } from "./permissions";
import { AppError, requireCondition as check } from "./errors";
import { id, money, resourceProcess, schemas, text, usage, visitId } from "./operations/schemas";
import { clientProfile } from "./queries";
import { resolvePayrollRule, savePayrollRule } from "./payroll-rules";
import { resourceReady } from "@/domain/scheduling";

interface Appointment { id:string;client_id:string;status:string;items:VisitItem[];materials:Usage[];total_minor:string;paid_minor:string;version:number;closed_at:Date|null;start_at:Date; }
interface Fact { id:string;visitId:string;staffId:string;materials:Usage[]; }
interface Entitlement extends Certificate { serviceIds?:string[]; }
const managers:Role[]=["owner","admin"];
const financial:Role[]=["owner","accountant"];
const instrument = (type:unknown) => type==="tools-hands"||type==="tools-feet";
async function processingEvent(actor:Actor,resource:Resource,event:string,status:string,client:SqlClient,visitId?:string) {
  const now=Date.now(),validityHours=resource.processingValidityHours??24;
  // 24 hours is a configurable demo salon setting, not a sanitary recommendation.
  const validUntil=event==="control_pass"?new Date(now+validityHours*3600000).toISOString():undefined;
  const entry={resourceId:resource.id,event,from:resource.status,to:status,actorId:actor.id,actorName:actor.name,date:new Date(now).toISOString(),...(validUntil?{validUntil,validityHours}:{}),...(visitId?{visitId}:{})};
  const next={...resource,status,ready:status==="ready",readyUntil:validUntil,lastProcessing:entry};
  await saveRecord("resource",resource.id,next,client);
  await saveRecord("resource_cycle",randomUUID(),entry,client);
  return next;
}
async function processInstrument(actor:Actor,payload:unknown,client:SqlClient) {
  authorize(actor,["owner","admin","stock"]);
  const p=resourceProcess.parse(payload);
  const resource=await getRecord<Resource>("resource",p.id,client,true);check(resource,404,"Ресурс не найден");
  check(instrument(resource.type),400,"Цикл обработки доступен только для инструментов маникюра и педикюра");
  check(!await first("SELECT 1 FROM appointments v JOIN allocations a ON a.appointment_id=v.id WHERE a.active AND a.resource_key=$1 AND v.status='in_progress' AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.items) i WHERE i->>'status'='in_progress' AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(i->'reservations','[]'::jsonb)) r WHERE r->>'resourceKey'=$1))",["resource:"+p.id],client),409,"Инструмент используется в незавершённой услуге");
  const next:Record<string,{from:string[];to:string}>={used:{from:["ready"],to:"dirty"},start:{from:["dirty","processing","ready"],to:"cleaning"},cleaned:{from:["cleaning"],to:"sterilizing"},sterilized:{from:["sterilizing"],to:"control"},control_pass:{from:["control"],to:"ready"},control_fail:{from:["control"],to:"dirty"}};
  const transition=next[p.event];check(transition.from.includes(resource.status),409,"Сначала завершите предыдущий этап обработки инструмента");
  return processingEvent(actor,resource,p.event,transition.to,client);
}
async function usedInstruments(actor:Actor,before:VisitItem[],after:VisitItem[],visitId:string,client:SqlClient) {
  const newlyCompleted=after.filter(i=>i.status==="completed"&&before.find(old=>old.id===i.id)?.status!=="completed");
  const keys=[...new Set(newlyCompleted.flatMap(i=>i.reservations??[]).map(r=>r.resourceKey).filter(k=>k.startsWith("resource:")))].sort();
  for(const key of keys) {
    if(after.some(i=>i.status!=="completed"&&i.status!=="cancelled"&&i.reservations?.some(r=>r.resourceKey===key)))continue;
    const resource=await getRecord<Resource>("resource",key.slice(9),client,true);
    if(resource&&instrument(resource.type))await processingEvent(actor,resource,"used","dirty",client,visitId);
  }
}
function mergeUsage(usages:Usage[]):Usage[] {
  const map=new Map<string,number>();
  for(const u of usages) {const value=(map.get(u.materialId)??0)+u.quantityMilli; check(Number.isSafeInteger(value),400,"Расход слишком велик");map.set(u.materialId,value);}
  return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([materialId,quantityMilli])=>({materialId,quantityMilli}));
}
async function lockedVisit(client:SqlClient,visit:string,version?:number) {
  const v=await first<Appointment>("SELECT * FROM appointments WHERE id=$1 FOR UPDATE",[visit],client);
  check(v,404,"Визит не найден"); if(version!==undefined)check(v.version===version,409,"Визит изменён, обновите данные"); return v;
}
async function stock(client:SqlClient,materialId:string,quantity:number,receive:boolean,cost?:number) {
  const m=await getRecord<Material>("material",materialId,client,true);check(m,404,"Материал не найден");
  const balance=m.stockMilli+(receive?quantity:-quantity);check(Number.isSafeInteger(balance)&&balance>=0,409,`Недостаточно материала: ${m.name}`);
  const next={...m,stockMilli:balance,...(cost!==undefined?{costMinor:cost}:{})};await saveRecord("material",m.id,next,client);return m;
}
async function facts(client:SqlClient,v:Appointment) {
  const all=await rows<{id:string;data:Fact}>("SELECT id,data FROM records WHERE kind='visit_material_fact' AND data->>'visitId'=$1 ORDER BY id",[v.id],client);
  const map=new Map(all.map(r=>[r.data.staffId,r.data.materials]));
  if(map.has("*"))return mergeUsage(map.get("*")!);
  v={...v,items:v.items.filter(i=>i.status!=="cancelled")};
  const staffIds=[...new Set(v.items.map(i=>i.staffId))];
  return mergeUsage(staffIds.flatMap(staffId=>map.get(staffId)??v.items.filter(i=>i.staffId===staffId).flatMap(i=>i.norms)));
}
async function materialCostShares(client:SqlClient,v:Appointment,materialId:string,cost:number) {
  const stored=await rows<{data:Fact}>("SELECT data FROM records WHERE kind='visit_material_fact' AND data->>'visitId'=$1",[v.id],client);
  const staffIds=[...new Set(v.items.map(i=>i.staffId))];
  const normWeights=v.items.map(i=>i.norms.filter(u=>u.materialId===materialId).reduce((s,u)=>s+u.quantityMilli,0));
  const fallback=(weights:number[],items:VisitItem[])=>weights.some(Boolean)?weights:items.some(i=>i.priceMinor)?items.map(i=>i.priceMinor):items.map(()=>1);
  if(stored.some(f=>f.data.staffId==="*"))return allocateMinor(cost,fallback(normWeights,v.items));
  const staffWeights=staffIds.map(staffId=>{
    const fact=stored.find(f=>f.data.staffId===staffId);
    return fact?fact.data.materials.filter(u=>u.materialId===materialId).reduce((s,u)=>s+u.quantityMilli,0):v.items.reduce((s,i,index)=>s+(i.staffId===staffId?normWeights[index]:0),0);
  });
  const staffCosts=allocateMinor(cost,staffWeights);const result=v.items.map(()=>0);
  staffIds.forEach((staffId,staffIndex)=>{
    const indices=v.items.flatMap((i,index)=>i.staffId===staffId?[index]:[]);
    const shares=allocateMinor(staffCosts[staffIndex],fallback(indices.map(i=>normWeights[i]),indices.map(i=>v.items[i])));
    indices.forEach((i,j)=>result[i]=shares[j]);
  });return result;
}
async function closeVisit(actor:Actor,payload:unknown,client:SqlClient) {
  authorize(actor,managers);
  const p=visitId.extend({version:z.number().int().positive(),payments:z.array(z.object({method:z.enum(["cash","card","sbp","certificate"]),amountMinor:money.refine(n=>n>0),certificateCode:text.optional()})).max(100),materials:z.array(usage).max(100).optional(),discountMinor:money.default(0)}).parse(payload);
  const v=await lockedVisit(client,p.id,p.version);v.items=v.items.filter(i=>i.status!=="cancelled");check(!v.closed_at,409,"Визит уже закрыт");check(v.status==="completed"&&v.items.every(i=>i.status==="completed"),409,"Сначала завершите все услуги");
  check(!await getRecord("material_review",`material-review:${v.id}`,client),409,"После добавления услуги проверьте и сохраните фактический расход в разделе «Материалы»");
  check(v.items.length>0,409,"В визите нет услуг");
  const payrollMonths=[...new Set(v.items.map(item=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit"}).format(new Date(item.completedAt??item.endAt))))].sort();
  for(const payrollMonth of payrollMonths) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`payroll:${payrollMonth}`]);
    check(!await first("SELECT 1 FROM payouts WHERE month=$1 UNION ALL SELECT 1 FROM records WHERE kind='payroll' AND data->>'month'=$1 AND data->>'status'='paid'",[payrollMonth],client),409,"Период уже выплачен. Закрытие требует отдельной корректировки");
  }
  const subtotal=v.items.reduce((s,i)=>s+i.priceMinor,0);check(p.discountMinor<=subtotal,400,"Скидка превышает стоимость");const total=subtotal-p.discountMinor;
  const paid=p.payments.reduce((s,i)=>s+i.amountMinor,Number(v.paid_minor));check(Number.isSafeInteger(paid)&&paid<=total,400,"Оплата превышает сумму визита");
  if(p.materials!==undefined)await saveRecord("visit_material_fact",`fact:${v.id}:all`,{visitId:v.id,staffId:"*",materials:mergeUsage(p.materials)},client);
  const materials=await facts(client,v);let materialCost=0;const costs=v.items.map(()=>0);
  for(const u of materials) {
    const m=await stock(client,u.materialId,u.quantityMilli,false);const cost=roundedRatio(m.costMinor,u.quantityMilli,1000);materialCost+=cost;
    const shares=await materialCostShares(client,v,u.materialId,cost);shares.forEach((amount,index)=>costs[index]+=amount);
    await client.query("INSERT INTO consumptions(id,visit_id,material_id,quantity_milli,cost_minor) VALUES($1,$2,$3,$4,$5)",[randomUUID(),v.id,m.id,u.quantityMilli,cost]);
  }
  const discounts=allocateMinor(p.discountMinor,v.items.map(i=>i.priceMinor));const redeemedItems=new Set<string>();
  for(const payment of [...p.payments].sort((a,b)=>(a.certificateCode??"").localeCompare(b.certificateCode??""))) {
    let amount=payment.amountMinor;let certificateId:string|null=null;
    if(payment.method==="certificate") {
      check(payment.certificateCode,400,"Введите код сертификата");
      const raw=await first<{id:string;data:Entitlement}>("SELECT id,data FROM records WHERE kind='certificate' AND data->>'code'=$1 FOR UPDATE",[payment.certificateCode],client);
      check(raw,404,"Сертификат не найден");const c=raw.data;check(c.status==="active"&&(!c.clientId||c.clientId===v.client_id),409,"Сертификат недоступен для клиента");
      let unitsRemaining=c.unitsRemaining;let balanceMinor=c.balanceMinor;
      if(c.kind==="package") {
        check(c.serviceIds?.length,409,"В абонементе не заданы услуги");
        const covered=v.items.flatMap((item,index)=>c.serviceIds!.includes(item.serviceId)&&!redeemedItems.has(item.id)?[{item,index}]:[]);
        check(covered.length>0&&covered.reduce((s,{item,index})=>s+item.priceMinor-discounts[index],0)===payment.amountMinor,400,"Абонемент оплачивает только выбранные в нём услуги целиком");
        check((unitsRemaining??0)>=covered.length,409,"В абонементе недостаточно посещений");
        amount=certificateRelease(unitsRemaining!,c.liabilityMinor,covered.length);
        balanceMinor-=certificateRelease(unitsRemaining!,c.balanceMinor,covered.length);
        unitsRemaining=unitsRemaining!-covered.length;covered.forEach(({item})=>redeemedItems.add(item.id));
      } else {
        check(c.balanceMinor>=amount,409,"Недостаточно средств сертификата");
        amount=certificateRelease(c.balanceMinor,c.liabilityMinor,payment.amountMinor);balanceMinor-=payment.amountMinor;
      }
      certificateId=raw.id;
      await saveRecord("certificate",raw.id,{...c,balanceMinor,liabilityMinor:c.liabilityMinor-amount,...(unitsRemaining!==undefined?{unitsRemaining}:{}),status:balanceMinor&&(c.kind!=="package"||unitsRemaining)?"active":"redeemed"},client);
    }
    await client.query("INSERT INTO payments(id,visit_id,method,amount_minor,kind,certificate_id) VALUES($1,$2,$3,$4,'payment',$5)",[randomUUID(),v.id,payment.method,amount,certificateId]);
  }
  for(const [index,item] of v.items.entries()) {
    check(!item.completedAt||item.rewardRuleSnapshot&&item.rewardRuleId===item.rewardRuleSnapshot.id,409,"У завершённой услуги отсутствует зафиксированное правило начисления");
    const rate=item.completedAt?item.rewardRuleSnapshot!.commissionBps:item.commissionBps;
    const base=Math.max(0,item.priceMinor-discounts[index]-costs[index]);const amount=commissionMinor(item.priceMinor,discounts[index],costs[index],rate);
    const eventAt=item.completedAt??item.endAt;
    const snapshot={itemId:item.id,completedAt:item.completedAt??null,eventAt,legacy:!item.completedAt,ruleId:item.rewardRuleId??null,ruleSnapshot:item.rewardRuleSnapshot??null,priceMinor:item.priceMinor,discountMinor:discounts[index],materialCostMinor:costs[index],commissionBps:rate,bookingCommissionBps:item.commissionBps,formula:"max(0, price - discount - actualMaterials) * commissionBps / 10000"};
    await client.query("INSERT INTO accruals(id,visit_id,item_id,staff_id,service_name,base_minor,amount_minor,rate_bps,status,date,rule_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft',($9::timestamptz AT TIME ZONE 'Europe/Moscow')::date,$10)",[randomUUID(),v.id,item.id,item.staffId,item.serviceName,base,amount,rate,eventAt,JSON.stringify(snapshot)]);
  }
  await client.query("UPDATE appointments SET total_minor=$2,paid_minor=$3,materials=$4,closed_at=now(),version=version+1,receipt_status='unconfirmed' WHERE id=$1",[v.id,total,paid,JSON.stringify(materials)]);
  return {id:v.id,totalMinor:total,paidMinor:paid,debtMinor:total-paid,materialCostMinor:materialCost};
}
async function visitOperation(actor:Actor,action:string,payload:unknown,client:SqlClient) {
  if(action==="visit.close")return closeVisit(actor,payload,client);
  if(action==="visit.item.cancel") {
    authorize(actor,managers);
    const p=visitId.extend({version:z.number().int().positive(),itemId:id,reason:text}).parse(payload);
    const v=await lockedVisit(client,p.id,p.version);
    check(!v.closed_at&&["confirmed","arrived","in_progress"].includes(v.status),409,"Визит уже завершён или отменён");
    const item=v.items.find(i=>i.id===p.itemId);check(item,404,"Услуга не найдена");
    check([undefined,"planned","confirmed","arrived"].includes(item.status),409,"Начатую или завершённую услугу отменить нельзя");
    const remaining=v.items.filter(i=>i.id!==item.id&&i.status!=="cancelled");
    check(remaining.length>0,409,"Последнюю услугу отменяйте через отмену всего визита");
    check(remaining.every(i=>i.reservations?.length),409,"У этой записи нет сохранённой схемы ресурсов для частичной отмены");
    check(!await first("SELECT 1 FROM records WHERE kind='visit_material_fact' AND data->>'visitId'=$1 AND (data->>'staffId'='*' OR data->>'staffId'=$2)",[v.id,item.staffId],client),409,"Фактический расход уже сохранён; частичная отмена требует уточнения расхода");
    const total=remaining.reduce((sum,i)=>sum+i.priceMinor,0);check(Number(v.paid_minor)<=total,409,"Внесённая оплата превышает остаток визита");
    const reservations=remaining.flatMap(i=>i.reservations!);
    const startAt=new Date(Math.min(...remaining.map(i=>Date.parse(i.startAt))));
    const endAt=new Date(Math.max(...remaining.map(i=>Date.parse(i.endAt))));
    if(v.client_id)reservations.push({resourceKey:"client:"+v.client_id,startAt:startAt.toISOString(),endAt:endAt.toISOString()});
    const merged:typeof reservations=[];
    for(const r of [...reservations].sort((a,b)=>a.resourceKey.localeCompare(b.resourceKey)||Date.parse(a.startAt)-Date.parse(b.startAt))) {
      const last=merged.at(-1);
      if(last&&last.resourceKey===r.resourceKey&&Date.parse(r.startAt)<=Date.parse(last.endAt))last.endAt=new Date(Math.max(Date.parse(last.endAt),Date.parse(r.endAt))).toISOString();
      else merged.push({...r});
    }
    await client.query("DELETE FROM allocations WHERE appointment_id=$1",[v.id]);
    for(const r of merged)await client.query("INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at) VALUES($1,$2,$3,$4,$5)",[randomUUID(),v.id,r.resourceKey,r.startAt,r.endAt]);
    const items=v.items.map(i=>i.id===item.id?{...i,status:"cancelled",cancellationReason:p.reason}:i);
    const status=remaining.every(i=>i.status==="completed")?"completed":v.status;
    const materials=await facts(client,{...v,items});
    await client.query("UPDATE appointments SET items=$2,total_minor=$3,start_at=$4,end_at=$5,status=$6,materials=$7,version=version+1 WHERE id=$1",[v.id,JSON.stringify(items),total,startAt,endAt,status,JSON.stringify(materials)]);
    return {id:v.id,itemId:item.id,reason:p.reason,totalMinor:total,version:v.version+1};
  }
  if(action==="visit.payment") {
    authorize(actor,managers);const p=visitId.extend({amountMinor:money.refine(n=>n>0),method:z.enum(["cash","card","sbp"])}).parse(payload);
    const v=await lockedVisit(client,p.id,p.version);check(v.closed_at,409,"Сначала закройте визит");
    const paid=Number(v.paid_minor)+p.amountMinor;check(Number.isSafeInteger(paid)&&paid<=Number(v.total_minor),409,"Оплата превышает остаток долга");
    await client.query("INSERT INTO payments(id,visit_id,method,amount_minor,kind) VALUES($1,$2,$3,$4,'payment')",[randomUUID(),v.id,p.method,p.amountMinor]);
    await client.query("UPDATE appointments SET paid_minor=$2,version=version+1 WHERE id=$1",[v.id,paid]);
    return {id:v.id,paidMinor:paid,debtMinor:Number(v.total_minor)-paid,version:v.version+1};
  }
  if(action==="visit.refund") {
    authorize(actor,managers);const p=visitId.extend({amountMinor:money.refine(n=>n>0),reason:text}).parse(payload);const v=await lockedVisit(client,p.id);check(v.closed_at,409,"Визит ещё не закрыт");
    const balance=await first<{remaining:string}>("SELECT COALESCE(sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END),0) remaining FROM payments WHERE visit_id=$1",[v.id],client);
    check(p.amountMinor<=Number(balance?.remaining??0),409,"Возврат превышает фактически полученную сумму");
    await client.query("INSERT INTO payments(id,visit_id,method,amount_minor,kind) VALUES($1,$2,'refund',$3,'refund')",[randomUUID(),v.id,p.amountMinor]);return {id:v.id,refundedMinor:p.amountMinor,reason:p.reason};
  }
  if(action==="visit.status"&&actor.role==="client") {
    const p=visitId.extend({status:z.literal("cancelled")}).parse(payload);const v=await lockedVisit(client,p.id,p.version);
    check(v.client_id===actor.clientId,403,"Это запись другого клиента");check(v.status==="confirmed"&&!v.closed_at,409,"Отменить можно только подтверждённую запись");
    await client.query("UPDATE appointments SET status='cancelled',items=$2,version=version+1 WHERE id=$1",[v.id,JSON.stringify(v.items.map(i=>({...i,status:"cancelled"})))]);
    await client.query("UPDATE allocations SET active=false WHERE appointment_id=$1",[v.id]);return {id:v.id,status:"cancelled",version:v.version+1};
  }
  authorize(actor,[...managers,"master"]);
  if(action==="visit.materials") {
    const p=visitId.extend({version:z.number().int().positive(),materials:z.array(usage).max(100)}).parse(payload);const v=await lockedVisit(client,p.id,p.version);check(!v.closed_at&&!['cancelled','no_show','hold'].includes(v.status),409,"Расход нельзя изменить");
    check(actor.role!=="master"||v.items.some(i=>i.staffId===actor.staffId&&i.status!=="cancelled"),403,"Это назначение другого мастера");
    for(const u of p.materials)check(await getRecord("material",u.materialId,client),404,"Материал не найден");
    const staffId=actor.role==="master"?actor.staffId!:"*";
    if(staffId!=="*")check(!await first("SELECT 1 FROM records WHERE kind='visit_material_fact' AND data->>'visitId'=$1 AND data->>'staffId'='*'",[v.id],client),409,"Общий расход уже скорректирован администратором");
    await saveRecord("visit_material_fact",`fact:${v.id}:${staffId}`,{visitId:v.id,staffId,materials:mergeUsage(p.materials)},client);
    if(actor.role!=="master")await client.query("DELETE FROM records WHERE kind='material_review' AND id=$1",[`material-review:${v.id}`]);
    const all=await facts(client,v);await client.query("UPDATE appointments SET materials=$2,version=version+1 WHERE id=$1",[v.id,JSON.stringify(all)]);return {id:v.id,materials:all,version:v.version+1};
  }
  check(action==="visit.status",400,"Неизвестная команда визита");
  const p=visitId.extend({status:z.enum(["arrived","in_progress","completed","cancelled","no_show"])}).parse(payload);const v=await lockedVisit(client,p.id,p.version);check(!v.closed_at,409,"Визит уже закрыт");
  const beforeItems=v.items.map(item=>({...item}));
  if(p.status==="in_progress") {
    const starting=v.items.filter(i=>i.status!=="in_progress"&&i.status!=="completed"&&i.status!=="cancelled"&&(actor.role!=="master"||i.staffId===actor.staffId));
    const keys=[...new Set(starting.flatMap(i=>i.reservations??[]).map(r=>r.resourceKey).filter(k=>k.startsWith("resource:")))].sort();
    for(const key of keys) {
      const resource=await getRecord<Resource>("resource",key.slice(9),client,true);
      if(resource&&instrument(resource.type)) {
        check(resourceReady(resource),409,`Инструмент «${resource.name}» ещё не прошёл обработку и контроль либо срок готовности истёк`);
        check(!await first("SELECT 1 FROM appointments a CROSS JOIN LATERAL jsonb_array_elements(a.items) i WHERE a.closed_at IS NULL AND i->>'status'='in_progress' AND NOT (a.id=$2 AND i->>'id'=ANY($3::text[])) AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(i->'reservations','[]'::jsonb)) r WHERE r->>'resourceKey'=$1) LIMIT 1",[key,v.id,starting.map(i=>i.id)],client),409,"Инструмент ещё используется в другой незавершённой услуге");
      }
    }
  }
  const allowed:Record<string,string[]>={confirmed:["arrived","cancelled","no_show"],arrived:["in_progress","cancelled"],in_progress:["in_progress","completed"],completed:[],cancelled:[],no_show:[]};
  if(actor.role==="master") {
    check(v.items.some(i=>i.staffId===actor.staffId&&i.status!=="cancelled"),403,"Это назначение другого мастера");check(["in_progress","completed"].includes(p.status),403,"Мастер меняет только выполнение услуг");
    check(["arrived","in_progress"].includes(v.status),409,"Клиент ещё не пришёл или визит завершён");
    const pending=v.items.filter(i=>i.staffId===actor.staffId&&i.status!=="cancelled"&&i.status!=="completed");check(pending.length>0,409,"У мастера нет незавершённых услуг");
    for(const item of pending)check((p.status==="in_progress"&&[undefined,"planned","confirmed","arrived"].includes(item.status))||(p.status==="completed"&&item.status==="in_progress"),409,"Недопустимый переход услуги");
    v.items=v.items.map(i=>pending.some(item=>item.id===i.id)?{...i,status:p.status}:i);
    v.status=v.items.every(i=>i.status==="completed"||i.status==="cancelled")?"completed":"in_progress";
  } else {
    check(allowed[v.status]?.includes(p.status),409,"Недопустимый переход статуса");
    const pending=v.items.filter(i=>i.status!=="cancelled"&&i.status!=="completed");
    if(p.status==="completed")check(pending.length>0&&pending.every(i=>i.status==="in_progress"),409,"Сначала начните все добавленные услуги");
    if(p.status==="in_progress"&&v.status==="in_progress")check(pending.some(i=>i.status!=="in_progress"),409,"Все услуги уже начаты");
    v.status=p.status;v.items=v.items.map(i=>i.status==="cancelled"||i.status==="completed"?i:({...i,status:p.status}));
  }
  if(p.status==="completed") {
    const completedAt=new Date().toISOString();
    const newlyCompleted=v.items.filter(item=>item.status==="completed"&&beforeItems.find(old=>old.id===item.id)?.status!=="completed");
    for(const staffId of [...new Set(newlyCompleted.map(item=>item.staffId))].sort())await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`payroll-rule:${staffId}`]);
    for(const item of newlyCompleted) {
      const rule=await resolvePayrollRule(client,item.staffId,completedAt);
      item.completedAt=completedAt;item.rewardRuleId=rule.id;item.rewardRuleSnapshot=rule;
    }
    await usedInstruments(actor,beforeItems,v.items,v.id,client);
  }
  await client.query("UPDATE appointments SET status=$2,items=$3,version=version+1 WHERE id=$1",[v.id,v.status,JSON.stringify(v.items)]);
  if(["cancelled","no_show"].includes(v.status))await client.query("UPDATE allocations SET active=false WHERE appointment_id=$1",[v.id]);return {id:v.id,status:v.status,version:v.version+1};
}

const saveRoles:Record<keyof typeof schemas,Role[]>={service:["owner"],staff:["owner"],resource:["owner","admin","stock"],client:["owner","admin","client"],material:["owner","stock"],expense:financial,task:managers,complaint:[...managers,"client"],purchase:["owner","stock"],shift:managers,installation:["owner","operator"],settings:["owner"]};
async function saveOperation(actor:Actor,action:string,payload:unknown,client:SqlClient) {
  const kind=action.slice(0,-5) as keyof typeof schemas;check(Object.hasOwn(schemas,kind),400,"Неизвестная команда");const schema=schemas[kind];authorize(actor,saveRoles[kind]);
  const input=kind==="complaint"&&actor.role==="client"&&payload&&typeof payload==="object"?{...payload,assignee:"Администратор",status:"open",resolution:"",dueDate:new Date(Date.now()+3*86400000).toISOString().slice(0,10)}:payload;
  const data=schema.parse(input) as Record<string,unknown>;const recordId=typeof data.id==="string"?data.id:kind==="settings"?"salon-settings":randomUUID();
  const old=await getRecord<Record<string,unknown>>(kind,recordId,client,true);
  if(data.id)check(old,404,"Запись не найдена");
  if(kind==="resource"&&(instrument(data.type)||instrument(old?.type))) {
    check(!old||old.type===data.type,400,"Тип набора инструментов нельзя изменить");
    check(old?data.ready===old.ready&&data.status===old.status:data.ready===false&&data.status==="dirty",409,"Готовность инструмента изменяется только через полный цикл обработки и контроль");
  }
  if(kind==="client") {
    if(actor.role==="client") {check(recordId===actor.clientId,403,"Можно изменять только свой профиль");check(data.phone===old?.phone,403,"Изменение телефона требует подтверждения");data.notes=old?.notes??"";}
    data.createdAt=old?.createdAt??new Date().toISOString();data.accountId=old?.accountId??null;
  }
  if(kind==="material"&&old) {check(data.stockMilli===old.stockMilli,400,"Изменяйте остаток через складские операции");}
  if(kind==="purchase") {check(old?.status!=="received",409,"Поставка уже получена");check(await getRecord("material",String(data.materialId),client),404,"Материал не найден");}
  if(kind==="shift") {check(String(data.end)>String(data.start),400,"Конец смены должен быть после начала");check(await getRecord("staff",String(data.staffId),client),404,"Сотрудник не найден");}
  if(kind==="staff") {
    check(String(data.workEnd)>String(data.workStart),400,"Конец рабочего дня должен быть после начала");
    if(old)check(["commissionBps","fixedMinor","guaranteeMinor","guaranteeScope"].every(key=>data[key]===old[key]),409,"Условия оплаты меняются через новую версию правил начисления");
  }
  if(kind==="complaint") {
    const v=await lockedVisit(client,String(data.visitId));check(v.client_id===data.clientId,400,"Клиент не соответствует визиту");
    if(actor.role==="client") {
      check(!old,403,"Обращение уже передано администратору");check(v.client_id===actor.clientId&&v.status==="completed",403,"Обратная связь доступна только по собственному завершённому визиту");
      data.status="open";data.assignee="Администратор";data.resolution="";data.dueDate=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    }
  }
  if(kind==="service") {
    const norms=data.norms as Usage[];
    for(const norm of norms)check(await getRecord("material",norm.materialId,client),404,"Материал нормы не найден");
    const stages=data.stages as {durationMinutes:number}[]|undefined;
    if(stages?.length)check(stages.reduce((sum,stage)=>sum+stage.durationMinutes,0)===data.durationMinutes,400,"Длительность этапов должна совпадать с услугой");
  }
  return saveRecord(kind,recordId,{...old,...data},client);
}

async function payroll(actor:Actor,action:string,payload:unknown,client:SqlClient) {
  authorize(actor,financial);const {month}=z.object({month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)}).parse(payload);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`payroll:${month}`]);
  const payrollId=`payroll:${month}`;
  if(action==="payroll.approve") {
    check(!(await first("SELECT 1 FROM payouts WHERE month=$1 UNION ALL SELECT 1 FROM records WHERE kind='payroll' AND data->>'month'=$1 AND data->>'status'='paid'",[month],client)),409,"Ведомость уже выплачена");
    const staff=await listRecords<Staff>("staff",client);const sums=await rows<{staff_id:string;amount:string}>("SELECT staff_id,sum(amount_minor) amount FROM accruals WHERE date >= ($1||'-01')::date AND date < ($1||'-01')::date+interval '1 month' GROUP BY staff_id",[month],client);
    const snapshot=[];
    for(const s of staff.filter(s=>s.active||sums.some(a=>a.staff_id===s.id)).sort((a,b)=>a.id.localeCompare(b.id))) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`payroll-rule:${s.id}`]);
      const rule=await resolvePayrollRule(client,s.id,`${month}-01T00:00:00+03:00`);
      const variableMinor=Number(sums.find(a=>a.staff_id===s.id)?.amount??0);
      snapshot.push({staffId:s.id,fixedMinor:rule.fixedMinor,guaranteeMinor:rule.guaranteeMinor,guaranteeScope:rule.guaranteeScope,variableMinor,amountMinor:payrollTotal(rule.fixedMinor,variableMinor,rule.guaranteeMinor,rule.guaranteeScope),ruleId:rule.id,ruleSnapshot:rule});
    }
    await client.query("UPDATE accruals SET status='approved' WHERE date >= ($1||'-01')::date AND date < ($1||'-01')::date+interval '1 month'",[month]);
    return saveRecord("payroll",payrollId,{month,status:"approved",snapshot},client);
  }
  const approved=await getRecord<{status:string;snapshot:{staffId:string;amountMinor:number}[]}>("payroll",payrollId,client,true);check(approved&&["approved","paid"].includes(approved.status),409,"Сначала утвердите ведомость");
  check(!await first("SELECT 1 FROM appointments a CROSS JOIN LATERAL jsonb_array_elements(a.items) i WHERE a.closed_at IS NULL AND a.status NOT IN ('cancelled','no_show','hold') AND i->>'status'='completed' AND (COALESCE(NULLIF(i->>'completedAt','')::timestamptz,NULLIF(i->>'endAt','')::timestamptz) AT TIME ZONE 'Europe/Moscow')::date >= ($1||'-01')::date AND (COALESCE(NULLIF(i->>'completedAt','')::timestamptz,NULLIF(i->>'endAt','')::timestamptz) AT TIME ZONE 'Europe/Moscow')::date < ($1||'-01')::date+interval '1 month' LIMIT 1",[month],client),409,"Сначала закройте визиты с выполненными услугами за месяц ведомости");
  check(!await first("SELECT 1 FROM accruals WHERE date >= ($1||'-01')::date AND date < ($1||'-01')::date+interval '1 month' AND status='draft'",[month],client),409,"Появились новые начисления — утвердите ведомость заново");
  for(const s of approved.snapshot)await client.query("INSERT INTO payouts(id,month,staff_id,amount_minor) VALUES($1,$2,$3,$4) ON CONFLICT(month,staff_id) DO NOTHING",[randomUUID(),month,s.staffId,s.amountMinor]);
  await client.query("UPDATE accruals SET status='paid' WHERE date >= ($1||'-01')::date AND date < ($1||'-01')::date+interval '1 month'",[month]);return saveRecord("payroll",payrollId,{...approved,status:"paid"},client);
}

function importCsv(csv:string) {
  const fingerprint=createHash("sha256").update(csv.replace(/^\uFEFF/,"").replace(/\r\n/g,"\n").trim()).digest("hex");
  let values:Record<string,string>[];
  try {values=parse(csv,{columns:true,bom:true,skip_empty_lines:true,trim:true,max_record_size:20000}) as Record<string,string>[];}catch{throw new AppError(400,"Некорректный CSV");}
  check(values.length>0&&values.length<=10000,400,"CSV должен содержать от 1 до 10000 строк");
  const errors:{row:number;message:string}[]=[];const records:Record<string,unknown>[]=[];
  values.forEach((v,index)=>{const parsed=schemas.client.safeParse({name:v.name??v["Имя"],phone:v.phone??v["Телефон"],email:v.email??v["Email"]??"",notes:v.notes??"",marketingConsent:false});if(parsed.success)records.push(parsed.data);else errors.push({row:index+2,message:parsed.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; ")});});return {fingerprint,rows:records,errors};
}
async function execute(actor:Actor,action:string,payload:unknown,client:SqlClient):Promise<unknown> {
  if(action==="payroll.rule.create"||action==="payroll.rule.save")return savePayrollRule(actor,payload,client);
  if(action==="resource.process"||action==="resource.save"||(action==="visit.status"&&payload&&typeof payload==="object"&&"status" in payload&&["in_progress","completed"].includes(String(payload.status))))await client.query("SELECT pg_advisory_xact_lock(hashtextextended('booking',0))");
  if(action==="resource.process")return processInstrument(actor,payload,client);
  if(action.startsWith("visit."))return visitOperation(actor,action,payload,client);
  if(action.endsWith(".save"))return saveOperation(actor,action,payload,client);
  if(action==="payroll.approve"||action==="payroll.pay")return payroll(actor,action,payload,client);
  if(action==="stock.receive"||action==="stock.adjust") {
    authorize(actor,["owner","stock"]);
    if(action==="stock.receive") {const p=z.object({materialId:id,quantityMilli:money.refine(n=>n>0),costMinor:money}).parse(payload);await stock(client,p.materialId,p.quantityMilli,true,p.costMinor);return p;}
    const p=z.object({materialId:id,quantityMilli:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),reason:text}).parse(payload);await stock(client,p.materialId,Math.abs(p.quantityMilli),p.quantityMilli>=0);return p;
  }
  if(action==="purchase.receive") {
    authorize(actor,["owner","stock"]);const p=z.object({id}).parse(payload);const purchase=await getRecord<Purchase>("purchase",p.id,client,true);check(purchase,404,"Поставка не найдена");check(["draft","ordered"].includes(purchase.status),409,"Поставка уже принята или отменена");
    await stock(client,purchase.materialId,purchase.quantityMilli,true,roundedRatio(purchase.amountMinor,1000,purchase.quantityMilli));await saveRecord("purchase",purchase.id,{...purchase,status:"received"},client);
    await saveRecord("expense",`purchase-expense:${purchase.id}`,{name:purchase.name,category:"Материалы",amountMinor:purchase.amountMinor,date:new Date().toISOString().slice(0,10),paid:true},client);return {id:purchase.id};
  }
  if(action==="certificate.issue") {
    authorize(actor,managers);const p=z.object({clientId:id,nominalMinor:money.refine(n=>n>0),saleMinor:money,kind:z.enum(["certificate","package"]).default("certificate"),unitsRemaining:z.number().int().positive().optional(),serviceIds:z.array(id).min(1).max(100).optional()}).parse(payload);
    check(p.saleMinor<=p.nominalMinor,400,"Цена продажи превышает номинал");check(await getRecord("client",p.clientId,client),404,"Клиент не найден");check(p.kind!=="package"||p.unitsRemaining,400,"Укажите число посещений");
    if(p.kind==="package") {check(p.serviceIds?.length,400,"Выберите услуги абонемента");for(const serviceId of p.serviceIds)check(await getRecord("service",serviceId,client),404,"Услуга абонемента не найдена");}
    const recordId=randomUUID();const result=await saveRecord("certificate",recordId,{...p,code:`SI-${randomUUID().slice(0,8).toUpperCase()}`,balanceMinor:p.nominalMinor,liabilityMinor:p.saleMinor,status:"active"},client);
    await client.query("INSERT INTO payments(id,method,amount_minor,kind,certificate_id) VALUES($1,'card',$2,'certificate_sale',$3)",[randomUUID(),p.saleMinor,recordId]);return result;
  }
  if(action==="notification.create") {
    authorize(actor,managers);const p=z.object({clientId:id,purpose:z.enum(["service","marketing"]),name:text}).parse(payload);const c=await getRecord<Client>("client",p.clientId,client);check(c,404,"Клиент не найден");check(p.purpose!=="marketing"||c.marketingConsent,409,"Нет согласия на маркетинговые сообщения");
    return saveRecord("notification",randomUUID(),{name:p.name,recipient:c.phone,clientId:c.id,channel:"mock",purpose:p.purpose,status:"mock",date:new Date().toISOString()},client);
  }
  if(action==="import.preview"||action==="import.commit") {
    authorize(actor,managers);const p=z.object({csv:z.string().max(2000000)}).parse(payload);const parsed=importCsv(p.csv);if(action==="import.preview")return parsed;check(parsed.errors.length===0,400,"Исправьте ошибки импорта");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[parsed.fingerprint]);const old=await first<{result:unknown}>("SELECT result FROM import_runs WHERE fingerprint=$1",[parsed.fingerprint],client);if(old)return old.result;
    for(const c of parsed.rows)await saveRecord("client",randomUUID(),{...c,createdAt:new Date().toISOString(),accountId:null,importFingerprint:parsed.fingerprint},client);
    const result={imported:parsed.rows.length,fingerprint:parsed.fingerprint};await client.query("INSERT INTO import_runs(fingerprint,result) VALUES($1,$2)",[parsed.fingerprint,JSON.stringify(result)]);return result;
  }
  throw new AppError(400,"Неизвестная команда");
}

export async function runOperation(actor:Actor,action:string,payload:unknown,commandId:string):Promise<unknown> {
  id.parse(commandId);text.parse(action);check(actor?.id,401,"Войдите в аккаунт");
  const response = (result: unknown) => actor.role === "client" && action === "client.save" ? clientProfile(result as Client) : result;
  try {return await transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`command:${commandId}`]);
    const existing=await first<{actor_id:string;action:string;result:unknown}>("SELECT actor_id,action,result FROM commands WHERE id=$1",[commandId],client);
    if(existing) {check(existing.actor_id===actor.id&&existing.action===action,409,"Ключ команды уже использован");return response(existing.result);}
    const result=await execute(actor,action,payload,client);
    const entityId=payload&&typeof payload==="object"&&"id" in payload?String(payload.id):action;
    await audit(client,actor,action,entityId,{result});
    await client.query("INSERT INTO outbox(id,kind,payload) VALUES($1,'operation.completed',$2)",[randomUUID(),JSON.stringify({action,entityId,actorId:actor.id})]);
    await client.query("INSERT INTO commands(id,actor_id,action,result) VALUES($1,$2,$3,$4)",[commandId,actor.id,action,JSON.stringify(result)]);return response(result);
  });}catch(error) {if(error instanceof z.ZodError)throw new AppError(400,error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; "));throw error;}
}

