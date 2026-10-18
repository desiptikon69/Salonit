import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, rows } from "../../src/server/db";
import { saveRecord } from "../../src/server/records";
import { confirmBookingHold, createBookingHold, runBookingCommand } from "../../src/server/booking";
import type { Actor, Resource, Service, Staff, Visit, VisitItem } from "../../src/lib/contracts";

const owner: Actor = { id: "addition-owner", role: "owner", name: "Owner" };
const client: Actor = { id: "addition-client", role: "client", name: "Client" };
const phone = "+79000007777";
const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const time = (hour: number, minute = 0) => `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+03:00`;
const service: Service = { id: "addition-service", name: "Hair", description: "", category: "Волосы", durationMinutes: 60, bufferMinutes: 10, priceMinor: 200000, skill: "hair", resourceType: "chair", active: true, norms: [{ materialId: "shampoo", quantityMilli: 12000 }] };
const staff: Staff = { id: "addition-staff", name: "Staff", title: "", initials: "AS", color: "green", skills: ["hair"], commissionBps: 4000, fixedMinor: 0, guaranteeMinor: 0, guaranteeScope: "total", active: true, workStart: "09:00", workEnd: "21:00" };
const resource: Resource = { id: "addition-chair", name: "Chair", type: "chair", ready: true, status: "ready" };
const payload = (visit: Visit) => ({ id: visit.id, version: visit.version, serviceId: service.id, reason: "Additional treatment requested" });
async function original() {
  const hold = await createBookingHold({ serviceIds: [service.id], mode: "sequential", startAt: time(10), name: "Guest", phone });
  const visit = await confirmBookingHold({ ...hold, phone }, client);
  // Financial closing has not happened; individual execution and cancellations are history.
  const items: VisitItem[] = [...visit.items.map(item => ({ ...item, status: "completed" })), { ...visit.items[0], id: randomUUID(), serviceId: "cancelled-service", status: "cancelled", cancellationReason: "Changed plans" }];
  await rows("UPDATE appointments SET status='completed',items=$2 WHERE id=$1", [visit.id, JSON.stringify(items)]);
  return { ...visit, status: "completed" as const, items };
}

describe("add services to an existing open visit", () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL?.includes("salonit_test")) throw new Error("Use isolated salonit_test database");
    await rows("TRUNCATE records,appointments,payments,consumptions,accruals,payouts,audit_events,outbox,commands CASCADE");
    await rows('DELETE FROM auth."user" WHERE id=$1', [client.id]);
    await rows('INSERT INTO auth."user"(id,name,email,phone_number,phone_number_verified,role) VALUES($1,\'Client\',\'addition@example.invalid\',$2,true,\'client\')', [client.id, phone]);
    await saveRecord("service", service.id, service);
    await saveRecord("staff", staff.id, staff);
    await saveRecord("resource", resource.id, resource);
  });
  afterAll(async () => { await pool.end(); });

  it("appends after the reserved buffer, snapshots current terms, and preserves completed/cancelled history", async () => {
    const visit = await original();
    await saveRecord("service", service.id, { ...service, name: "New treatment", priceMinor: 350000, norms: [{ materialId: "color", quantityMilli: 42000 }] });
    await saveRecord("staff", staff.id, { ...staff, commissionBps: 5000 });
    const result = await runBookingCommand(owner, "visit.addService", payload(visit), randomUUID());
    expect(result.items.slice(0, 2)).toEqual(visit.items);
    expect(result.items[2]).toMatchObject({ serviceName: "New treatment", startAt: new Date(time(11, 10)).toISOString(), priceMinor: 350000, commissionBps: 5000, norms: [{ materialId: "color", quantityMilli: 42000 }], status: "planned" });
    expect(result).toMatchObject({ totalMinor: 550000, paidMinor: 0, status: "arrived", version: visit.version + 1 });
    expect(await rows("SELECT * FROM allocations WHERE appointment_id=$1 AND active", [visit.id])).toHaveLength(5);
    expect(await rows("SELECT * FROM payments")).toHaveLength(0);
    expect(await rows("SELECT * FROM audit_events WHERE action='visit.addService'")).toHaveLength(1);
  });
  it("replays safely and permits exactly one concurrent append against the same version", async () => {
    const visit = await original(), commandId = randomUUID(), input = payload(visit);
    const result = await runBookingCommand(owner, "visit.addService", input, commandId);
    expect(await runBookingCommand(owner, "visit.addService", input, commandId)).toEqual(result);
    await expect(runBookingCommand({ ...owner, id: "another-owner" }, "visit.addService", input, commandId)).rejects.toThrow(/Ключ/);
    await expect(runBookingCommand(owner, "visit.addService", input, randomUUID())).rejects.toThrow(/изменён/);
    const next = { ...input, version: result.version };
    const simultaneous = await Promise.allSettled([runBookingCommand(owner, "visit.addService", next, randomUUID()), runBookingCommand(owner, "visit.addService", next, randomUUID())]);
    expect(simultaneous.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT * FROM audit_events WHERE action='visit.addService'")).toHaveLength(2);
  });
  it("rolls back resource conflicts without altering the original items, amount, or reservations", async () => {
    const visit = await original();
    await createBookingHold({ serviceIds: [service.id], mode: "sequential", startAt: time(11, 10), name: "Other guest", phone: "+79000007778" });
    const before = await rows("SELECT * FROM allocations WHERE appointment_id=$1 ORDER BY id", [visit.id]);
    await expect(runBookingCommand(owner, "visit.addService", payload(visit), randomUUID())).rejects.toThrow(/мастера/);
    const stored = (await rows<{ items: VisitItem[]; total_minor: string; version: number }>("SELECT items,total_minor,version FROM appointments WHERE id=$1", [visit.id]))[0];
    expect(stored).toEqual({ items: visit.items, total_minor: String(visit.totalMinor), version: visit.version });
    expect(await rows("SELECT * FROM allocations WHERE appointment_id=$1 ORDER BY id", [visit.id])).toEqual(before);
    expect(await rows("SELECT * FROM audit_events WHERE action='visit.addService'")).toHaveLength(0);
  });
  it("rejects client overlap even when a different master and chair are available", async () => {
    const visit = await original();
    await saveRecord("staff", "addition-second-staff", { ...staff, id: "addition-second-staff" });
    await saveRecord("resource", "addition-second-chair", { ...resource, id: "addition-second-chair" });
    const hold = await createBookingHold({ serviceIds: [service.id], mode: "sequential", startAt: time(12), name: "Guest", phone });
    await confirmBookingHold({ ...hold, phone }, client);
    await expect(runBookingCommand(owner, "visit.addService", payload(visit), randomUUID())).rejects.toThrow(/визитом клиента/);
  });
  it("requires an administrator, reason, current version, and an open same-day sequential visit", async () => {
    const visit = await original(), input = payload(visit);
    for (const role of ["master", "stock", "accountant", "client", "operator"] as const) await expect(runBookingCommand({ ...owner, role }, "visit.addService", input, randomUUID())).rejects.toThrow();
    await expect(runBookingCommand(owner, "visit.addService", { ...input, reason: "" }, randomUUID())).rejects.toThrow();
    await expect(runBookingCommand(owner, "visit.addService", { ...input, startAt: time(10, 30) }, randomUUID())).rejects.toThrow(/после текущих/);
    await rows("UPDATE appointments SET closed_at=now() WHERE id=$1", [visit.id]);
    await expect(runBookingCommand(owner, "visit.addService", input, randomUUID())).rejects.toThrow(/открытый/);
  });
});
