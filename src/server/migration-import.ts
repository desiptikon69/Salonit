import { createHash, randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Actor, Certificate, Client, Resource, Service, Shift, Staff } from "@/lib/contracts";
import { overlaps, planVisit, type Allocation, type Plan } from "@/domain/scheduling";
import { first, rows, transaction, type SqlClient } from "./db";
import { audit, getRecord, listRecords, saveRecord } from "./records";
import { AppError, requireCondition as check } from "./errors";
import { authorize } from "./permissions";

const inputSchema = z.object({ entity: z.enum(["visits", "certificates"]), source: z.string().trim().min(2).max(100), csv: z.string().min(1).max(500_000) });
type Input = z.infer<typeof inputSchema>;
type CsvRow = Record<string, string>;
type ImportRow = { externalId: string; clientId: string; hash: string; mappingId: string; plan?: Plan; totalMinor?: number; paidMinor?: number; certificate?: Omit<Certificate, "id"> };
export interface MigrationPreview { entity: Input["entity"]; source: string; fingerprint: string; totalRows: number; imported: number; skipped: number; totals: { totalMinor: number; paidMinor: number; balanceMinor: number; liabilityMinor: number }; errors: { row: number; externalId: string; message: string }[]; valid: boolean; }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const day = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date(value));
const integer = (value: string | undefined, name: string) => { check(value !== undefined && /^(0|[1-9]\d*)$/.test(value), 400, `${name}: требуется целое неотрицательное число`); const n = Number(value); check(Number.isSafeInteger(n), 400, `${name}: число слишком велико`); return n; };
const identifiers = (value: string | undefined) => (value || "").split("|").map(s => s.trim()).filter(Boolean);

