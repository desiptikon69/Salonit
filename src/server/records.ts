import { randomUUID } from "node:crypto";
import { first, rows, pool, type SqlClient } from "./db";
import type { Actor } from "@/lib/contracts";
export async function listRecords<T>(kind: string, client: SqlClient = pool): Promise<T[]> {
  return (await rows<{id:string;data:Record<string,unknown>}>("SELECT id,data FROM records WHERE kind=$1 ORDER BY created_at,id",[kind],client)).map(r=>({...r.data,id:r.id}) as T);
}
export async function getRecord<T>(kind: string, id: string, client: SqlClient = pool, lock = false): Promise<T | undefined> {
  const r = await first<{id:string;data:Record<string,unknown>}>(`SELECT id,data FROM records WHERE kind=$1 AND id=$2${lock?" FOR UPDATE":""}`,[kind,id],client);
  return r ? ({...r.data,id:r.id} as T) : undefined;
}
export async function saveRecord(kind: string,id:string,data:Record<string,unknown> | object,client:SqlClient=pool) {
  const clean={...data} as Record<string,unknown>; delete clean.id;
  const saved = await first("INSERT INTO records(id,kind,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=now() WHERE records.kind=EXCLUDED.kind RETURNING id",[id,kind,JSON.stringify(clean)],client);
  if(!saved) throw new Error("Record kind mismatch"); return {id,...clean};
}
export async function audit(client:SqlClient, actor:Actor,action:string,entityId:string,details:Record<string,unknown>={}) {
  await client.query("INSERT INTO audit_events(id,actor,action,entity_id,details) VALUES($1,$2,$3,$4,$5)",[randomUUID(),actor.name,action,entityId,JSON.stringify(details)]);
}

