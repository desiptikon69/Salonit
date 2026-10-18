import type { Accrual, Actor, AuditEvent, Bundle, CatalogData, Certificate, Client, Payroll, PortalState, Service, Settings, Staff, Visit, VisitItem, WorkspaceState } from "@/lib/contracts";
import { first, rows, transaction, type SqlClient } from "./db";
import { AppError, requireCondition } from "./errors";
import { getRecord, listRecords } from "./records";
import {listFinancialCorrections} from "./financial-corrections";

type Row = Record<string, unknown>;
type Metrics = WorkspaceState["metrics"];
const emptyMetrics = (): Metrics => ({ revenueMinor: 0, cashMinor: 0, cashOutflowMinor: 0, cashFlowMinor: 0, expensesMinor: 0, payrollMinor: 0, materialsMinor: 0, resultMinor: 0, debtMinor: 0, liabilityMinor: 0, completed: 0 });
function number(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new AppError(500, "Сумма превышает безопасный предел расчёта");
  return result;
}
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value ?? ""); }
function date(value: unknown): string { return value instanceof Date ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(value) : String(value ?? "").slice(0, 10); }

/** Accepts native pg rows. Client names must be joined explicitly by the caller. */
export function visitFromRow(row: Row): Visit {
  return {
    id: String(row.id), reference: String(row.reference), clientId: String(row.client_id ?? ""),
    clientName: String(row.client_name ?? "Гость"), clientPhone: String(row.client_phone ?? ""),
    startAt: iso(row.start_at), endAt: iso(row.end_at), status: row.status as Visit["status"],
    items: (row.items ?? []) as VisitItem[], totalMinor: number(row.total_minor), paidMinor: number(row.paid_minor),
    materials: (row.materials ?? []) as Visit["materials"], version: number(row.version),
    receiptStatus: String(row.receipt_status ?? "unknown"), note: String(row.note ?? ""),
    closedAt: row.closed_at ? iso(row.closed_at) : null, parentId: row.parent_id ? String(row.parent_id) : null,
  };
}

function publicSettings(settings: Settings): Settings {
  const { name, subtitle, address, phone, hours, timezone, currency, mode } = settings;
  return { name, subtitle, address, phone, hours, timezone, currency, mode };
}
function publicStaff(member: Staff): Staff {
  return { id: member.id, name: member.name, title: member.title, initials: member.initials, color: member.color, skills: member.skills, active: member.active, workStart: member.workStart, workEnd: member.workEnd, commissionBps: 0, fixedMinor: 0, guaranteeMinor: 0, guaranteeScope: "total" };
}
function publicService(service: Service): Service { return { ...service, norms: [] }; }
function minimalClient(client: Client): Client {
  return { id: client.id, name: client.name, phone: "", email: "", notes: "", marketingConsent: false, createdAt: client.createdAt };
}
export function clientProfile(profile: Client): Client {
  return { id: profile.id, name: profile.name, phone: profile.phone, email: profile.email, notes: "", marketingConsent: profile.marketingConsent, createdAt: profile.createdAt };
}
export function clientVisit(visit: Visit): Visit {
  return { ...visit, note: "", materials: [], items: visit.items.map(item => ({ id:item.id,serviceId:item.serviceId,serviceName:item.serviceName,staffId:item.staffId,staffName:item.staffName,startAt:item.startAt,endAt:item.endAt,priceMinor:item.priceMinor,status:item.status,completedAt:item.completedAt,norms:[],commissionBps:0 })) };
}

async function settingsFor(client: SqlClient): Promise<Settings> {
  const settings = await getRecord<Settings>("settings", "salon-settings", client);
  requireCondition(settings, 503, "Экземпляр SalonIt ещё не настроен");
  return publicSettings(settings);
}

export async function getCatalog(): Promise<CatalogData> {
  return transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const services = await listRecords<Service>("service", client);
    const staff = await listRecords<Staff>("staff", client);
    const bundles = await listRecords<Bundle>("bundle", client);
    const settings = await settingsFor(client);
    const activeIds = new Set(services.filter(service => service.active).map(service => service.id));
    return { settings, services: services.filter(service => service.active).map(publicService), staff: staff.filter(member => member.active).map(publicStaff), bundles: bundles.filter(bundle => bundle.serviceIds.every(id => activeIds.has(id))) };
  });
}

async function visitsFor(client: SqlClient, condition = "true", params: unknown[] = []): Promise<Visit[]> {
  const result = await rows<Row>(`SELECT a.*, c.data->>'name' client_name, c.data->>'phone' client_phone
    FROM appointments a LEFT JOIN records c ON c.id=a.client_id AND c.kind='client'
    WHERE a.status <> 'hold' AND ${condition} ORDER BY a.start_at DESC, a.id`, params, client);
  return result.map(visitFromRow);
}

