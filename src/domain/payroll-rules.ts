import type { PayrollRule, Staff } from '@/lib/contracts';

export const BASELINE_EFFECTIVE_FROM = '0001-01-01T00:00:00.000Z';
/** A date entered in the salon UI takes effect at midnight in Moscow. */
export function payrollEffectiveAt(value: string | Date): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+03:00` : raw;
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized) || !Number.isFinite(Date.parse(normalized))) throw new Error('Укажите корректную дату вступления правила в силу');
  const iso = new Date(normalized).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && new Date(Date.parse(iso) + 10800000).toISOString().slice(0, 10) !== raw) throw new Error('Укажите корректную календарную дату');
  return iso;
}
export function isPayrollMonthStart(instant: string): boolean {
  return new Date(Date.parse(instant) + 10800000).toISOString().slice(8) === '01T00:00:00.000Z';
}
export function baselinePayrollRule(staff: Staff, createdAt = new Date().toISOString(), createdBy = 'legacy'): PayrollRule {
  return { id: `payroll-baseline:${staff.id}`, staffId: staff.id, effectiveFrom: BASELINE_EFFECTIVE_FROM, commissionBps: staff.commissionBps, fixedMinor: staff.fixedMinor, guaranteeMinor: staff.guaranteeMinor, guaranteeScope: staff.guaranteeScope, reason: 'Исходные условия до введения версий', version: 1, baseline: true, createdAt, createdBy };
}
export function selectPayrollRule(rules: PayrollRule[], eventAt: string | Date): PayrollRule | undefined {
  const at = Date.parse(payrollEffectiveAt(eventAt));
  return rules.filter(rule => Date.parse(rule.effectiveFrom) <= at).sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom) || b.version - a.version)[0];
}
