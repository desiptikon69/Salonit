import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/lib/contracts";
import { first, pool, transaction, type SqlClient } from "./db";
import { audit, getRecord, listRecords } from "./records";
import { AppError, requireCondition as check } from "./errors";
import { authorize } from "./permissions";

/** All three fact types are inserted once. Approval never overwrites the adjustment. */
export interface FinancialCorrection {
  id: string;
  sourceVisitId: string;
  sourceReference: string;
  sourceAccrualId?: string;
  sourcePeriod: string;
  sourceAmountMinor: number;
  staffId?: string;
  staffName?: string;
  target: "revenue" | "materials" | "expenses" | "payroll";
  deltaMinor: number;
  postingDate: string;
  reason: string;
  createdAt: string;
  createdBy: string;
  createdById: string;
  status: "draft" | "approved" | "paid";
  version: number;
  settlement: "none" | "awaiting_payout" | "offset_review" | "paid";
  approvedAt?: string;
  approvedBy?: string;
  approvedById?: string;
  paidAt?: string;
  paidBy?: string;
  paidById?: string;
  paymentId?: string;
  method?: "cash" | "card" | "sbp";
  externalReference?: string;
}
type Adjustment = Omit<FinancialCorrection, "status" | "version" | "settlement">;
interface Approval { id: string; correctionId: string; approvedAt: string; approvedBy: string; approvedById: string; }
interface CorrectionPayout { id: string; correctionId: string; paidAt: string; paidBy: string; paidById: string; paymentId: string; method: "cash" | "card" | "sbp"; externalReference: string; }
const identifier = z.string().trim().min(1).max(200);
const reference = z.string().trim().min(3).max(500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Укажите существующую дату");
const createSchema = z.object({ sourceVisitId: z.uuid(), sourceAccrualId: z.uuid().optional(), target: z.enum(["revenue", "materials", "expenses", "payroll"]), deltaMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine(value => value !== 0, "Сумма не должна быть нулевой"), postingDate: date, reason: reference }).strict();
const approveSchema = z.object({ id: identifier, version: z.number().int().positive() }).strict();
const payoutSchema = approveSchema.extend({ method: z.enum(["cash", "card", "sbp"]), externalReference: reference }).strict();
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
const month = (value: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit" }).format(value);

function project(fact: Adjustment, approval?: Approval, payout?: CorrectionPayout): FinancialCorrection {
  const approvalFields = approval ? { approvedAt: approval.approvedAt, approvedBy: approval.approvedBy, approvedById: approval.approvedById } : {};
  const payoutFields = payout ? { paidAt: payout.paidAt, paidBy: payout.paidBy, paidById: payout.paidById, paymentId: payout.paymentId, method: payout.method, externalReference: payout.externalReference } : {};
  return { ...fact, ...approvalFields, ...payoutFields, status: payout ? "paid" : approval ? "approved" : "draft", version: payout ? 3 : approval ? 2 : 1, settlement: payout ? "paid" : fact.target === "payroll" ? (fact.deltaMinor < 0 ? "offset_review" : "awaiting_payout") : "none" };
}
export async function listFinancialCorrections(client: SqlClient = pool): Promise<FinancialCorrection[]> {
  const facts=await listRecords<Adjustment>("financial_adjustment",client);
  const approvals=await listRecords<Approval>("financial_adjustment_approval",client);
  const payouts=await listRecords<CorrectionPayout>("financial_adjustment_payout",client);
  const approved = new Map(approvals.map(a => [a.correctionId, a])); const paid = new Map(payouts.map(p => [p.correctionId, p]));
  return facts.map(f => project(f, approved.get(f.id), paid.get(f.id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function getCorrection(id: string, client: SqlClient): Promise<FinancialCorrection> {
  const fact = await getRecord<Adjustment>("financial_adjustment", id, client);
  check(fact, 404, "Корректировка не найдена");
  return project(fact, await getRecord<Approval>("financial_adjustment_approval", `approval:${id}`, client), await getRecord<CorrectionPayout>("financial_adjustment_payout", `payout:${id}`, client));
}
async function insertFact(client: SqlClient, kind: string, id: string, data: object) {
  await client.query("INSERT INTO records(id,kind,data) VALUES($1,$2,$3)", [id, kind, JSON.stringify(data)]);
}
async function openPeriod(postingDate: string, client: SqlClient) {
  const current = today(); const period = postingDate.slice(0, 7);
  check(period === current.slice(0, 7) && postingDate <= current, 409, "Проведите корректировку текущей датой в открытом месяце");
  // Shares the same lock as payroll approval/payment and visit closing.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`payroll:${period}`]);
  check(!await first("SELECT 1 FROM payouts WHERE month=$1 UNION ALL SELECT 1 FROM records WHERE kind IN ('payroll','financial_period') AND data->>'month'=$1 AND data->>'status' IN ('paid','locked','closed')", [period], client), 409, "Период проведения выплачен или закрыт. Используйте следующий открытый период");
}
async function createCorrection(actor: Actor, payload: unknown, client: SqlClient) {
  const p = createSchema.parse(payload);
  check(p.target === "payroll" ? Boolean(p.sourceAccrualId) : !p.sourceAccrualId, 400, "Начисление указывается только для корректировки оплаты труда");
  await openPeriod(p.postingDate, client);
  const source = await first<{ id: string; reference: string; total_minor: string; closed_at: Date | null; start_at: Date }>("SELECT id,reference,total_minor,closed_at,start_at FROM appointments WHERE id=$1 FOR SHARE", [p.sourceVisitId], client);
  check(source?.closed_at, 409, "Корректировка должна ссылаться на закрытый визит");
  let sourcePeriod = month(source.start_at); let sourceAmountMinor = Number(source.total_minor); let staffId: string | undefined; let staffName: string | undefined;
  if (p.target === "payroll") {
    const accrual = await first<{ staff_id: string; amount_minor: string; date: string | Date }>("SELECT staff_id,amount_minor,date FROM accruals WHERE id=$1 AND visit_id=$2 FOR SHARE", [p.sourceAccrualId, p.sourceVisitId], client);
    check(accrual, 404, "Начисление не относится к исходному визиту");
    staffId = accrual.staff_id; staffName = (await getRecord<{ name: string }>("staff", staffId, client))?.name ?? staffId;
    sourcePeriod = typeof accrual.date === "string" ? accrual.date.slice(0, 7) : month(accrual.date);
    sourceAmountMinor = Number(accrual.amount_minor);
  } else if (p.target === "materials") {
    sourceAmountMinor = Number((await first<{ amount: string }>("SELECT COALESCE(sum(cost_minor),0) amount FROM consumptions WHERE visit_id=$1", [p.sourceVisitId], client))?.amount ?? 0);
  } else if (p.target === "expenses") sourceAmountMinor = 0;
  const id = randomUUID();
  const fact: Adjustment = { id, ...p, sourceReference: source.reference, sourcePeriod, sourceAmountMinor, ...(staffId ? { staffId, staffName } : {}), createdAt: new Date().toISOString(), createdBy: actor.name, createdById: actor.id };
  await insertFact(client, "financial_adjustment", id, fact);
  return project(fact);
}
async function execute(actor: Actor, action: string, payload: unknown, client: SqlClient) {
  if (action === "finance.correction.create") return createCorrection(actor, payload, client);
  check(action === "finance.correction.approve" || action === "finance.correction.payout", 400, "Неизвестная команда корректировки");
  const p = action === "finance.correction.approve" ? approveSchema.parse(payload) : payoutSchema.parse(payload);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`financial-correction:${p.id}`]);
  const correction = await getCorrection(p.id, client);
  check(correction.version === p.version, 409, "Корректировка изменена. Обновите данные");
  if (action === "finance.correction.approve") {
    check(correction.status === "draft", 409, "Корректировка уже согласована");
    await openPeriod(correction.postingDate, client);
    const approval = { correctionId: p.id, approvedAt: new Date().toISOString(), approvedBy: actor.name, approvedById: actor.id };
    await insertFact(client, "financial_adjustment_approval", `approval:${p.id}`, approval);
  } else {
    const payment = payoutSchema.parse(payload);
    check(correction.status === "approved" && correction.target === "payroll" && correction.deltaMinor > 0, 409, "Выплата доступна только для согласованной положительной корректировки начисления");
    await openPeriod(today(), client);
    const paymentId = randomUUID(); const paidAt = new Date().toISOString();
    await client.query("INSERT INTO payments(id,method,amount_minor,kind,created_at) VALUES($1,$2,$3,'adjustment_payout',$4)", [paymentId, payment.method, correction.deltaMinor, paidAt]);
    await insertFact(client, "financial_adjustment_payout", `payout:${p.id}`, { correctionId: p.id, paymentId, paidAt, paidBy: actor.name, paidById: actor.id, method: payment.method, externalReference: payment.externalReference });
  }
  return getCorrection(p.id, client);
}
export async function runFinancialCorrection(actor: Actor, action: string, payload: unknown, commandId: string): Promise<FinancialCorrection> {
  authorize(actor, ["owner", "accountant"]);
  try {
    identifier.parse(commandId);
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`command:${commandId}`]);
      const old = await first<{ actor_id: string; action: string; result: { fingerprint?: string; correction?: FinancialCorrection } }>("SELECT actor_id,action,result FROM commands WHERE id=$1", [commandId], client);
      if (old) {
        check(old.actor_id === actor.id && old.action === action && old.result.fingerprint === fingerprint && old.result.correction, 409, "Ключ команды уже использован с другими данными");
        return old.result.correction;
      }
      const result = await execute(actor, action, payload, client);
      await audit(client, actor, action, result.id, { sourceVisitId: result.sourceVisitId, target: result.target, deltaMinor: result.deltaMinor, postingDate: result.postingDate });
      await client.query("INSERT INTO commands(id,actor_id,action,result) VALUES($1,$2,$3,$4)", [commandId, actor.id, action, JSON.stringify({ fingerprint, correction: result })]);
      return result;
    });
  } catch (error) {
    if (error instanceof z.ZodError) throw new AppError(400, error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    throw error;
  }
}