export interface FinancePeriod { dateFrom?: string; dateTo?: string; }
export function validateFinancePeriod(period: FinancePeriod = {}): FinancePeriod {
  for (const value of [period.dateFrom, period.dateTo]) {
    if (value === undefined) continue;
    requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1900-01-01" && value <= "9999-12-31" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 400, "Укажите существующую дату в формате ГГГГ-ММ-ДД");
  }
  requireCondition(!period.dateFrom || !period.dateTo || period.dateFrom <= period.dateTo, 400, "Начало периода должно быть не позже окончания");
  return period;
}
function inPeriod(day: string, period: FinancePeriod): boolean {
  return (!period.dateFrom || day >= period.dateFrom) && (!period.dateTo || day <= period.dateTo);
}
async function financialMetrics(client: SqlClient, state: WorkspaceState, period: FinancePeriod): Promise<Metrics> {
  const params = [period.dateFrom ?? null, period.dateTo ?? null];
  const within = (column: string) => `(\"${column}\" AT TIME ZONE 'Europe/Moscow')::date >= COALESCE($1::date, '-infinity'::date) AND (\"${column}\" AT TIME ZONE 'Europe/Moscow')::date <= COALESCE($2::date, 'infinity'::date)`;
  // Recognition occurs at close. Refunds reduce revenue on their own accounting date.
  const totals = await first<Row>(`WITH payment_totals AS (
      SELECT visit_id, COALESCE(sum(amount_minor) FILTER (WHERE kind='payment'),0) paid
      FROM payments WHERE visit_id IS NOT NULL GROUP BY visit_id
    ) SELECT COALESCE(sum(a.total_minor-a.paid_minor+COALESCE(p.paid,0)),0) revenue, count(*) completed
    FROM appointments a LEFT JOIN payment_totals p ON p.visit_id=a.id WHERE a.closed_at IS NOT NULL AND ${within("closed_at")}`, params, client);
  const payment = await first<Row>(`SELECT COALESCE(sum(CASE WHEN kind='refund' THEN -amount_minor
      WHEN kind='certificate_sale' OR (kind='payment' AND method<>'certificate') THEN amount_minor ELSE 0 END),0) cash,
      COALESCE(sum(amount_minor) FILTER (WHERE kind='refund'),0) refunds FROM payments WHERE ${within("created_at")}`, params, client);
  const debt = await first<Row>("SELECT COALESCE(sum(GREATEST(total_minor-paid_minor,0)),0) amount FROM appointments WHERE closed_at IS NOT NULL", [], client);
  const materials = await first<Row>(`SELECT COALESCE(sum(cost_minor),0) amount FROM consumptions WHERE ${within("created_at")}`, params, client);
  // Monthly fixed pay / guarantee top-ups are recognised on the final day of the payroll month.
  const salaryTopUps = state.payrolls.filter(p => {
    const end = new Date(`${p.month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth()+1); end.setUTCDate(0);
    return ["approved", "paid"].includes(p.status) && inPeriod(end.toISOString().slice(0,10), period);
  }).reduce((total, payroll) => total + payroll.snapshot.reduce((sum, entry) => sum + Math.max(0, entry.amountMinor - entry.variableMinor), 0), 0);
  const expenses = state.expenses.filter(expense => inPeriod(expense.date, period));
  const metrics = emptyMetrics();
  metrics.revenueMinor = number(number(totals?.revenue) - number(payment?.refunds));
  metrics.cashMinor = number(payment?.cash);
  // Purchases create inventory; expensing both procurement and consumption would double-count.
  metrics.expensesMinor = number(expenses.filter(expense => expense.category !== "Материалы").reduce((sum, expense) => sum + expense.amountMinor, 0));
  metrics.materialsMinor = number(materials?.amount);
  metrics.payrollMinor = number(state.accruals.filter(accrual => inPeriod(accrual.date, period)).reduce((sum, accrual) => sum + accrual.amountMinor, 0) + salaryTopUps);
  metrics.cashOutflowMinor = number(expenses.filter(expense => expense.paid).reduce((sum, expense) => sum + expense.amountMinor, 0) + state.payouts.filter(payout => inPeriod(date(new Date(payout.createdAt)), period)).reduce((sum, payout) => sum + payout.amountMinor, 0));
  metrics.cashFlowMinor = number(metrics.cashMinor - metrics.cashOutflowMinor);
  metrics.debtMinor = number(debt?.amount);
  metrics.completed = number(totals?.completed);
  metrics.liabilityMinor = number(state.certificates.reduce((sum, certificate) => sum + certificate.liabilityMinor, 0));
  const corrections=state.financialCorrections.filter(c=>["approved","paid"].includes(c.status)&&inPeriod(c.postingDate,period));
  const delta=(target:string)=>corrections.filter(c=>c.target===target).reduce((sum,c)=>sum+c.deltaMinor,0);
  metrics.revenueMinor=number(metrics.revenueMinor+delta("revenue"));
  metrics.expensesMinor=number(metrics.expensesMinor+delta("expenses"));
  metrics.materialsMinor=number(metrics.materialsMinor+delta("materials"));
  metrics.payrollMinor=number(metrics.payrollMinor+delta("payroll"));
  const correctionPayouts=await first<Row>(`SELECT COALESCE(sum(amount_minor),0) amount FROM payments WHERE kind='adjustment_payout' AND ${within("created_at")}`,params,client);
  metrics.cashOutflowMinor=number(metrics.cashOutflowMinor+number(correctionPayouts?.amount));
  metrics.cashFlowMinor=number(metrics.cashMinor-metrics.cashOutflowMinor);
  metrics.resultMinor = number(metrics.revenueMinor - metrics.expensesMinor - metrics.materialsMinor - metrics.payrollMinor);
  return metrics;
}

export async function getWorkspace(actor: Actor, period: FinancePeriod = {}): Promise<WorkspaceState> {
  requireCondition(actor?.id, 401, "Войдите в аккаунт");
  requireCondition(["owner", "admin", "master", "stock", "accountant", "operator"].includes(actor.role), 403, "Рабочее пространство доступно сотрудникам");
  validateFinancePeriod(period);
  if (period.dateFrom || period.dateTo) requireCondition(["owner", "accountant"].includes(actor.role), 403, "Финансовый период доступен владельцу и бухгалтеру");
  return transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const state: WorkspaceState = { actor, settings: await settingsFor(client), services: [], staff: [], resources: [], clients: [], visits: [], materials: [], expenses: [], certificates: [], accruals: [], payrolls: [], payouts: [], payrollRules: [], financialCorrections: [], tasks: [], complaints: [], purchases: [], shifts: [], notifications: [], installations: [], audit: [], bundles: [], metrics: emptyMetrics() };
    const allowedKinds: Record<string, string[]> = {
      owner: ["service", "staff", "resource", "client", "material", "expense", "certificate", "task", "complaint", "purchase", "shift", "notification", "installation", "bundle"],
      admin: ["service", "staff", "resource", "client", "material", "certificate", "task", "complaint", "shift", "notification", "bundle"],
      master: ["service", "staff", "resource", "material", "task", "shift", "bundle"],
      stock: ["material", "resource", "purchase", "task"],
      accountant: ["staff", "expense", "certificate", "client"],
      operator: ["installation"],
    };
    const mapping = { service: "services", staff: "staff", resource: "resources", client: "clients", material: "materials", expense: "expenses", certificate: "certificates", task: "tasks", complaint: "complaints", purchase: "purchases", shift: "shifts", notification: "notifications", installation: "installations", bundle: "bundles" } as const;
    const records = await rows<{ id: string; kind: keyof typeof mapping; data: Row }>("SELECT id,kind,data FROM records WHERE kind=ANY($1::text[]) ORDER BY created_at,id", [allowedKinds[actor.role]], client);
    for (const record of records) (state[mapping[record.kind]] as unknown[]).push({ ...record.data, id: record.id });
    if (["owner","accountant"].includes(actor.role)) state.financialCorrections = await listFinancialCorrections(client);
    if (["owner","accountant"].includes(actor.role)) state.payrollRules = await listRecords<import("@/lib/contracts").PayrollRule>("payroll_rule",client);
    if (["owner", "admin", "accountant"].includes(actor.role)) state.visits = await visitsFor(client);
    if (actor.role === "master") {
      requireCondition(actor.staffId, 403, "Профиль мастера не связан с сотрудником");
      state.visits = await visitsFor(client, "a.items @> $1::jsonb", [JSON.stringify([{ staffId: actor.staffId }])]);
      const facts = await rows<{ data: { visitId: string; materials: Visit["materials"] } }>("SELECT data FROM records WHERE kind='visit_material_fact' AND data->>'staffId'=$1", [actor.staffId], client);
      const ownMaterials = new Map(facts.map(fact => [fact.data.visitId, fact.data.materials]));
      // A shared visit exposes only this master's assignments, not another employee's pay or work.
      state.visits = state.visits.map(visit => {
        const items = visit.items.filter(item => item.staffId === actor.staffId);
        return { ...visit, clientPhone: "", note: "", items, totalMinor: items.filter(item=>item.status!=="cancelled").reduce((sum, item) => sum + item.priceMinor, 0), paidMinor: 0, materials: ownMaterials.get(visit.id) ?? items.filter(item=>item.status!=="cancelled").flatMap(item => item.norms) };
      });
      state.staff = state.staff.filter(member => member.id === actor.staffId);
      state.shifts = state.shifts.filter(shift => shift.staffId === actor.staffId);
      state.tasks = state.tasks.filter(task => [actor.staffId, actor.name].includes(task.assignee));
      state.clients = [...new Map(state.visits.map(visit => [visit.clientId, { id: visit.clientId, name: visit.clientName, phone: "", email: "", notes: "", marketingConsent: false, createdAt: "" }])).values()];
    }
    if (["owner", "accountant", "master"].includes(actor.role)) {
      const accruals = await rows<Row>(`SELECT a.*, s.data->>'name' staff_name FROM accruals a
        LEFT JOIN records s ON s.kind='staff' AND s.id=a.staff_id
        ${actor.role === "master" ? "WHERE a.staff_id=$1" : ""} ORDER BY a.date DESC,a.id`, actor.role === "master" ? [actor.staffId] : [], client);
      state.accruals = accruals.map(row => ({ id: String(row.id), visitId: String(row.visit_id), staffId: String(row.staff_id), staffName: String(row.staff_name ?? "Сотрудник"), serviceName: String(row.service_name), baseMinor: number(row.base_minor), amountMinor: number(row.amount_minor), rateBps: number(row.rate_bps), status: String(row.status), date: date(row.date) } satisfies Accrual));
      state.payrolls = await listRecords<Payroll>("payroll", client);
      if (actor.role === "master") state.payrolls = state.payrolls.map(payroll => ({ ...payroll, snapshot: payroll.snapshot.filter(entry => entry.staffId === actor.staffId) })).filter(payroll => payroll.snapshot.length > 0);
      const payouts = await rows<Row>(`SELECT * FROM payouts ${actor.role === "master" ? "WHERE staff_id=$1" : ""} ORDER BY month DESC,staff_id`, actor.role === "master" ? [actor.staffId] : [], client);
      state.payouts = payouts.map(row => ({ id: String(row.id), month: String(row.month), staffId: String(row.staff_id), amountMinor: number(row.amount_minor), createdAt: iso(row.created_at) }));
    }
    if (actor.role === "admin") state.visits = state.visits.map(visit=>({...visit,items:visit.items.map(item=>({...item,commissionBps:0,rewardRuleId:undefined,rewardRuleSnapshot:undefined}))}));
    if (["owner", "accountant"].includes(actor.role)) state.metrics = await financialMetrics(client, state, period);
    if (["owner", "operator"].includes(actor.role)) {
      const audit = await rows<Row>(`SELECT * FROM audit_events ${actor.role === "operator" ? "WHERE action='installation.save'" : ""} ORDER BY created_at DESC,id LIMIT 200`, [], client);
      state.audit = audit.map(row => ({ id: String(row.id), actor: String(row.actor), action: String(row.action), entityId: String(row.entity_id), createdAt: iso(row.created_at), details: actor.role === "operator" ? {} : row.details as AuditEvent["details"] }));
    }
    if (actor.role === "stock") state.tasks = state.tasks.filter(task => [actor.id, actor.name, "Закупщик"].includes(task.assignee));
    if (!["owner", "accountant", "master"].includes(actor.role)) state.staff = state.staff.map(publicStaff);
    if (["admin", "master"].includes(actor.role)) state.materials = state.materials.map(material => ({ ...material, costMinor: 0, supplier: "" }));
    if (actor.role === "accountant") {
      state.clients = state.clients.map(minimalClient);
      state.visits = state.visits.map(visit => ({ ...clientVisit(visit), clientPhone: "" }));
    }
    state.clients = state.clients.map(profile => ({ id: profile.id, name: profile.name, phone: profile.phone, email: profile.email, notes: profile.notes, marketingConsent: profile.marketingConsent, createdAt: profile.createdAt }));
    return state;
  });
}

export async function getPortal(actor: Actor): Promise<PortalState> {
  requireCondition(actor?.id, 401, "Войдите в аккаунт");
  requireCondition(actor.role === "client" && actor.clientId, 403, "Кабинет доступен клиенту");
  return transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const profile = await getRecord<Client>("client", actor.clientId!, client);
    requireCondition(profile, 404, "Профиль клиента не найден");
    const certificates = await rows<{ id: string; data: Certificate }>("SELECT id,data FROM records WHERE kind='certificate' AND data->>'clientId'=$1 ORDER BY created_at DESC", [profile.id], client);
    const cleanProfile = clientProfile(profile);
    return { actor, client: { ...cleanProfile, notes: "" }, visits: (await visitsFor(client, "a.client_id=$1", [profile.id])).map(clientVisit), certificates: certificates.map(record => ({ ...record.data, id: record.id, liabilityMinor: 0 })), recommendations: [] };
  });
}



