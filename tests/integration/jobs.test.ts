import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it } from "vitest";
import { pool, rows } from "../../src/server/db";
import { maintainTemporaryData, processOutbox } from "../../src/server/jobs";

let visitId: string;
const enqueue = (kind: string, version = 1, dueAt = new Date(0).toISOString()) => rows("INSERT INTO outbox(id,kind,payload) VALUES($1,$2,$3)", [randomUUID(), kind, JSON.stringify({ visitId, version, dueAt })]);
beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes("salonit_test")) throw new Error("Use isolated salonit_test database");
  process.env.APP_MODE = "demo";
  await rows("TRUNCATE appointments,records,outbox,demo_otp,request_limits CASCADE");
  visitId = randomUUID();
  await rows("INSERT INTO records(id,kind,data) VALUES('jobs-client','client','{\"name\":\"Demo\",\"phone\":\"+79000000000\"}')");
  await rows("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,total_minor) VALUES($1,'JOBS','jobs-client','confirmed',now()+interval '3 days',now()+interval '3 days 1 hour',10000)", [visitId]);
});
afterAll(async () => { await pool.end(); });

it("claims events exactly once across concurrent workers and schedules a future reminder", async () => {
  await enqueue("booking.confirmed");
  await Promise.all([processOutbox(), processOutbox()]);
  expect((await rows("SELECT * FROM records WHERE kind='notification'")).length).toBe(1);
  expect((await rows("SELECT * FROM outbox WHERE kind='visit.reminder' AND status='pending'")).length).toBe(1);
  expect(await processOutbox()).toBe(0);
});

it("suppresses cancelled and moved reminders instead of using stale data", async () => {
  await enqueue("visit.reminder");
  await rows("UPDATE appointments SET version=2 WHERE id=$1", [visitId]);
  await processOutbox();
  await enqueue("visit.reminder", 2);
  await rows("UPDATE appointments SET status='cancelled' WHERE id=$1", [visitId]);
  await processOutbox();
  expect((await rows("SELECT * FROM records WHERE kind='notification'")).length).toBe(0);
  expect((await rows("SELECT * FROM outbox WHERE status='suppressed'")).length).toBe(2);
});

it("records mock delivery explicitly and blocks real mode without a provider", async () => {
  await enqueue("visit.reminder");
  await processOutbox();
  expect((await rows<{ data: { status: string } }>("SELECT data FROM records WHERE kind='notification'"))[0].data.status).toBe("mock");
  process.env.APP_MODE = "live";
  await enqueue("visit.reminder");
  await processOutbox();
  expect((await rows("SELECT * FROM outbox WHERE status='blocked'")).length).toBe(1);
  expect((await rows("SELECT * FROM records WHERE kind='notification' AND data->>'status'='sent'")).length).toBe(0);
});

it("atomically expires holds, releases resources, and deletes expired secrets only", async () => {
  await rows("UPDATE appointments SET status='hold',hold_expires_at=now()-interval '1 minute',hold_token_hash='secret',hold_phone='+79000000000' WHERE id=$1", [visitId]);
  await rows("INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at) SELECT $1,id,'jobs-chair',start_at,end_at FROM appointments WHERE id=$2", [randomUUID(), visitId]);
  await rows("INSERT INTO demo_otp VALUES('old','123456',now()-interval '1 minute'),('new','123456',now()+interval '1 minute')");
  await rows("INSERT INTO request_limits VALUES('old',1,now()-interval '1 minute'),('new',1,now()+interval '1 minute')");
  expect(await maintainTemporaryData()).toBe(1);
  expect((await rows("SELECT * FROM allocations WHERE active")).length).toBe(0);
  expect((await rows<{ status: string; hold_token_hash: null }>("SELECT status,hold_token_hash FROM appointments"))[0]).toEqual({ status: "cancelled", hold_token_hash: null });
  expect((await rows("SELECT * FROM demo_otp")).length).toBe(1);
  expect((await rows("SELECT * FROM request_limits")).length).toBe(1);
  expect(await maintainTemporaryData()).toBe(0);
});
