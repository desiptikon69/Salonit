import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Resource, Service, Staff, VisitItem } from '../../src/lib/contracts';
import { planVisit } from '../../src/domain/scheduling';
import { baselinePayrollRule } from '../../src/domain/payroll-rules';
import { runBookingCommand } from '../../src/server/booking';
import { pool, rows } from '../../src/server/db';
import { runOperation } from '../../src/server/operations';
import { saveRecord } from '../../src/server/records';

const owner: Actor = { id: 'workflow-owner', name: 'Владелец', role: 'owner' };
const master: Actor = { id: 'workflow-master', name: 'Мастер', role: 'master', staffId: 'workflow-staff' };
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + 2 * 86400000));
const time = (hour: number) => `${date}T${String(hour).padStart(2, '0')}:00:00+03:00`;
const staff: Staff = { id: 'workflow-staff', name: 'Мастер', title: '', initials: 'М', color: 'green', skills: ['hair', 'hands'], commissionBps: 4000, fixedMinor: 0, guaranteeMinor: 0, guaranteeScope: 'total', active: true, workStart: '09:00', workEnd: '21:00' };
const service: Service = { id: 'workflow-base', name: 'Уход', description: '', category: 'Волосы', durationMinutes: 60, bufferMinutes: 10, priceMinor: 100000, skill: 'hair', resourceType: 'chair', active: true, norms: [{ materialId: 'workflow-material', quantityMilli: 5000 }] };
const extra: Service = { ...service, id: 'workflow-extra', name: 'Дополнительный уход', priceMinor: 50000, durationMinutes: 30, norms: [{ materialId: 'workflow-material', quantityMilli: 3000 }] };
const chair: Resource = { id: 'workflow-chair', name: 'Кресло', type: 'chair', ready: true, status: 'ready' };
const call = (action: string, payload: unknown, actor = owner) => runOperation(actor, action, payload, randomUUID());
async function state(id: string) {
  return (await rows<{ status: string; version: number; items: VisitItem[]; closed_at: Date | null }>('SELECT status,version,items,closed_at FROM appointments WHERE id=$1', [id]))[0];
}
async function appointment(items: VisitItem[], status: string, active = true) {
  const id = randomUUID();
  await rows('INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, `WF-${id}`, 'workflow-client', status, items[0].startAt, items.at(-1)!.endAt, JSON.stringify(items), items.reduce((sum, item) => sum + item.priceMinor, 0)]);
  for (const item of items) for (const allocation of item.reservations ?? []) await rows('INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at,active) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), id, allocation.resourceKey, allocation.startAt, allocation.endAt, active]);
  return id;
}
function planned(selected = service, startAt = time(10), resources = [chair]) {
  const plan = planVisit({ services: [selected], staff: [staff], resources, startAt, mode: 'sequential', busy: [] });
  if (!plan) throw new Error('Invalid workflow fixture');
  return plan.items[0];
}
async function append(id: string) {
  return runBookingCommand(owner, 'visit.addService', { id, version: (await state(id)).version, serviceId: extra.id, reason: 'Клиент добавил уход' }, randomUUID());
}
async function status(id: string, value: 'in_progress' | 'completed') {
  return call('visit.status', { id, version: (await state(id)).version, status: value });
}

describe('workflow regressions across execution, materials, tools and payroll', () => {
  beforeEach(async () => {
    if (new URL(process.env.DATABASE_URL ?? '').pathname !== '/salonit_test') throw new Error('Dedicated salonit_test database required');
    await rows('TRUNCATE appointments,records,payments,consumptions,accruals,payouts,audit_events,outbox,commands CASCADE');
    await saveRecord('staff', staff.id, staff);
    await saveRecord('service', service.id, service);
    await saveRecord('service', extra.id, extra);
    await saveRecord('resource', chair.id, chair);
    await saveRecord('client', 'workflow-client', { name: 'Тестовый клиент', phone: '+79000000011', marketingConsent: false });
    await saveRecord('material', 'workflow-material', { name: 'Средство', unit: 'ml', stockMilli: 100000, minStockMilli: 1000, costMinor: 1000, supplier: 'Тест' });
  });
  afterAll(() => pool.end());

  it('requires a manager to start an appended planned service before completing it', async () => {
    const id = await appointment([{ ...planned(), status: 'in_progress' }], 'in_progress');
    await append(id);
    const before = await state(id);
    expect(before.items.map(item => item.status)).toEqual(['in_progress', 'planned']);
    await expect(status(id, 'completed')).rejects.toThrow(/начните/);
    expect(await state(id)).toEqual(before);
    await status(id, 'in_progress');
    await status(id, 'completed');
    const completed = await state(id);
    expect(completed.status).toBe('completed');
    expect(completed.items.every(item => item.status === 'completed' && !!item.completedAt)).toBe(true);
  });

  it('requires manager review of prior actual usage after appending service before any close side effects', async () => {
    const id = await appointment([{ ...planned(), status: 'in_progress' }], 'in_progress');
    await call('visit.materials', { id, version: 1, materials: [{ materialId: 'workflow-material', quantityMilli: 8000 }] }, master);
    await append(id);
    expect(await rows("SELECT id FROM records WHERE kind='material_review' AND data->>'visitId'=$1", [id])).toHaveLength(1);
    await status(id, 'in_progress');
    await status(id, 'completed');
    await call('visit.materials', { id, version: (await state(id)).version, materials: [{ materialId: 'workflow-material', quantityMilli: 11000 }] }, master);
    // Inline close materials must not silently acknowledge a changed service graph.
    await expect(call('visit.close', { id, version: (await state(id)).version, payments: [], materials: [{ materialId: 'workflow-material', quantityMilli: 11000 }] })).rejects.toThrow(/расход/);
    expect(await rows('SELECT id FROM consumptions')).toHaveLength(0);
    expect(await rows('SELECT id FROM accruals')).toHaveLength(0);
    expect(await rows('SELECT id FROM payments')).toHaveLength(0);
    expect((await rows<{ data: { stockMilli: number } }>("SELECT data FROM records WHERE id='workflow-material'"))[0].data.stockMilli).toBe(100000);
    await call('visit.materials', { id, version: (await state(id)).version, materials: [{ materialId: 'workflow-material', quantityMilli: 11000 }] });
    expect(await rows("SELECT id FROM records WHERE kind='material_review' AND data->>'visitId'=$1", [id])).toHaveLength(0);
    await call('visit.close', { id, version: (await state(id)).version, payments: [] });
    expect((await rows<{ quantity_milli: string }>('SELECT quantity_milli FROM consumptions WHERE visit_id=$1', [id]))[0].quantity_milli).toBe('11000');
    expect((await state(id)).closed_at).toBeInstanceOf(Date);
  });

  it('blocks starting a later reservation while its instrument remains in an earlier running service', async () => {
    const tool: Resource = { id: 'workflow-tool', name: 'Набор инструментов', type: 'tools-hands', ready: true, status: 'ready' };
    await saveRecord('resource', tool.id, tool);
    const nail: Service = { ...service, id: 'workflow-nails', skill: 'hands', resourceType: 'chair' };
    const past = '2025-01-10';
    const first = await appointment([{ ...planned(nail, `${past}T09:00:00+03:00`, [chair, tool]), status: 'arrived' }], 'arrived');
    const second = await appointment([{ ...planned(nail, `${past}T11:00:00+03:00`, [chair, tool]), status: 'arrived' }], 'arrived');
    await status(first, 'in_progress');
    const before = await state(second);
    await expect(status(second, 'in_progress')).rejects.toThrow(/используется/);
    expect(await state(second)).toEqual(before);
    expect((await state(first)).items[0].status).toBe('in_progress');
    expect((await rows<{ data: Resource }>('SELECT data FROM records WHERE id=$1', [tool.id]))[0].data.status).toBe('ready');
  });

  it('blocks payroll payout for completed unclosed services by actual month, then includes their close accrual', async () => {
    const completedAt = new Date().toISOString();
    const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(new Date(completedAt));
    const rule = baselinePayrollRule(staff);
    const old = { ...planned(service, '2025-01-10T10:00:00+03:00'), status: 'completed', completedAt, rewardRuleId: rule.id, rewardRuleSnapshot: rule };
    const id = await appointment([old], 'completed', false);
    await call('payroll.approve', { month });
    await expect(call('payroll.pay', { month })).rejects.toThrow(/закройте визиты/);
    expect(await rows('SELECT id FROM payouts')).toHaveLength(0);
    expect((await rows<{ data: { status: string } }>("SELECT data FROM records WHERE kind='payroll'"))[0].data.status).toBe('approved');
    expect((await state(id)).closed_at).toBeNull();
    await call('visit.close', { id, version: 1, payments: [] });
    expect((await rows<{ period: string }>("SELECT to_char(date,'YYYY-MM') AS period FROM accruals WHERE visit_id=$1", [id]))[0].period).toBe(month);
    await call('payroll.approve', { month });
    await call('payroll.pay', { month });
    expect((await rows<{ amount_minor: string }>('SELECT amount_minor FROM payouts'))[0].amount_minor).toBe('38000');
    expect((await rows<{ status: string }>('SELECT status FROM accruals WHERE visit_id=$1', [id]))[0].status).toBe('paid');
  });
});
