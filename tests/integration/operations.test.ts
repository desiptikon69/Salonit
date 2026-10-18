import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, rows } from '../../src/server/db';
import { runOperation } from '../../src/server/operations';
import type { Actor, VisitItem } from '../../src/lib/contracts';

const owner: Actor = { id: 'test-owner', name: 'Owner', role: 'owner' };
const master: Actor = { id: 'test-master', name: 'Master', role: 'master', staffId: 'test-staff' };
const command = (action: string, payload: unknown, actor = owner, id = randomUUID()) => runOperation(actor, action, payload, id);
let visitId: string;
async function record(kind: string, id: string, data: unknown) {
  await rows('INSERT INTO records(id,kind,data) VALUES ($1,$2,$3::jsonb)', [id, kind, JSON.stringify(data)]);
}

describe('transactional salon operations', () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL?.includes('salonit_test')) throw new Error('Use isolated salonit_test database');
    await rows('TRUNCATE appointments, records, payments, consumptions, accruals, payouts, audit_events, outbox, commands, import_runs CASCADE');
    await record('staff', 'test-staff', { name: 'Master', commissionBps: 4000, fixedMinor: 800000, guaranteeMinor: 1000000, guaranteeScope: 'variable', active: true });
    await record('staff', 'other-staff', { name: 'Other master', commissionBps: 4000, fixedMinor: 0, guaranteeMinor: 0, guaranteeScope: 'total', active: false });
    await record('client', 'test-client', { name: 'Client', phone: '+79990000000', marketingConsent: false });
    await record('material', 'test-material', { name: 'Cream', unit: 'ml', stockMilli: 100000, minStockMilli: 1000, costMinor: 10000, supplier: 'Test' });
    const item: VisitItem = { id: 'item', serviceId: 'service', serviceName: 'Treatment', staffId: 'test-staff', staffName: 'Master', startAt: '2026-10-12T09:00:00Z', endAt: '2026-10-12T10:00:00Z', priceMinor: 300000, commissionBps: 4000, norms: [{ materialId: 'test-material', quantityMilli: 6000 }], status: 'completed' };
    visitId = randomUUID();
    await rows("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor,paid_minor,materials,version,receipt_status,note) VALUES ($1,'TEST','test-client','completed',$2,$3,$4,300000,0,'[]',1,'unconfirmed','')", [visitId, item.startAt, item.endAt, JSON.stringify([item])]);
  });
  afterAll(async () => { await pool.end(); });

  it('closes once, facts replace norms, cash and card remain separate, payroll is not paid', async () => {
    const id = randomUUID();
    const payload = { id: visitId, version: 1, materials: [{ materialId: 'test-material', quantityMilli: 8000 }], payments: [{ method: 'cash', amountMinor: 100000 }, { method: 'card', amountMinor: 200000 }] };
    const first = await command('visit.close', payload, owner, id);
    expect(await command('visit.close', payload, owner, id)).toEqual(first);
    await expect(command('visit.close', payload)).rejects.toThrow();
    expect((await rows<{ n: string }>('SELECT count(*) n FROM payments'))[0].n).toBe('2');
    expect(Number((await rows<{ quantity_milli: string }>('SELECT quantity_milli FROM consumptions'))[0].quantity_milli)).toBe(8000);
    expect((await rows<{ data: { stockMilli: number } }>("SELECT data FROM records WHERE id='test-material'"))[0].data.stockMilli).toBe(92000);
    expect((await rows<{ status: string }>('SELECT status FROM accruals'))[0].status).toBe('draft');
  });
  it('allows debt but rejects overpayment and rolls back inventory', async () => {
    await expect(command('visit.close', { id: visitId, version: 1, payments: [{ method: 'cash', amountMinor: 300001 }] })).rejects.toThrow();
    expect((await rows('SELECT * FROM consumptions')).length).toBe(0);
    await command('visit.close', { id: visitId, version: 1, payments: [{ method: 'cash', amountMinor: 100000 }] });
    expect(Number((await rows<{ paid_minor: string }>('SELECT paid_minor FROM appointments'))[0].paid_minor)).toBe(100000);
  });
  it('requires completed execution and restricts master financial access', async () => {
    await expect(command('visit.close', { id: visitId, version: 1, payments: [] }, master)).rejects.toThrow();
    await rows("UPDATE appointments SET status='confirmed', items=jsonb_set(items,'{0,status}','\"confirmed\"')");
    await expect(command('visit.close', { id: visitId, version: 1, payments: [] })).rejects.toThrow();
  });
  it('cannot redeem a discounted certificate twice and caps refunds at recognized value', async () => {
    await record('certificate', 'test-cert', { code: 'TEST-CERT', clientId: 'test-client', nominalMinor: 300000, saleMinor: 240000, balanceMinor: 300000, liabilityMinor: 240000, status: 'active', kind: 'certificate' });
    await command('visit.close', { id: visitId, version: 1, payments: [{ method: 'certificate', certificateCode: 'TEST-CERT', amountMinor: 300000 }] });
    const cert = (await rows<{ data: { balanceMinor: number; liabilityMinor: number } }>("SELECT data FROM records WHERE id='test-cert'"))[0].data;
    expect(cert).toMatchObject({ balanceMinor: 0, liabilityMinor: 0 });
    await expect(command('visit.refund', { id: visitId, amountMinor: 240001, reason: 'Return' })).rejects.toThrow();
    await command('visit.refund', { id: visitId, amountMinor: 240000, reason: 'Return' });
    await expect(command('visit.refund', { id: visitId, amountMinor: 1, reason: 'Return' })).rejects.toThrow();
    expect((await rows<{ n: string }>('SELECT count(*) n FROM consumptions'))[0].n).toBe('1');
  });
  it('applies monthly guarantee once and requires approved payroll', async () => {
    await command('visit.close', { id: visitId, version: 1, payments: [] });
    await expect(command('payroll.pay', { month: '2026-10' })).rejects.toThrow();
    await command('payroll.approve', { month: '2026-10' });
    await command('payroll.pay', { month: '2026-10' });
    await command('payroll.pay', { month: '2026-10' });
    const payouts = await rows<{ amount_minor: string }>('SELECT amount_minor FROM payouts');
    expect(payouts).toHaveLength(1);
    expect(Number(payouts[0].amount_minor)).toBe(1800000);
  });
  it('rolls back stock insufficiency and rejects idempotency scope collisions', async () => {
    await expect(command('visit.close', { id: visitId, version: 1, payments: [], materials: [{ materialId: 'test-material', quantityMilli: 100001 }] })).rejects.toThrow();
    expect(await rows('SELECT * FROM payments')).toHaveLength(0);
    const key = randomUUID();
    await command('stock.receive', { materialId: 'test-material', quantityMilli: 1000, costMinor: 10000 }, owner, key);
    await expect(command('stock.adjust', { materialId: 'test-material', quantityMilli: 1000, reason: 'count' }, owner, key)).rejects.toThrow();
  });
  it('imports identical files once without merging clients by phone', async () => {
    const csv = 'name,phone,email\nAlice,+79990000000,a@example.com\nBob,+79990000000,b@example.com';
    await command('import.commit', { csv });
    await command('import.commit', { csv });
    expect((await rows<{ n: string }>("SELECT count(*) n FROM records WHERE kind='client'"))[0].n).toBe('3');
    await expect(command('import.commit', { csv: 'name,phone\nMissing,' })).rejects.toThrow();
  });
  it('suppresses unconsented marketing and restricts client profile fields', async () => {
    await expect(command('notification.create', { clientId: 'test-client', purpose: 'marketing', name: 'Sale' })).rejects.toThrow();
    const client: Actor = { id: 'client-login', name: 'Client', role: 'client', clientId: 'test-client' };
    await expect(command('client.save', { id: 'other-client', name: 'Fake', phone: '+79990000000', email: '', notes: '', marketingConsent: true }, client)).rejects.toThrow();
  });

  it('serializes concurrent closes and rolls back the losing command atomically', async () => {
    const payload = { id: visitId, version: 1, payments: [{ method: 'card', amountMinor: 300000 }] };
    const results = await Promise.allSettled([command('visit.close', payload), command('visit.close', payload)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await rows('SELECT * FROM consumptions')).toHaveLength(1);
    expect(await rows('SELECT * FROM payments')).toHaveLength(1);
    expect(await rows('SELECT * FROM audit_events')).toHaveLength(1);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(1);
  });

  it('preserves other masters execution and attributes their actual material costs separately', async () => {
    const item = (await rows<{ items: VisitItem[] }>('SELECT items FROM appointments WHERE id=$1', [visitId]))[0].items[0];
    const second: VisitItem = { ...item, id: 'second-item', staffId: 'other-staff', serviceName: 'Another treatment', norms: [], status: 'arrived' };
    await rows("UPDATE appointments SET items=$2,status='arrived',total_minor=600000 WHERE id=$1", [visitId, JSON.stringify([{ ...item, status: 'arrived' }, second])]);
    await command('visit.status', { id: visitId, status: 'in_progress', version: 1 }, master);
    await command('visit.status', { id: visitId, status: 'completed', version: 2 }, master);
    const current = (await rows<{ items: VisitItem[]; status: string }>('SELECT items,status FROM appointments WHERE id=$1', [visitId]))[0];
    expect(current.status).toBe('in_progress');
    expect(current.items[1].status).toBe('arrived');
    await command('visit.materials', { id: visitId, version: 3, materials: [{ materialId: 'test-material', quantityMilli: 8000 }] }, master);
    await expect(command('visit.status', { id: visitId, status: 'completed', version: 4 })).rejects.toThrow(/начните/);
    await command('visit.status', { id: visitId, status: 'in_progress', version: 4 });
    await command('visit.status', { id: visitId, status: 'completed', version: 5 });
    await command('visit.close', { id: visitId, version: 6, payments: [] });
    const accruals = await rows<{ staff_id: string; amount_minor: string }>('SELECT staff_id,amount_minor FROM accruals ORDER BY staff_id');
    expect(accruals).toEqual([{ staff_id: 'other-staff', amount_minor: '120000' }, { staff_id: 'test-staff', amount_minor: '88000' }]);
  });

  it('rolls back certificate redemption, inventory and money when a later payment fails', async () => {
    await record('certificate', 'test-cert', { code: 'A-CERT', clientId: 'test-client', nominalMinor: 100000, saleMinor: 80000, balanceMinor: 100000, liabilityMinor: 80000, status: 'active', kind: 'certificate' });
    await expect(command('visit.close', { id: visitId, version: 1, payments: [{ method: 'certificate', certificateCode: 'A-CERT', amountMinor: 100000 }, { method: 'certificate', certificateCode: 'Z-MISSING', amountMinor: 100000 }] })).rejects.toThrow();
    expect((await rows<{ data: { balanceMinor: number } }>("SELECT data FROM records WHERE id='test-cert'"))[0].data.balanceMinor).toBe(100000);
    expect((await rows<{ data: { stockMilli: number } }>("SELECT data FROM records WHERE id='test-material'"))[0].data.stockMilli).toBe(100000);
    expect(await rows('SELECT * FROM payments')).toHaveLength(0);
    expect(await rows('SELECT * FROM commands')).toHaveLength(0);
  });

  it('restricts package redemption to eligible services and consumes one entitlement per service', async () => {
    await record('certificate', 'package', { code: 'PACKAGE', clientId: 'test-client', nominalMinor: 600000, saleMinor: 480000, balanceMinor: 600000, liabilityMinor: 480000, status: 'active', kind: 'package', unitsRemaining: 2, serviceIds: ['other-service'] });
    const payload = { id: visitId, version: 1, payments: [{ method: 'certificate', certificateCode: 'PACKAGE', amountMinor: 300000 }] };
    await expect(command('visit.close', payload)).rejects.toThrow();
    await rows("UPDATE records SET data=jsonb_set(data,'{serviceIds}','[\"service\"]') WHERE id='package'");
    await command('visit.close', payload);
    const data = (await rows<{ data: { unitsRemaining: number; liabilityMinor: number; balanceMinor: number } }>("SELECT data FROM records WHERE id='package'"))[0].data;
    expect(data).toMatchObject({ unitsRemaining: 1, balanceMinor: 300000, liabilityMinor: 240000 });
  });

  it('prevents late closing into a paid payroll period without consuming stock', async () => {
    await command('payroll.approve', { month: '2026-10' });
    await expect(command('payroll.pay', { month: '2026-10' })).rejects.toThrow(/закройте визиты/);
    // Simulate a legacy externally paid period to retain the late-close guard regression.
    await rows("INSERT INTO payouts(id,month,staff_id,amount_minor) VALUES($1,'2026-10','test-staff',0)",[randomUUID()]);
    await expect(command('visit.close', { id: visitId, version: 1, payments: [] })).rejects.toThrow(/Период/);
    expect(await rows('SELECT * FROM consumptions')).toHaveLength(0);
    expect(await rows('SELECT * FROM accruals')).toHaveLength(0);
  });

  it('settles a package by visits even if the service price has changed', async () => {
    await record('certificate', 'package', { code: 'PACKAGE', clientId: 'test-client', nominalMinor: 200000, saleMinor: 160000, balanceMinor: 200000, liabilityMinor: 160000, status: 'active', kind: 'package', unitsRemaining: 1, serviceIds: ['service'] });
    await command('visit.close', { id: visitId, version: 1, payments: [{ method: 'certificate', certificateCode: 'PACKAGE', amountMinor: 300000 }] });
    expect((await rows<{ data: object }>("SELECT data FROM records WHERE id='package'"))[0].data).toMatchObject({ unitsRemaining: 0, balanceMinor: 0, liabilityMinor: 0, status: 'redeemed' });
    expect((await rows<{amount_minor:string}>("SELECT amount_minor FROM payments"))[0].amount_minor).toBe('160000');
  });

  it('collects closed visit debt once without repeating stock or commission', async () => {
    await command('visit.close', { id: visitId, version: 1, payments: [{ method: 'cash', amountMinor: 100000 }] });
    const id=randomUUID();const payload={id:visitId,version:2,method:'card',amountMinor:200000};
    await command('visit.payment',payload,owner,id);await command('visit.payment',payload,owner,id);
    await expect(command('visit.payment',{...payload,version:3,amountMinor:1})).rejects.toThrow();
    expect(await rows('SELECT * FROM payments')).toHaveLength(2);
    expect(await rows('SELECT * FROM consumptions')).toHaveLength(1);
    expect(await rows('SELECT * FROM accruals')).toHaveLength(1);
    expect((await rows<{paid_minor:string}>('SELECT paid_minor FROM appointments'))[0].paid_minor).toBe('300000');
  });

  it('allows a client to cancel only their own confirmed visit', async () => {
    const actor:Actor={id:'client-user',name:'Client',role:'client',clientId:'test-client'};
    await rows("UPDATE appointments SET status='confirmed'");
    await expect(command('visit.status',{id:visitId,status:'cancelled',version:1},{...actor,clientId:'other-client'})).rejects.toThrow();
    await command('visit.status',{id:visitId,status:'cancelled',version:1},actor);
    expect((await rows<{status:string}>('SELECT status FROM appointments'))[0].status).toBe('cancelled');
  });

  it('accepts client feedback without client-controlled resolution or assignment', async () => {
    const actor:Actor={id:'client-user',name:'Client',role:'client',clientId:'test-client'};
    const result=await command('complaint.save',{name:'Feedback',visitId,clientId:'test-client',reason:'Quality',assignee:'Owner',status:'resolved',resolution:'Forged',dueDate:'2026-10-14'},actor);
    expect(result).toMatchObject({status:'open',assignee:'Администратор',resolution:''});
    await expect(command('complaint.save',{name:'Feedback',visitId,clientId:'test-client',reason:'Quality',assignee:'Owner',status:'open',dueDate:'2026-10-14'},{...actor,clientId:'other-client'})).rejects.toThrow();
  });
});
