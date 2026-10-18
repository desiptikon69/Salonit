import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, PayrollRule, Staff } from '@/lib/contracts';
import { baselinePayrollRule, isPayrollMonthStart, payrollEffectiveAt, selectPayrollRule } from '@/domain/payroll-rules';
import { first, rows, type SqlClient } from './db';
import { AppError, requireCondition as check } from './errors';
import { authorize } from './permissions';
import { audit, getRecord } from './records';

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ staffId: z.string().min(1).max(200), effectiveFrom: z.string().min(1).max(40), commissionBps: z.number().int().min(0).max(10000), fixedMinor: money, guaranteeMinor: money, guaranteeScope: z.enum(['total', 'variable']), reason: z.string().trim().min(1).max(2000) }).strict();
async function ruleHistory(tx: SqlClient, staffId: string): Promise<PayrollRule[]> {
  return (await rows<{ id: string; data: PayrollRule }>("SELECT id,data FROM records WHERE kind='payroll_rule' AND data->>'staffId'=$1", [staffId], tx)).map(r => ({ ...r.data, id: r.id }));
}
export async function resolvePayrollRule(tx: SqlClient, staffId: string, eventAt: string | Date): Promise<PayrollRule> {
  const stored = await ruleHistory(tx, staffId);
  const found = selectPayrollRule(stored, eventAt);
  if (found) return found;
  const staff = await getRecord<Staff>('staff', staffId, tx);
  check(staff, 404, 'Сотрудник не найден');
  check(!stored.length, 409, 'Для даты услуги не найдены исходные условия начисления');
  return baselinePayrollRule(staff);
}
/** Appends a version. Historical rows are never updated or deleted. Caller owns transaction/idempotency. */
export async function savePayrollRule(actor: Actor, payload: unknown, tx: SqlClient): Promise<PayrollRule> {
  authorize(actor, ['owner']);
  const p = schema.parse(payload);
  let effectiveFrom: string;
  try { effectiveFrom = payrollEffectiveAt(p.effectiveFrom); } catch (error) { throw new AppError(400, (error as Error).message); }
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`payroll-rule:${p.staffId}`]);
  const staff = await getRecord<Staff>('staff', p.staffId, tx, true);
  check(staff, 404, 'Сотрудник не найден');
  const history = await ruleHistory(tx, p.staffId);
  const baseline = baselinePayrollRule(staff, new Date().toISOString(), actor.id);
  const latest = history.sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0] ?? baseline;
  check(Date.parse(effectiveFrom) > Date.parse(latest.effectiveFrom), 409, 'Новая версия должна вступать в силу после последней сохранённой версии');
  const monthlyChanged = p.fixedMinor !== latest.fixedMinor || p.guaranteeMinor !== latest.guaranteeMinor || p.guaranteeScope !== latest.guaranteeScope;
  check(!monthlyChanged || isPayrollMonthStart(effectiveFrom), 400, 'Фиксированная часть и гарантия меняются только с первого числа месяца');
  const day = new Date(Date.parse(effectiveFrom) + 10800000).toISOString().slice(0, 10);
  const completed = await first(`SELECT 1 FROM appointments a CROSS JOIN LATERAL jsonb_array_elements(a.items) item
    WHERE item->>'staffId'=$1 AND (item->>'status'='completed' OR (a.status='completed' AND item->>'status' IS DISTINCT FROM 'cancelled'))
    AND COALESCE(NULLIF(item->>'completedAt','')::timestamptz,NULLIF(item->>'endAt','')::timestamptz,a.end_at)>=$2::timestamptz LIMIT 1`, [p.staffId, effectiveFrom], tx);
  const accrued = await first('SELECT 1 FROM accruals WHERE staff_id=$1 AND date >= $2::date LIMIT 1', [p.staffId, day], tx);
  check(!completed && !accrued, 409, 'Правило затронет уже завершённые услуги или начисления. Выберите более позднюю дату');
  if (monthlyChanged) {
    const month = day.slice(0, 7);
    check(!await first("SELECT 1 FROM payouts WHERE staff_id=$1 AND month >= $2 UNION ALL SELECT 1 FROM records WHERE kind='payroll' AND data->>'month'>=$2 AND data->>'status' IN ('approved','paid') LIMIT 1", [p.staffId, month], tx), 409, 'Нельзя изменить условия уже утверждённого периода');
  }
  if (!history.length) await tx.query("INSERT INTO records(id,kind,data) VALUES($1,'payroll_rule',$2)", [baseline.id, JSON.stringify(baseline)]);
  const next: PayrollRule = { ...p, id: randomUUID(), effectiveFrom, version: Math.max(...history.map(rule => rule.version), 1) + 1, createdAt: new Date().toISOString(), createdBy: actor.id };
  await tx.query("INSERT INTO records(id,kind,data) VALUES($1,'payroll_rule',$2)", [next.id, JSON.stringify(next)]);
  await audit(tx, actor, 'payroll.rule.save', next.id, { staffId: p.staffId, effectiveFrom, version: next.version, reason: p.reason });
  return next;
}
