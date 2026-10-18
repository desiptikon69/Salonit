import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor, Resource, VisitItem } from "../../src/lib/contracts";
import { pool, rows } from "../../src/server/db";
import { runOperation } from "../../src/server/operations";

const owner: Actor = { id: "cycle-owner", name: "Owner", role: "owner" };
const stock: Actor = { id: "cycle-stock", name: "Stock", role: "stock" };
const command = (action: string, payload: unknown, actor = stock, commandId = randomUUID()) => runOperation(actor, action, payload, commandId);
const tool: Resource = { id: "cycle-tool", name: "Набор маникюра", type: "tools-hands", status: "dirty", ready: false };
const current = async () => (await rows<{ data: Resource }>("SELECT data FROM records WHERE id=$1", [tool.id]))[0].data;

describe("instrument processing lifecycle", () => {
  beforeEach(async () => {
    if (new URL(process.env.DATABASE_URL ?? "").pathname !== "/salonit_test") throw new Error("Use isolated salonit_test database");
    await rows("TRUNCATE appointments, records, payments, consumptions, accruals, payouts, audit_events, outbox, commands, import_runs CASCADE");
    await rows("INSERT INTO records(id,kind,data) VALUES($1,'resource',$2)", [tool.id, JSON.stringify(tool)]);
    await rows("INSERT INTO records(id,kind,data) VALUES('staff','staff',$1)", [JSON.stringify({ name: "Master", commissionBps: 4000, fixedMinor: 0, guaranteeMinor: 0, guaranteeScope: "total", active: true })]);
  });
  afterAll(() => pool.end());

  it("requires each processing stage and successful control before becoming available", async () => {
    await expect(command("resource.process", { id: tool.id, event: "control_pass" })).rejects.toThrow();
    for (const [event, status] of [["start", "cleaning"], ["cleaned", "sterilizing"], ["sterilized", "control"], ["control_pass", "ready"]]) {
      await command("resource.process", { id: tool.id, event });
      expect(await current()).toMatchObject({ status, ready: status === "ready" });
    }
    const log = await rows<{ data: { resourceId: string; event: string; actorId: string } }>("SELECT data FROM records WHERE kind='resource_cycle' ORDER BY created_at,id");
    expect(log).toHaveLength(4);
    expect(log.at(-1)?.data).toMatchObject({ resourceId: tool.id, event: "control_pass", actorId: stock.id });
  });

  it("failed control requires an entire new cycle and retries do not duplicate journal events", async () => {
    for (const event of ["start", "cleaned", "sterilized", "control_fail"]) await command("resource.process", { id: tool.id, event });
    expect(await current()).toMatchObject({ status: "dirty", ready: false });
    await expect(command("resource.process", { id: tool.id, event: "control_pass" })).rejects.toThrow();
    const key = randomUUID();
    const payload = { id: tool.id, event: "start" };
    expect(await command("resource.process", payload, stock, key)).toEqual(await command("resource.process", payload, stock, key));
    expect(await rows("SELECT id FROM records WHERE kind='resource_cycle'")).toHaveLength(5);
  });

  it("prevents editing readiness or resource type to bypass control, including new tools", async () => {
    await expect(command("resource.save", { ...tool, ready: true, status: "ready" }, owner)).rejects.toThrow();
    await expect(command("resource.save", { ...tool, type: "nail-chair", ready: true, status: "ready" }, owner)).rejects.toThrow();
    await expect(command("resource.save", { name: "New tool", type: "tools-feet", ready: true, status: "ready" }, owner)).rejects.toThrow();
    await command("resource.save", { ...tool, name: "Renamed" }, owner);
    expect(await current()).toMatchObject({ name: "Renamed", status: "dirty", ready: false });
    await expect(command("resource.process", { id: tool.id, event: "start" }, { id: "master", name: "Master", role: "master" })).rejects.toThrow();
  });

  it("marks the used instrument dirty when the service is completed", async () => {
    await rows("UPDATE records SET data=jsonb_set(jsonb_set(data,'{status}','\"ready\"'),'{ready}','true') WHERE id=$1", [tool.id]);
    const visitId = randomUUID();
    const item: VisitItem = { id: "item", serviceId: "manicure", serviceName: "Manicure", staffId: "staff", staffName: "Master", startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-12T10:00:00Z", priceMinor: 10000, commissionBps: 4000, norms: [], status: "in_progress", reservations: [{ resourceKey: "resource:" + tool.id, startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-12T10:00:00Z" }] };
    await rows("INSERT INTO appointments(id,reference,status,start_at,end_at,items,total_minor) VALUES($1,'CYCLE','in_progress',$2,$3,$4,10000)", [visitId, item.startAt, item.endAt, JSON.stringify([item])]);
    await command("visit.status", { id: visitId, version: 1, status: "completed" }, owner);
    expect(await current()).toMatchObject({ status: "dirty", ready: false });
    expect(await rows("SELECT id FROM records WHERE kind='resource_cycle'")).toHaveLength(1);
  });

  it("does not start a service using a dirty instrument or process one still in use", async () => {
    const visitId = randomUUID();
    const item: VisitItem = { id: "item", serviceId: "manicure", serviceName: "Manicure", staffId: "staff", staffName: "Master", startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-12T10:00:00Z", priceMinor: 10000, commissionBps: 4000, norms: [], status: "arrived", reservations: [{ resourceKey: "resource:" + tool.id, startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-12T10:00:00Z" }] };
    await rows("INSERT INTO appointments(id,reference,status,start_at,end_at,items,total_minor) VALUES($1,'USING','arrived',$2,$3,$4,10000)", [visitId, item.startAt, item.endAt, JSON.stringify([item])]);
    await rows("INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at) VALUES($1,$2,$3,$4,$5)", [randomUUID(), visitId, "resource:" + tool.id, item.startAt, item.endAt]);
    await expect(command("visit.status", { id: visitId, version: 1, status: "in_progress" }, owner)).rejects.toThrow("обработку и контроль");
    for (const event of ["start", "cleaned", "sterilized", "control_pass"]) await command("resource.process", { id: tool.id, event });
    await command("visit.status", { id: visitId, version: 1, status: "in_progress" }, owner);
    await expect(command("resource.process", { id: tool.id, event: "start" })).rejects.toThrow("незавершённой услуге");
  });

  it("preserves previously completed work when a master starts an added service", async () => {
    const visitId = randomUUID();
    const item: VisitItem = { id: "original", serviceId: "hair", serviceName: "Hair", staffId: "staff", staffName: "Master", startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-12T10:00:00Z", priceMinor: 10000, commissionBps: 4000, norms: [], status: "completed", reservations: [] };
    await rows("INSERT INTO appointments(id,reference,status,start_at,end_at,items,total_minor) VALUES($1,'ADDED','arrived',$2,$3,$4,20000)", [visitId, item.startAt, item.endAt, JSON.stringify([item, { ...item, id: "added", status: "arrived" }])]);
    const master: Actor = { id: "master", name: "Master", role: "master", staffId: "staff" };
    await command("visit.status", { id: visitId, version: 1, status: "in_progress" }, master);
    const items = (await rows<{ items: VisitItem[] }>("SELECT items FROM appointments WHERE id=$1", [visitId]))[0].items;
    expect(items.map(i => i.status)).toEqual(["completed", "in_progress"]);
  });
});
