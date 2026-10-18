import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, rows, transaction } from '../../src/server/db';
import { resolvePayrollRule, savePayrollRule } from '../../src/server/payroll-rules';
import type { Actor } from '../../src/lib/contracts';

const owner: Actor = { id: 'rule-owner', name: 'Owner', role: 'owner' };
const staffId = `rules-${randomUUID()}`;
const initial = { commissionBps: 4000, fixedMinor: 100000, guaranteeMinor: 200000, guaranteeScope: 'total' as const };
const save = (effectiveFrom: string, changes = {}) => transaction(tx => savePayrollRule(owner, { staffId, effectiveFrom, ...initial, reason: 'New agreement', ...changes }, tx));

describe('immutable effective dated payroll rules', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('salonit_test')) throw new Error('Use salonit_test');
    await rows("INSERT INTO records(id,kind,data) VALUES ($1,'staff',$2)", [staffId, JSON.stringify({ name: 'Rule master', ...initial })]);
  });
  afterAll(async () => {
    await rows("DELETE FROM appointments WHERE client_id=$1", [staffId]);
    await rows("DELETE FROM records WHERE id=$1 OR (kind='payroll_rule' AND data->>'staffId'=$1)", [staffId]);
    await pool.end();
  });
  it('preserves baseline and selects inclusive Moscow effective boundary', async () => {
    const rule = await save('2030-02-15', { commissionBps: 4500 });
    expect((await transaction(tx => resolvePayrollRule(tx, staffId, '2030-02-14T20:59:59.999Z'))).commissionBps).toBe(4000);
    expect((await transaction(tx => resolvePayrollRule(tx, staffId, '2030-02-14T21:00:00Z'))).id).toBe(rule.id);
    await rows("UPDATE records SET data=jsonb_set(data,'{commissionBps}','9000') WHERE id=$1", [staffId]);
    expect((await transaction(tx => resolvePayrollRule(tx, staffId, '2029-01-01T00:00:00Z'))).commissionBps).toBe(4000);
    expect(await rows("SELECT * FROM records WHERE kind='payroll_rule' AND data->>'staffId'=$1", [staffId])).toHaveLength(2);
  });
  it('requires a month boundary for fixed or guarantee changes and never updates a version', async () => {
    await expect(save('2030-02-20', { fixedMinor: 150000 })).rejects.toThrow('первого');
    const next = await save('2030-03-01', { fixedMinor: 150000 });
    expect(next.version).toBe(3);
    await expect(save('2030-03-01', { fixedMinor: 160000 })).rejects.toThrow();
    expect((await transaction(tx => resolvePayrollRule(tx, staffId, '2030-03-01T00:00:00+03:00'))).fixedMinor).toBe(150000);
  });
  it('rejects effective dates that would rewrite completed service facts', async () => {
    const item = { staffId, status: 'completed', endAt: '2030-05-15T10:00:00Z', completedAt: '2030-05-15T11:00:00Z' };
    await rows("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor) VALUES($1,$2,$3,'completed','2030-05-15T10:00Z','2030-05-15T11:00Z',$4,0)", [randomUUID(), randomUUID(), staffId, JSON.stringify([item])]);
    await expect(save('2030-05-15', { commissionBps: 5000, fixedMinor: 150000 })).rejects.toThrow('завершён');
    expect((await transaction(tx => resolvePayrollRule(tx, staffId, '2030-05-15T11:00:00Z'))).commissionBps).toBe(4000);
    await expect(transaction(tx => savePayrollRule({ ...owner, role: 'admin' }, {}, tx))).rejects.toThrow();
  });
});
