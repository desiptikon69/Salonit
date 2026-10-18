import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, rows } from '../../src/server/db';
import { getWorkspace, validateFinancePeriod } from '../../src/server/queries';
import { settings } from '../../src/server/sample-data';
import type { Actor } from '../../src/lib/contracts';

const owner: Actor = { id: 'finance-test-owner', name: 'Owner', role: 'owner' };
const prefix = `finance-${randomUUID()}`;
const visits: string[] = [randomUUID(), randomUUID(), randomUUID()];
const records = [prefix+'expense', prefix+'unpaid', prefix+'material-expense', prefix+'payroll'];
let createdSettings = false;
const period = { dateFrom: '2091-02-01', dateTo: '2091-02-01' };

describe('financial accounting periods', () => {
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL ?? '').pathname !== '/salonit_test') throw new Error('Requires salonit_test');
    createdSettings = (await rows("INSERT INTO records(id,kind,data) VALUES ('salon-settings','settings',$1) ON CONFLICT DO NOTHING RETURNING id", [JSON.stringify(settings)])).length > 0;
    const times = ['2091-01-31T20:59:59Z', '2091-01-31T21:00:00Z', '2091-02-01T21:00:00Z'];
    for (const [i,id] of visits.entries()) {
      await rows("INSERT INTO appointments(id,reference,status,start_at,end_at,closed_at,items,total_minor,paid_minor) VALUES ($1,$2,'completed',$3::timestamptz,$3::timestamptz+interval '1 hour',$3,'[]',10000,10000)", [id,prefix+i,times[i]]);
      await rows("INSERT INTO payments(id,visit_id,method,amount_minor,kind,created_at) VALUES ($1,$2,'cash',10000,'payment',$3)",[randomUUID(),id,times[i]]);
    }
    // A later refund belongs to its own day, even when the original visit closed earlier.
    await rows("INSERT INTO payments(id,visit_id,method,amount_minor,kind,created_at) VALUES ($1,$2,'cash',2000,'refund','2091-01-31T22:00:00Z')",[randomUUID(),visits[0]]);
    await rows("INSERT INTO consumptions(id,visit_id,material_id,quantity_milli,cost_minor,created_at) VALUES ($1,$2,$3,1000,700,'2091-01-31T21:00:00Z')",[randomUUID(),visits[1],prefix]);
    await rows("INSERT INTO accruals(id,visit_id,staff_id,service_name,base_minor,amount_minor,rate_bps,date) VALUES ($1,$2,$3,'Service',10000,3000,3000,'2091-02-01')",[randomUUID(),visits[1],prefix]);
    for (const [i, amount, paid, category] of [[0,500,true,'Прочее'],[1,300,false,'Прочее'],[2,900,true,'Материалы']] as const) {
      await rows("INSERT INTO records(id,kind,data) VALUES ($1,'expense',$2)",[records[i],JSON.stringify({name:prefix,date:'2091-02-01',amountMinor:amount,paid,category})]);
    }
    await rows("INSERT INTO records(id,kind,data) VALUES ($1,'payroll',$2)",[records[3],JSON.stringify({month:'2091-02',status:'approved',snapshot:[{staffId:prefix,amountMinor:4000,variableMinor:3000}]})]);
    await rows("INSERT INTO payouts(id,month,staff_id,amount_minor,created_at) VALUES ($1,'2091-01',$2,400,'2091-01-31T21:00:00Z')",[randomUUID(),prefix]);
  });
  afterAll(async () => {
    await rows('DELETE FROM payments WHERE visit_id=ANY($1::uuid[])',[visits]);
    await rows('DELETE FROM consumptions WHERE visit_id=ANY($1::uuid[])',[visits]);
    await rows('DELETE FROM accruals WHERE visit_id=ANY($1::uuid[])',[visits]);
    await rows('DELETE FROM appointments WHERE id=ANY($1::uuid[])',[visits]);
    await rows('DELETE FROM payouts WHERE staff_id=$1',[prefix]);
    await rows('DELETE FROM records WHERE id=ANY($1::text[])',[records]);
    if (createdSettings) await rows("DELETE FROM records WHERE id='salon-settings'");
    await pool.end();
  });
  it('uses inclusive Moscow days, event-date refunds, and separates cash flow from profit', async () => {
    const result = await getWorkspace(owner,period);
    expect(result.metrics).toMatchObject({ completed:1,revenueMinor:8000,cashMinor:8000,expensesMinor:800,materialsMinor:700,payrollMinor:3000,resultMinor:3500,cashOutflowMinor:1800,cashFlowMinor:6200 });
    expect(result.visits.filter(v=>visits.includes(v.id))).toHaveLength(3);
    expect(result.expenses.filter(v=>records.includes(v.id))).toHaveLength(3);
  });
  it('places monthly top-ups on month end and retains inclusive end date', async () => {
    const result = await getWorkspace(owner,{dateFrom:'2091-02-28',dateTo:'2091-02-28'});
    expect(result.metrics).toMatchObject({completed:0,payrollMinor:1000,resultMinor:-1000,cashFlowMinor:0});
  });
  it('rejects invalid days and reversed periods', () => {
    for(const value of ['2091-02-29','2091-02-31','bad','']) expect(()=>validateFinancePeriod({dateFrom:value})).toThrow();
    expect(()=>validateFinancePeriod({dateFrom:'2091-03-01',dateTo:'2091-02-28'})).toThrow();
  });
  it('does not grant financial period access to admin or client', async () => {
    for (const role of ['admin','client'] as const) await expect(getWorkspace({...owner,role},period)).rejects.toThrow();
  });
});

