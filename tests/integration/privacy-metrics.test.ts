import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pool, rows } from "../../src/server/db";
import { saveRecord } from "../../src/server/records";
import { runOperation } from "../../src/server/operations";
import { confirmBookingHold, createBookingHold, runBookingCommand } from "../../src/server/booking";
import { getWorkspace } from "../../src/server/queries";
import type { Actor, Client, Visit } from "../../src/lib/contracts";

const prefix = `privacy-${randomUUID()}`;
const actor: Actor = { id: prefix, name: "Client", role: "client", clientId: `${prefix}-client` };
const owner: Actor = { id: `${prefix}-owner`, name: "Owner", role: "owner" };
const phone = "+79011112233";
const visitIds: string[] = [];
let insertedSettings = false;
const date = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
const time = (hour: number) => `${date}T${hour}:00:00+03:00`;
function expectPublicVisit(visit: Visit) {
  expect(visit.note).toBe("");
  expect(visit.materials).toEqual([]);
  expect(visit.items[0].norms).toEqual([]);
  expect(visit.items[0].commissionBps).toBe(0);
}
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("salonit_test")) throw new Error("Use isolated salonit_test database");
  await saveRecord("client", actor.clientId!, { name: "Client", phone, email: "", notes: "Internal private note", accountId: actor.id, marketingConsent: false, createdAt: new Date().toISOString() });
  await rows('INSERT INTO auth."user"(id,name,email,phone_number,phone_number_verified,role,client_id) VALUES($1,\'Client\',$2,$3,true,\'client\',$4)', [actor.id, `${prefix}@example.invalid`, phone, actor.clientId]);
  const inserted = await rows("INSERT INTO records(id,kind,data) VALUES('salon-settings','settings',$1) ON CONFLICT DO NOTHING RETURNING id", [JSON.stringify({ name: "Test", timezone: "Europe/Moscow", currency: "RUB", mode: "demo" })]);
  insertedSettings = inserted.length > 0;
});
afterAll(async () => {
  await rows("DELETE FROM payments WHERE visit_id=ANY($1::uuid[])", [visitIds]);
  await rows("DELETE FROM appointments WHERE id=ANY($1::uuid[])", [visitIds]);
  await rows("DELETE FROM records WHERE id LIKE $1", [`${prefix}%`]);
  await rows("DELETE FROM commands WHERE actor_id=$1", [actor.id]);
  await rows("DELETE FROM audit_events WHERE entity_id=ANY($1::text[])", [[...visitIds, actor.clientId!]]);
  await rows("DELETE FROM outbox WHERE payload->>'visitId'=ANY($1::text[]) OR payload->>'actorId'=$2", [visitIds, actor.id]);
  await rows('DELETE FROM auth."user" WHERE id=$1', [actor.id]);
  if (insertedSettings) await rows("DELETE FROM records WHERE id='salon-settings'");
  await pool.end();
});

it("profile save and stored-command replay hide notes and account links while retaining them in storage", async () => {
  const commandId = randomUUID();
  const payload = { id: actor.clientId, name: "Updated Client", phone, email: "", notes: "Overwrite attempt", marketingConsent: true };
  const result = await runOperation(actor, "client.save", payload, commandId) as Client;
  expect(result.notes).toBe("");
  expect(result).not.toHaveProperty("accountId");
  expect(await runOperation(actor, "client.save", payload, commandId)).toEqual(result);
  const [stored] = await rows<{ data: Client }>("SELECT data FROM records WHERE id=$1", [actor.clientId]);
  expect(stored.data.notes).toBe("Internal private note");
  expect(stored.data.accountId).toBe(actor.id);
});

it("confirmation, movement and their replays use the same private-field filter", async () => {
  const serviceId = `${prefix}-service`, staffId = `${prefix}-staff`;
  await saveRecord("service", serviceId, { name: "Hair", category: "Волосы", durationMinutes: 60, bufferMinutes: 0, priceMinor: 200000, skill: prefix, resourceType: prefix, active: true, norms: [{ materialId: `${prefix}-material`, quantityMilli: 1000 }] });
  await saveRecord("staff", staffId, { name: "Staff", skills: [prefix], active: true, commissionBps: 4000, workStart: "09:00", workEnd: "21:00" });
  await saveRecord("resource", `${prefix}-chair`, { name: "Chair", type: prefix, ready: true, status: "ready" });
  const hold = await createBookingHold({ serviceIds: [serviceId], staffId, mode: "sequential", startAt: time(10), name: actor.name, phone });
  visitIds.push(hold.holdId);
  await rows("UPDATE appointments SET note='Private service note',materials=$2 WHERE id=$1", [hold.holdId, JSON.stringify([{ materialId: `${prefix}-material`, quantityMilli: 800 }])]);
  const confirmation = { ...hold, phone };
  const visit = await confirmBookingHold(confirmation, actor);
  expectPublicVisit(visit);
  expectPublicVisit(await confirmBookingHold(confirmation, actor));
  const payload = { id: visit.id, version: visit.version, startAt: time(12) }, commandId = randomUUID();
  expectPublicVisit(await runBookingCommand(actor, "visit.move", payload, commandId));
  expectPublicVisit(await runBookingCommand(actor, "visit.move", payload, commandId));
  const [stored] = await rows<{ note: string; items: Visit["items"] }>("SELECT note,items FROM appointments WHERE id=$1", [visit.id]);
  expect(stored.note).toBe("Private service note");
  expect(stored.items[0].commissionBps).toBe(4000);
});

it("recognises the full package liability release above the current service price and subtracts refunds", async () => {
  const baseline = (await getWorkspace(owner)).metrics.revenueMinor;
  const id = randomUUID(); visitIds.push(id);
  await rows("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,total_minor,paid_minor,closed_at) VALUES($1,$2,$3,'completed',now(),now()+interval '1 hour',10000,10000,now())", [id, `${prefix}-revenue`, actor.clientId]);
  await rows("INSERT INTO payments(id,visit_id,method,amount_minor,kind) VALUES($1,$2,'certificate',15000,'payment'),($3,$2,'refund',2000,'refund')", [randomUUID(), id, randomUUID()]);
  expect((await getWorkspace(owner)).metrics.revenueMinor - baseline).toBe(13000);
});
