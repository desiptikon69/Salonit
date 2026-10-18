import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../src/lib/contracts";
import { pool, rows } from "../../src/server/db";
import { listFinancialCorrections, runFinancialCorrection } from "../../src/server/financial-corrections";

const owner: Actor = { id: "correction-owner", name: "Владелец", role: "owner" };
const accountant: Actor = { id: "correction-accountant", name: "Бухгалтер", role: "accountant" };
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
const call = (action: string, payload: unknown, actor = owner, commandId = randomUUID()) => runFinancialCorrection(actor, `finance.correction.${action}`, payload, commandId);
let visitId: string;
let accrualId: string;
const create = (target = "revenue", deltaMinor = -5000) => call("create", { sourceVisitId: visitId, ...(target === "payroll" ? { sourceAccrualId: accrualId } : {}), target, deltaMinor, postingDate: today(), reason: "Исправление по акту сверки" });

describe("append-only financial corrections", () => {
  beforeEach(async () => {
    if (new URL(process.env.DATABASE_URL ?? "").pathname !== "/salonit_test") throw new Error("Dedicated salonit_test database required");
    await rows("TRUNCATE appointments,records,payments,consumptions,accruals,payouts,audit_events,outbox,commands CASCADE");
    visitId = randomUUID(); accrualId = randomUUID();
    await rows("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor,paid_minor,closed_at) VALUES($1,'CORR-SOURCE','client','completed','2025-01-10T09:00:00Z','2025-01-10T10:00:00Z','[]',100000,100000,'2025-01-10T10:05:00Z')", [visitId]);
    await rows("INSERT INTO accruals(id,visit_id,staff_id,service_name,base_minor,amount_minor,rate_bps,status,date) VALUES($1,$2,'staff','Услуга',100000,40000,4000,'paid','2025-01-10')", [accrualId, visitId]);
    await rows("INSERT INTO records(id,kind,data) VALUES('staff','staff','{\"name\":\"Мастер\"}')");
  });
  afterAll(() => pool.end());

  it("keeps closed facts and accruals unchanged while recording a signed adjustment", async () => {
    const before = await rows("SELECT * FROM appointments"); const accruals = await rows("SELECT * FROM accruals");
    const draft = await create();
    expect(draft).toMatchObject({ sourceReference: "CORR-SOURCE", sourcePeriod: "2025-01", deltaMinor: -5000, status: "draft", version: 1 });
    await call("approve", { id: draft.id, version: 1 }, accountant);
    expect(await rows("SELECT * FROM appointments")).toEqual(before);
    expect(await rows("SELECT * FROM accruals")).toEqual(accruals);
    expect((await listFinancialCorrections())[0]).toMatchObject({ status: "approved", version: 2, approvedBy: accountant.name });
    expect((await rows<{ data: { status?: string } }>("SELECT data FROM records WHERE kind='financial_adjustment'"))[0].data.status).toBeUndefined();
    expect(await rows("SELECT * FROM payments")).toHaveLength(0);
  });

  it("requires a closed source and a matching accrual for payroll", async () => {
    await expect(call("create", { sourceVisitId: visitId, target: "payroll", deltaMinor: 100, postingDate: today(), reason: "Исправление" })).rejects.toThrow();
    await rows("UPDATE appointments SET closed_at=NULL WHERE id=$1", [visitId]);
    await expect(create()).rejects.toThrow();
  });

  it("does not let operational roles create, approve or pay a correction", async () => {
    const draft = await create("payroll", 5000);
    for (const role of ["admin", "master", "stock", "client", "operator"] as const) {
      const actor: Actor = { id: role, name: role, role };
      await expect(call("create", { sourceVisitId: visitId, target: "expenses", deltaMinor: 100, postingDate: today(), reason: "Исправление" }, actor)).rejects.toThrow();
      await expect(call("approve", { id: draft.id, version: 1 }, actor)).rejects.toThrow();
      await expect(call("payout", { id: draft.id, version: 2, method: "card", externalReference: "Банк №1" }, actor)).rejects.toThrow();
    }
  });

  it("recognizes negative payroll corrections without automatic withholding", async () => {
    const draft = await create("payroll", -5000);
    const approved = await call("approve", { id: draft.id, version: 1 });
    expect(approved).toMatchObject({ settlement: "offset_review", status: "approved", staffId: "staff" });
    await expect(call("payout", { id: draft.id, version: 2, method: "card", externalReference: "Банк №2" })).rejects.toThrow();
    expect(await rows("SELECT * FROM payments")).toHaveLength(0);
    expect(Number((await rows<{ amount_minor: string }>("SELECT amount_minor FROM accruals"))[0].amount_minor)).toBe(40000);
  });

  it("pays an approved positive payroll correction exactly once under concurrent new keys", async () => {
    const draft = await create("payroll", 5000);
    await expect(call("payout", { id: draft.id, version: 1, method: "sbp", externalReference: "Банк №3" })).rejects.toThrow();
    await call("approve", { id: draft.id, version: 1 });
    const payload = { id: draft.id, version: 2, method: "sbp", externalReference: "Банк №3" };
    const results = await Promise.allSettled([call("payout", payload), call("payout", payload)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT * FROM payments WHERE kind='adjustment_payout' AND visit_id IS NULL AND amount_minor=5000")).toHaveLength(1);
    expect((await listFinancialCorrections())[0]).toMatchObject({ status: "paid", version: 3, externalReference: "Банк №3" });
  });

  it("replays an identical command but rejects payload reuse and stale versions", async () => {
    const draft = await create(); const commandId = randomUUID(); const payload = { id: draft.id, version: 1 };
    const result = await call("approve", payload, owner, commandId);
    expect(await call("approve", payload, owner, commandId)).toEqual(result);
    await expect(call("approve", { ...payload, version: 2 }, owner, commandId)).rejects.toThrow();
    await expect(call("approve", payload)).rejects.toThrow();
    expect(await rows("SELECT * FROM records WHERE kind='financial_adjustment_approval'")).toHaveLength(1);
  });

  it("rejects zero amounts, impossible dates and paid posting periods", async () => {
    await expect(create("materials", 0)).rejects.toThrow();
    await expect(call("create", { sourceVisitId: visitId, target: "materials", deltaMinor: 100, postingDate: "2026-02-31", reason: "Исправление" })).rejects.toThrow();
    await rows("INSERT INTO records(id,kind,data) VALUES('locked-period','payroll',$1)", [JSON.stringify({ month: today().slice(0, 7), status: "paid" })]);
    await expect(create()).rejects.toThrow();
  });

  it("blocks approval if the posting period was locked after drafting", async () => {
    const draft = await create("expenses", 5000);
    await rows("INSERT INTO records(id,kind,data) VALUES('locked-period','payroll',$1)", [JSON.stringify({ month: today().slice(0, 7), status: "locked" })]);
    await expect(call("approve", { id: draft.id, version: 1 })).rejects.toThrow();
    expect(await rows("SELECT * FROM records WHERE kind='financial_adjustment_approval'")).toHaveLength(0);
  });
});
