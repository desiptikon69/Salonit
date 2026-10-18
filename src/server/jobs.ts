import { randomUUID } from "node:crypto";
import { first, rows, transaction } from "./db";
import { saveRecord } from "./records";

type Event = { id: string; kind: string; payload: { visitId?: string; version?: number; dueAt?: string } };
type Appointment = { id: string; client_id: string; status: string; version: number; start_at: Date };

/** Every effect and its acknowledgement commit together; concurrent workers skip claimed rows. */
export async function processOutbox(limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid batch size");
  return transaction(async tx => {
    const events = await rows<Event>(`SELECT id,kind,payload FROM outbox
      WHERE status='pending' AND (kind <> 'visit.reminder' OR payload->>'dueAt' <= to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit], tx);
    for (const event of events) {
      let status = "processed";
      if (["booking.confirmed", "visit.move", "visit.rework", "visit.reminder"].includes(event.kind)) {
        const visit = event.payload.visitId && await first<Appointment>("SELECT id,client_id,status,version,start_at FROM appointments WHERE id=$1 FOR SHARE", [event.payload.visitId], tx);
        const valid = visit && visit.version === event.payload.version && visit.status === "confirmed" && visit.start_at.getTime() > Date.now();
        if (!valid) status = "suppressed";
        else {
          const client = await first<{ data: { name?: string; phone?: string } }>("SELECT data FROM records WHERE kind='client' AND id=$1", [visit.client_id], tx);
          if (!client) status = "suppressed";
          else {
            const demo = process.env.APP_MODE === "demo";
            await saveRecord("notification", `outbox-${event.id}`, {
              name: event.kind === "visit.reminder" ? "Напоминание о визите" : event.kind === "visit.move" ? "Визит перенесён" : "Запись подтверждена",
              recipient: client.data.phone || client.data.name || "Клиент", clientId: visit.client_id,
              visitId: visit.id, visitVersion: visit.version, channel: demo ? "mock" : "unconfigured",
              purpose: "service", status: demo ? "mock" : "blocked", date: new Date().toISOString(),
              reason: demo ? "Демонстрация: сообщение не отправлялось" : "Провайдер сообщений не подключён",
            }, tx);
            status = demo ? "mock" : "blocked";
            if (event.kind !== "visit.reminder") {
              const dueAt = new Date(Math.max(Date.now(), visit.start_at.getTime() - 86400000)).toISOString();
              await tx.query("INSERT INTO outbox(id,kind,payload) VALUES($1,'visit.reminder',$2)", [randomUUID(), JSON.stringify({ visitId: visit.id, version: visit.version, dueAt })]);
            }
          }
        }
      } else if (event.kind !== "operation.completed") status = "unsupported";
      await tx.query("UPDATE outbox SET status=$2 WHERE id=$1", [event.id, status]);
    }
    return events.length;
  });
}

export async function maintainTemporaryData() {
  return transaction(async tx => {
    const expired = await rows<{ id: string }>("SELECT id FROM appointments WHERE status='hold' AND hold_expires_at<=now() FOR UPDATE SKIP LOCKED", [], tx);
    if (expired.length) {
      const ids = expired.map(v => v.id);
      await tx.query("UPDATE allocations SET active=false WHERE appointment_id=ANY($1::uuid[])", [ids]);
      await tx.query("UPDATE appointments SET status='cancelled',version=version+1,hold_token_hash=NULL,hold_phone=NULL WHERE id=ANY($1::uuid[])", [ids]);
    }
    await tx.query("DELETE FROM demo_otp WHERE expires_at<=now()");
    await tx.query("DELETE FROM request_limits WHERE expires_at<=now()");
    await tx.query("DELETE FROM auth.verification WHERE expires_at<=now()");
    await tx.query("DELETE FROM auth.session WHERE expires_at<=now()");
    return expired.length;
  });
}

export async function runWorkerTick() {
  const expiredHolds = await maintainTemporaryData();
  const processed = await processOutbox();
  return { expiredHolds, processed };
}