// Allocate the imported quote exactly, without floating-point currency arithmetic.
function quote(plan: Plan, total: number): Plan {
  const weights = plan.items.map(i => BigInt(i.priceMinor));
  const denominator = weights.reduce((a, b) => a + b, 0n);
  const values = weights.map(w => denominator ? Number(BigInt(total) * w / denominator) : Math.floor(total / weights.length));
  let remainder = total - values.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i++, remainder--) values[i % values.length]++;
  return { ...plan, totalMinor: total, items: plan.items.map((item, i) => ({ ...item, priceMinor: values[i] })) };
}
async function inspect(tx: SqlClient, p: Input) {
  const fingerprint = hash(JSON.stringify([p.entity, p.source, p.csv]));
  const result: MigrationPreview = { entity: p.entity, source: p.source, fingerprint, totalRows: 0, imported: 0, skipped: 0, totals: { totalMinor: 0, paidMinor: 0, balanceMinor: 0, liabilityMinor: 0 }, errors: [], valid: false };
  let csv: CsvRow[];
  try { csv = parse(p.csv, { columns: true, bom: true, skip_empty_lines: true, trim: true, max_record_size: 20_000 }); }
  catch { result.errors.push({ row: 1, externalId: "", message: "Некорректный CSV: проверьте заголовки, кавычки и количество столбцов" }); return { result, pending: [] as ImportRow[] }; }
  result.totalRows = csv.length;
  if (!csv.length || csv.length > 500) { result.errors.push({ row: 1, externalId: "", message: "Допустимо от 1 до 500 строк за один импорт" }); return { result, pending: [] as ImportRow[] }; }
  const [clients, services, staff, resources, shifts, certificates, allocations] = await Promise.all([
    listRecords<Client>("client", tx), listRecords<Service>("service", tx), listRecords<Staff>("staff", tx), listRecords<Resource>("resource", tx), listRecords<Shift>("shift", tx), listRecords<Certificate>("certificate", tx),
    rows<{ resource_key: string; start_at: Date; end_at: Date }>("SELECT a.resource_key,a.start_at,a.end_at FROM allocations a JOIN appointments v ON v.id=a.appointment_id WHERE a.active AND (v.status<>'hold' OR v.hold_expires_at>now())", [], tx),
  ]);
  const busy: Allocation[] = allocations.map(a => ({ resourceKey: a.resource_key, startAt: a.start_at.toISOString(), endAt: a.end_at.toISOString() }));
  const existingClients = await rows<{ client_id: string; start_at: Date; end_at: Date }>("SELECT client_id,start_at,end_at FROM appointments WHERE client_id<>'' AND status IN ('confirmed','arrived','in_progress','completed') AND closed_at IS NULL", [], tx);
  busy.push(...existingClients.map(v => ({ resourceKey: "client:" + v.client_id, startAt: v.start_at.toISOString(), endAt: v.end_at.toISOString() })));
  const pending: ImportRow[] = [], externalIds = new Set<string>(), codes = new Set(certificates.map(c => c.code.toLocaleUpperCase("en-US")));
  for (let index = 0; index < csv.length; index++) {
    const raw = csv[index], externalId = raw.externalId || "";
    try {
      check(externalId.length > 0 && externalId.length <= 150, 400, "Укажите externalId длиной до 150 символов");
      check(!externalIds.has(externalId), 400, "externalId повторяется в файле"); externalIds.add(externalId);
      const clientId = raw.clientId || ""; check(clients.some(c => c.id === clientId), 400, "clientId не найден: сначала импортируйте клиентов и сопоставьте идентификаторы");
      const mappingId = "migration:" + hash(JSON.stringify([p.source, p.entity, externalId]));
      const rowHash = hash(JSON.stringify(Object.keys(raw).sort().map(key => [key, raw[key]])));
      const existing = await getRecord<{ rowHash: string }>("migration_mapping", mappingId, tx);
      if (existing) { check(existing.rowHash === rowHash, 409, "Внешний идентификатор уже импортирован с другими данными. Исправьте запись отдельно"); result.skipped++; continue; }
      const row: ImportRow = { externalId, clientId, hash: rowHash, mappingId };
      if (p.entity === "visits") {
        const startAt = z.string().datetime({ offset: true }).parse(raw.startAt);
        check(Date.parse(startAt) > Date.now() + 60_000, 400, "Импортировать можно только будущие визиты");
        const ids = identifiers(raw.serviceIds); check(ids.length > 0 && ids.length <= 6 && new Set(ids).size === ids.length, 400, "Укажите от 1 до 6 уникальных serviceIds через |");
        const selected = ids.map(id => services.find(s => s.id === id)); check(selected.every(Boolean), 400, "Услуга не найдена");
        check(raw.mode === "sequential" || raw.mode === "parallel", 400, "mode должен быть sequential или parallel");
        const available = staff.flatMap(member => {
          const entries = shifts.filter(s => s.staffId === member.id && s.date === day(startAt));
          return entries.length ? entries.filter(s => ["planned", "confirmed", "active"].includes(s.status)).map(s => ({ ...member, workStart: s.start, workEnd: s.end })) : [member];
        });
        const plan = planVisit({ services: selected as Service[], staff: available, resources, startAt, mode: raw.mode, busy, staffId: raw.staffId || undefined });
        check(plan, 409, "Нет свободного мастера, места или готовых инструментов");
        if (raw.endAt) { const end = z.string().datetime({ offset: true }).parse(raw.endAt); check(Date.parse(end) === Date.parse(plan.endAt), 400, "endAt не совпадает с длительностью выбранных услуг"); }
        check(!busy.some(a => a.resourceKey === "client:" + clientId && overlaps(Date.parse(startAt), Date.parse(plan.endAt), Date.parse(a.startAt), Date.parse(a.endAt))), 409, "У клиента уже есть визит в это время");
        const total = integer(raw.totalMinor, "totalMinor"), paid = integer(raw.paidMinor, "paidMinor"); check(paid <= total, 400, "Аванс превышает сумму визита");
        row.plan = quote(plan, total); row.totalMinor = total; row.paidMinor = paid;
        busy.push(...plan.allocations, { resourceKey: "client:" + clientId, startAt: plan.startAt, endAt: plan.endAt });
        result.totals.totalMinor += total; result.totals.paidMinor += paid;
      } else {
        const code = (raw.code || "").toUpperCase(); check(/^[A-ZА-ЯЁ0-9_-]{3,100}$/u.test(code), 400, "Код: от 3 до 100 букв, цифр, _ или -"); check(!codes.has(code), 409, "Код сертификата или абонемента уже используется");
        check(raw.kind === "certificate" || raw.kind === "package", 400, "kind должен быть certificate или package");
        const nominalMinor = integer(raw.nominalMinor, "nominalMinor"), saleMinor = integer(raw.saleMinor, "saleMinor"), balanceMinor = integer(raw.balanceMinor, "balanceMinor"), liabilityMinor = integer(raw.liabilityMinor, "liabilityMinor");
        check(nominalMinor > 0 && saleMinor <= nominalMinor && balanceMinor <= nominalMinor && liabilityMinor <= saleMinor && liabilityMinor <= balanceMinor, 400, "Проверьте номинал, цену продажи, остаток и обязательство");
        check(balanceMinor > 0 || liabilityMinor === 0, 400, "При нулевом остатке обязательство должно быть нулевым");
        const certificate: Omit<Certificate, "id"> = { code, clientId, kind: raw.kind, nominalMinor, saleMinor, balanceMinor, liabilityMinor, status: balanceMinor ? "active" : "used" };
        if (raw.kind === "package") {
          certificate.unitsRemaining = integer(raw.unitsRemaining, "unitsRemaining"); certificate.serviceIds = identifiers(raw.serviceIds);
          check(certificate.serviceIds.length > 0 && new Set(certificate.serviceIds).size === certificate.serviceIds.length && certificate.serviceIds.every(id => services.some(s => s.id === id)), 400, "Для абонемента укажите существующие уникальные serviceIds");
          check((certificate.unitsRemaining === 0) === (balanceMinor === 0), 400, "Количество оставшихся процедур должно соответствовать ненулевому остатку");
        }
        row.certificate = certificate; codes.add(code); result.totals.balanceMinor += balanceMinor; result.totals.liabilityMinor += liabilityMinor;
      }
      check(Object.values(result.totals).every(Number.isSafeInteger), 400, "Контрольная сумма слишком велика");
      pending.push(row);
    } catch (error) { result.errors.push({ row: index + 2, externalId, message: error instanceof z.ZodError ? "Дата должна быть в ISO 8601 с часовым поясом" : error instanceof Error ? error.message : "Некорректная строка" }); }
  }
  result.imported = pending.length; result.valid = result.errors.length === 0;
  return { result, pending };
}

