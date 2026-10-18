import type {FinancialCorrection} from "@/server/financial-corrections";
export type Role = "owner" | "admin" | "master" | "stock" | "accountant" | "operator" | "client";
export interface Actor { id: string; name: string; role: Role; staffId?: string | null; clientId?: string | null; }
export type Category = "Волосы" | "Ногти" | "Брови и ресницы" | "Макияж" | "Уход";
export interface Usage { materialId: string; quantityMilli: number; }
export interface Service { id: string; name: string; category: Category; description: string; durationMinutes: number; bufferMinutes: number; priceMinor: number; skill: string; resourceType: string; active: boolean; norms: Usage[]; stages?: { name: string; durationMinutes: number; needsStaff: boolean; }[]; }
export interface Staff { id: string; name: string; title: string; initials: string; color: string; skills: string[]; commissionBps: number; fixedMinor: number; guaranteeMinor: number; guaranteeScope: "total" | "variable"; active: boolean; workStart: string; workEnd: string; }
export interface PayrollRule { id: string; staffId: string; effectiveFrom: string; commissionBps: number; fixedMinor: number; guaranteeMinor: number; guaranteeScope: "total" | "variable"; reason: string; version: number; createdAt: string; createdBy: string; baseline?: boolean; }
export interface Resource { id: string; name: string; type: string; ready: boolean; status: string; readyUntil?: string; processingValidityHours?: number; }
export interface Client { id: string; name: string; phone: string; email: string; notes: string; marketingConsent: boolean; createdAt: string; accountId?: string | null; }
export interface VisitItem { completedAt?: string; rewardRuleId?: string; rewardRuleSnapshot?: PayrollRule; reservations?: { resourceKey: string; startAt: string; endAt: string }[]; cancellationReason?: string; id: string; serviceId: string; serviceName: string; staffId: string; staffName: string; startAt: string; endAt: string; priceMinor: number; commissionBps: number; norms: Usage[]; status?: string; }
export type VisitStatus = "hold" | "confirmed" | "arrived" | "in_progress" | "completed" | "cancelled" | "no_show";
export interface Visit { id: string; reference: string; clientId: string; clientName: string; clientPhone: string; startAt: string; endAt: string; status: VisitStatus; items: VisitItem[]; totalMinor: number; paidMinor: number; materials: Usage[]; version: number; receiptStatus: string; note: string; closedAt?: string | null; parentId?: string | null; }
export interface Material { id: string; name: string; unit: string; stockMilli: number; minStockMilli: number; costMinor: number; supplier: string; }
export interface Expense { id: string; name: string; category: string; amountMinor: number; date: string; paid: boolean; }
export interface Certificate { id: string; code: string; clientId: string; nominalMinor: number; saleMinor: number; balanceMinor: number; liabilityMinor: number; status: string; kind: "certificate" | "package"; unitsRemaining?: number; serviceIds?: string[]; }
export interface Accrual { id: string; visitId: string; staffId: string; staffName: string; serviceName: string; baseMinor: number; amountMinor: number; rateBps: number; status: string; date: string; }
export interface PayrollRow { staffId: string; fixedMinor: number; guaranteeMinor: number; guaranteeScope: "total" | "variable"; variableMinor: number; amountMinor: number; }
export interface Payroll { id: string; month: string; status: string; snapshot: PayrollRow[]; }
export interface Payout { id: string; month: string; staffId: string; amountMinor: number; createdAt: string; }
export interface Task { id: string; name: string; assignee: string; dueDate: string; priority: string; status: string; }
export interface Complaint { id: string; name: string; clientId: string; visitId: string; reason: string; assignee: string; status: string; dueDate: string; resolution?: string; }
export interface Purchase { id: string; name: string; supplier: string; materialId: string; quantityMilli: number; amountMinor: number; status: string; }
export interface Shift { id: string; name: string; staffId: string; date: string; start: string; end: string; status: string; }
export interface Notification { id: string; name: string; recipient: string; channel: string; purpose: string; status: string; date: string; }
export interface Installation { id: string; name: string; domain: string; codeVersion: string; dbVersion: string; status: string; region: string; }
export interface AuditEvent { id: string; actor: string; action: string; entityId: string; createdAt: string; details: Record<string, unknown>; }
export interface Settings { name: string; subtitle: string; address: string; phone: string; hours: string; timezone: string; currency: string; mode: string; [key: string]: unknown; }
export interface Bundle { id: string; name: string; description: string; serviceIds: string[]; mode: "parallel" | "sequential"; }
export interface WorkspaceState { actor: Actor; settings: Settings; services: Service[]; staff: Staff[]; payrollRules: PayrollRule[]; financialCorrections: FinancialCorrection[]; resources: Resource[]; clients: Client[]; visits: Visit[]; materials: Material[]; expenses: Expense[]; certificates: Certificate[]; accruals: Accrual[]; payrolls: Payroll[]; payouts: Payout[]; tasks: Task[]; complaints: Complaint[]; purchases: Purchase[]; shifts: Shift[]; notifications: Notification[]; installations: Installation[]; audit: AuditEvent[]; bundles: Bundle[]; metrics: { revenueMinor: number; cashMinor: number; cashOutflowMinor: number; cashFlowMinor: number; expensesMinor: number; payrollMinor: number; materialsMinor: number; resultMinor: number; debtMinor: number; liabilityMinor: number; completed: number; }; }
export interface CatalogData { services: Service[]; staff: Staff[]; bundles: Bundle[]; settings: Settings; }
export interface Slot { startAt: string; endAt: string; priceMinor: number; staffNames: string[]; }
export interface PortalState { actor: Actor; client: Client; visits: Visit[]; certificates: Certificate[]; recommendations: string[]; }
export interface PaymentInput { method: "cash" | "card" | "sbp" | "certificate"; amountMinor: number; certificateCode?: string; }



