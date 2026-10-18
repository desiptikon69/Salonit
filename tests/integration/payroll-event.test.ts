import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, Staff, VisitItem } from "../../src/lib/contracts";
import { pool, rows } from "../../src/server/db";
import { runOperation } from "../../src/server/operations";

const owner: Actor = { id: "payroll-owner", name: "Owner", role: "owner" };
const command = (action: string, payload: unknown) => runOperation(owner, action, payload, randomUUID());
const staff: Staff = { id: "event-staff", name: "Master", title: "Master", initials: "M", color: "green", skills: ["hair"], active: true, workStart: "09:00", workEnd: "21:00", commissionBps: 4000, fixedMinor: 100000, guaranteeMinor: 0, guaranteeScope: "total" };
const item: VisitItem = { id: "event-item", serviceId: "hair", serviceName: "Hair", staffId: staff.id, staffName: staff.name, startAt: "2031-04-30T09:00:00Z", endAt: "2031-04-30T10:00:00Z", priceMinor: 100000, commissionBps: 3000, norms: [], status: "in_progress" };
let visitId: string;
const rule = (effectiveFrom: string, changes = {}) => command("payroll.rule.create", { staffId: staff.id, effectiveFrom, commissionBps: 6000, fixedMinor: staff.fixedMinor, guaranteeMinor: 0, guaranteeScope: "total", reason: "New agreement", ...changes });
const complete = () => command("visit.status", { id: visitId, version: 1, status: "completed" });
const close = () => command("visit.close", { id: visitId, version: 2, payments: [] });

describe("payroll recognition at actual service completion", () => {
  beforeEach(async () => {
    if (new URL(process.env.DATABASE_URL ?? "").pathname !== "/salonit_test") throw new Error("Use isolated salonit_test database");
    await rows("TRUNCATE appointments, records, payments, consumptions, accruals, payouts, audit_events, outbox, commands, import_runs CASCADE");
    await rows("INSERT INTO records(id,kind,data) VALUES($1,'staff',$2)", [staff.id, JSON.stringify(staff)]);
    visitId = randomUUID();
    await rows("INSERT INTO appointments(id,reference,status,start_at,end_at,items,total_minor) VALUES($1,'EVENT','in_progress',$2,$3,$4,100000)", [visitId, item.startAt, item.endAt, JSON.stringify([item])]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-01T21:15:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  afterAll(() => pool.end());

  it("freezes the rule on completion, independently of booking and closing dates", async () => {
    const selected = await rule("2031-05-01");
    await complete();
    const completed = (await rows<{ items: VisitItem[] }>("SELECT items FROM appointments WHERE id=$1", [visitId]))[0].items[0];
    expect(completed).toMatchObject({ completedAt: "2031-05-01T21:15:00.000Z", rewardRuleId: (selected as { id: string }).id, commissionBps: 3000, rewardRuleSnapshot: { commissionBps: 6000 } });
    await rule("2031-05-03", { commissionBps: 9000 });
    vi.setSystemTime(new Date("2031-05-04T10:00:00Z"));
    await close();
    expect((await rows<{ amount_minor: string; rate_bps: number; event_date: string; item_id: string }>("SELECT amount_minor,rate_bps,to_char(date,'YYYY-MM-DD') AS event_date,item_id FROM accruals"))[0]).toEqual({ amount_minor: "60000", rate_bps: 6000, event_date: "2031-05-02", item_id: item.id });
  });

  it("checks paid actual month rather than the planned appointment month", async () => {
    await rule("2031-05-01");
    await rows("INSERT INTO payouts(id,month,staff_id,amount_minor) VALUES($1,'2031-04',$2,100000)", [randomUUID(), staff.id]);
    await complete();
    await close();
    expect(await rows("SELECT id FROM accruals")).toHaveLength(1);
  });

  it("never inserts late accruals into an already paid completion month", async () => {
    await rule("2031-05-01");
    await complete();
    await rows("INSERT INTO payouts(id,month,staff_id,amount_minor) VALUES($1,'2031-05',$2,100000)", [randomUUID(), staff.id]);
    await expect(close()).rejects.toThrow("Период");
    expect(await rows("SELECT id FROM accruals")).toHaveLength(0);
    expect((await rows<{ closed_at: unknown }>("SELECT closed_at FROM appointments"))[0].closed_at).toBeNull();
  });

  it("keeps legacy completed booking terms without silently applying a new rule", async () => {
    await rule("2031-05-01");
    await rows("UPDATE appointments SET status='completed',items=$2 WHERE id=$1", [visitId, JSON.stringify([{ ...item, status: "completed" }])]);
    await command("visit.close", { id: visitId, version: 1, payments: [] });
    expect((await rows<{ amount_minor: string; rate_bps: number; event_date: string; rule_snapshot: { legacy: boolean } }>("SELECT amount_minor,rate_bps,to_char(date,'YYYY-MM-DD') AS event_date,rule_snapshot FROM accruals"))[0]).toMatchObject({ amount_minor: "30000", rate_bps: 3000, event_date: "2031-04-30", rule_snapshot: { legacy: true } });
  });

  it("uses month-start fixed terms for approval and prevents direct staff repricing", async () => {
    await rule("2031-06-01", { fixedMinor: 200000 });
    await command("payroll.approve", { month: "2031-06" });
    const payroll = (await rows<{ data: { snapshot: { amountMinor: number; fixedMinor: number; ruleId: string }[] } }>("SELECT data FROM records WHERE kind='payroll'"))[0].data;
    expect(payroll.snapshot[0]).toMatchObject({ amountMinor: 200000, fixedMinor: 200000 });
    expect(payroll.snapshot[0].ruleId).toBeTruthy();
    await expect(command("staff.save", { ...staff, commissionBps: 8000 })).rejects.toThrow("правил");
    expect((await rows<{ data: Staff }>("SELECT data FROM records WHERE id=$1", [staff.id]))[0].data.commissionBps).toBe(4000);
  });
});