export async function runMigrationImport(actor: Actor, action: "migration.preview" | "migration.commit", payload: unknown, commandId: string): Promise<MigrationPreview> {
  authorize(actor, ["owner", "admin"]);
  let p: Input;
  try { p = inputSchema.parse(payload); z.string().min(1).max(150).parse(commandId); }
  catch { throw new AppError(400, "Укажите источник и CSV размером до 500 КБ"); }
  check(action === "migration.preview" || action === "migration.commit", 400, "Неизвестная операция импорта");
  try {
    return await transaction(async tx => {
      if (action === "migration.commit") {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["command:" + commandId]);
        const old = await first<{ actor_id: string; action: string; result: MigrationPreview }>("SELECT actor_id,action,result FROM commands WHERE id=$1", [commandId], tx);
        if (old) { check(old.actor_id === actor.id && old.action === action && old.result.fingerprint === hash(JSON.stringify([p.entity, p.source, p.csv])), 409, "Ключ команды уже использован"); return old.result; }
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('booking',0))");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('migration-import',0))");
      }
      const fingerprint = hash(JSON.stringify([p.entity, p.source, p.csv]));
      const previous = await first<{ result: MigrationPreview }>("SELECT result FROM import_runs WHERE fingerprint=$1", [fingerprint], tx);
      if (previous) return previous.result;
      const { result, pending } = await inspect(tx, p);
      if (action === "migration.preview") return result;
      check(result.valid, 400, result.errors.map(e => `Строка ${e.row}: ${e.message}`).join("; "));
      // Expired holds are excluded by preview but must also release exclusion constraints.
      await tx.query("UPDATE allocations SET active=false WHERE appointment_id IN (SELECT id FROM appointments WHERE status='hold' AND hold_expires_at<=now())");
      for (const row of pending) {
        const id = randomUUID();
        if (row.plan) {
          await tx.query("INSERT INTO appointments(id,reference,client_id,status,start_at,end_at,items,total_minor,paid_minor,note) VALUES($1,$2,$3,'confirmed',$4,$5,$6,$7,$8,$9)", [id, "IM-" + id.slice(0, 8).toUpperCase(), row.clientId, row.plan.startAt, row.plan.endAt, JSON.stringify(row.plan.items), row.totalMinor, row.paidMinor, `Импорт: ${p.source} / ${row.externalId}`]);
          for (const a of [...row.plan.allocations, { resourceKey: "client:" + row.clientId, startAt: row.plan.startAt, endAt: row.plan.endAt }]) await tx.query("INSERT INTO allocations(id,appointment_id,resource_key,start_at,end_at) VALUES($1,$2,$3,$4,$5)", [randomUUID(), id, a.resourceKey, a.startAt, a.endAt]);
          if (row.paidMinor) await tx.query("INSERT INTO payments(id,visit_id,method,amount_minor,kind) VALUES($1,$2,'opening',$3,'payment')", [randomUUID(), id, row.paidMinor]);
        } else if (row.certificate) await saveRecord("certificate", id, row.certificate, tx);
        await saveRecord("migration_mapping", row.mappingId, { source: p.source, entity: p.entity, externalId: row.externalId, rowHash: row.hash, localId: id, importedAt: new Date().toISOString(), opening: true }, tx);
      }
      await tx.query("INSERT INTO import_runs(fingerprint,result) VALUES($1,$2)", [result.fingerprint, JSON.stringify(result)]);
      await saveRecord("migration_source", "migration-source:" + hash(p.source), { source: p.source, lastImportAt: new Date().toISOString(), lastFingerprint: result.fingerprint }, tx);
      await audit(tx, actor, action, result.fingerprint, { entity: p.entity, source: p.source, imported: result.imported, skipped: result.skipped, totals: result.totals });
      await tx.query("INSERT INTO commands(id,actor_id,action,result) VALUES($1,$2,$3,$4)", [commandId, actor.id, action, JSON.stringify(result)]);
      return result;
    });
  } catch (error) { if ((error as { code?: string }).code === "23P01") throw new AppError(409, "Время занято: обновите предпросмотр импорта"); throw error; }
}
