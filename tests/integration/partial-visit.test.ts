import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { pool, rows } from '../../src/server/db';
import { runOperation } from '../../src/server/operations';
import type { Actor, VisitItem } from '../../src/lib/contracts';
const owner:Actor={id:'test-owner',name:'Owner',role:'owner'};
const call=(action:string,payload:unknown,actor=owner,key=randomUUID())=>runOperation(actor,action,payload,key);
let id:string;
let items:VisitItem[];
beforeEach(async()=>{
 if(!process.env.DATABASE_URL?.includes('salonit_test'))throw new Error('Isolated database required');
 await rows('TRUNCATE appointments, records, payments, consumptions, accruals, payouts, audit_events, outbox, commands, import_runs CASCADE');
 id=randomUUID();
 const startAt='2026-10-20T09:00:00.000Z';
 items=['a','b'].map((name,index)=>({id:name,serviceId:name,serviceName:name,staffId:"staff-"+name,staffName:name,startAt,endAt:`2026-10-20T${index===0?'11':'10'}:00:00.000Z`,priceMinor:10000,commissionBps:4000,norms:[{materialId:name,quantityMilli:1000}],status:'planned',reservations:[{resourceKey:'staff:staff-'+name,startAt,endAt:`2026-10-20T${index===0?'11':'10'}:10:00.000Z`},{resourceKey:'resource:chair',startAt,endAt:`2026-10-20T${index===0?'11':'10'}:10:00.000Z`}]}));
 for(const item of items)await rows("INSERT INTO records(id,kind,data) VALUES($1,'staff',$2)",[item.staffId,JSON.stringify({name:item.staffName,commissionBps:4000,fixedMinor:0,guaranteeMinor:0,guaranteeScope:"total",active:true})]);
 for(const item of items)await rows("INSERT INTO records(id,kind,data) VALUES($1,'material',$2)",[item.id,JSON.stringify({name:item.id,stockMilli:10000,costMinor:100})]);
 await rows("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor) VALUES($1,$2,'client','confirmed',$3,$4,$5,20000)",[id,id,startAt,items[0].endAt,JSON.stringify(items)]);
 for(const r of [...items[0].reservations!,items[1].reservations![0]])await rows('INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,r.resourceKey,r.startAt,r.endAt]);
});
afterAll(()=>pool.end());
it('releases only cancelled staff and shared-chair tail, retains item history, closes only remaining item',async()=>{
 const payload={id,itemId:'a',version:1,reason:'Guest changed plans'};const key=randomUUID();
 expect(await call('visit.item.cancel',payload,owner,key)).toEqual(await call('visit.item.cancel',payload,owner,key));
 const reserved=await rows<{resource_key:string;end_at:Date}>('SELECT resource_key,end_at FROM allocations WHERE appointment_id=$1',[id]);
 expect(reserved.some(r=>r.resource_key==='staff:staff-a')).toBe(false);
 expect(reserved.find(r=>r.resource_key==='resource:chair')?.end_at.toISOString()).toBe('2026-10-20T10:10:00.000Z');
 await call('visit.status',{id,version:2,status:'arrived'});await call('visit.status',{id,version:3,status:'in_progress'});await call('visit.status',{id,version:4,status:'completed'});
 await call('visit.close',{id,version:5,payments:[{method:'cash',amountMinor:10000}]});
 const visit=(await rows<{items:VisitItem[];total_minor:string}>('SELECT items,total_minor FROM appointments WHERE id=$1',[id]))[0];
 expect(visit.items[0]).toMatchObject({status:'cancelled',cancellationReason:payload.reason});expect(Number(visit.total_minor)).toBe(10000);
 expect((await rows<{staff_id:string}>('SELECT staff_id FROM accruals')).map(a=>a.staff_id)).toEqual(['staff-b']);
 expect((await rows<{material_id:string}>('SELECT material_id FROM consumptions')).map(a=>a.material_id)).toEqual(['b']);
});
it('rejects unauthorized, stale, started, last and legacy cancellation',async()=>{
 const payload={id,itemId:'a',version:1,reason:'Reason'};
 await expect(call('visit.item.cancel',payload,{id:'master',name:'Master',role:'master',staffId:'a'})).rejects.toThrow();
 await expect(call('visit.item.cancel',{...payload,version:2})).rejects.toThrow();
 await rows("UPDATE appointments SET items=jsonb_set(items,'{0,status}','\"in_progress\"') WHERE id=$1",[id]);
 await expect(call('visit.item.cancel',payload)).rejects.toThrow();
 await rows("UPDATE appointments SET items=$2 WHERE id=$1",[id,JSON.stringify(items.map(i=>({...i,reservations:undefined})))]);
 await expect(call('visit.item.cancel',payload)).rejects.toThrow('схемы ресурсов');
 await rows("UPDATE appointments SET items=$2 WHERE id=$1",[id,JSON.stringify(items)]);
 await call('visit.item.cancel',payload);
 await expect(call('visit.item.cancel',{id,itemId:'b',version:2,reason:'Last'})).rejects.toThrow('Последнюю');
});
it('does not guess how to divide already entered actual usage',async()=>{
 await rows("INSERT INTO records(id,kind,data) VALUES('fact','visit_material_fact',$1)",[JSON.stringify({visitId:id,staffId:'*',materials:[{materialId:'a',quantityMilli:1000}]})]);
 await expect(call('visit.item.cancel',{id,itemId:'a',version:1,reason:'Reason'})).rejects.toThrow('расход');
 expect((await rows<{version:number}>('SELECT version FROM appointments WHERE id=$1',[id]))[0].version).toBe(1);
});


