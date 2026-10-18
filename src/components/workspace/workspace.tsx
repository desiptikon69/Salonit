"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ComponentType } from "react";
import { ArrowUpRight, Bell, Boxes, CalendarDays, ChevronRight, ClipboardList, CreditCard, Clock3, FileInput, Gift, LayoutDashboard, LogOut, Menu, Plus, Receipt, RefreshCw, Scissors, Server, Settings as SettingsIcon, ShieldCheck, Sparkles, Users, Wallet, X } from "lucide-react";
import type { Role } from "@/lib/contracts";
import { Badge, Empty, Metric, money, time, today, useWorkspace, type SectionProps } from "./common";
import { Clients, Services, Team } from "./catalog";
import { Visits, VisitDetails } from "./visits";
import { Inventory, Installations, Notifications, Quality, Tasks } from "./operations";
import { Certificates, Finance, Payroll } from "./finance";
import { Audit, ImportClients, Settings } from "./administration";

type Section = { id: string; name: string; icon: typeof LayoutDashboard; roles: Role[]; component: ComponentType<SectionProps>; group: string; };
const sections: Section[] = [
  { id: "overview", name: "Обзор", icon: LayoutDashboard, roles: ["owner", "admin"], component: Overview, group: "РАБОЧИЙ ДЕНЬ" },
  { id: "calendar", name: "Расписание", icon: CalendarDays, roles: ["owner", "admin", "master"], component: Visits, group: "РАБОЧИЙ ДЕНЬ" },
  { id: "clients", name: "Клиенты", icon: Users, roles: ["owner", "admin"], component: Clients, group: "РАБОЧИЙ ДЕНЬ" },
  { id: "tasks", name: "Задачи", icon: ClipboardList, roles: ["owner", "admin"], component: Tasks, group: "РАБОЧИЙ ДЕНЬ" },
  { id: "quality", name: "Качество", icon: ShieldCheck, roles: ["owner", "admin"], component: Quality, group: "РАБОЧИЙ ДЕНЬ" },
  { id: "services", name: "Услуги", icon: Scissors, roles: ["owner"], component: Services, group: "УПРАВЛЕНИЕ" },
  { id: "team", name: "Команда", icon: Users, roles: ["owner"], component: Team, group: "УПРАВЛЕНИЕ" },
  { id: "inventory", name: "Склад и ресурсы", icon: Boxes, roles: ["owner", "stock"], component: Inventory, group: "УПРАВЛЕНИЕ" },
  { id: "finance", name: "Финансы", icon: Wallet, roles: ["owner", "accountant"], component: Finance, group: "УПРАВЛЕНИЕ" },
  { id: "payroll", name: "Начисления", icon: Receipt, roles: ["owner", "accountant"], component: Payroll, group: "УПРАВЛЕНИЕ" },
  { id: "certificates", name: "Сертификаты", icon: Gift, roles: ["owner", "admin"], component: Certificates, group: "УПРАВЛЕНИЕ" },
  { id: "notifications", name: "Уведомления", icon: Bell, roles: ["owner", "admin"], component: Notifications, group: "СИСТЕМА" },
  { id: "import", name: "Импорт", icon: FileInput, roles: ["owner", "admin"], component: ImportClients, group: "СИСТЕМА" },
  { id: "settings", name: "Настройки", icon: SettingsIcon, roles: ["owner"], component: Settings, group: "СИСТЕМА" },
  { id: "installations", name: "Установки", icon: Server, roles: ["owner", "operator"], component: Installations, group: "СИСТЕМА" },
  { id: "audit", name: "Журнал действий", icon: ClipboardList, roles: ["owner"], component: Audit, group: "СИСТЕМА" },
];
const roleNames: Record<Role, string> = { owner: "Владелец", admin: "Администратор", master: "Мастер", stock: "Кладовщик", accountant: "Бухгалтер", operator: "Оператор", client: "Клиент" };
export default function Workspace() {
  const router = useRouter();
  const state = useWorkspace(); const [active, setActive] = useState(""); const [mobile, setMobile] = useState(false); const [localError, setLocalError] = useState("");
  if (!state.data) return <main className="ws-loading"><div className="ws-brand">SalonIt<span>STUDIO OS / 01</span></div>{state.error ? <><p role="alert">{state.error}</p><Link className="ws-button" href="/login">Войти в рабочее пространство</Link><button className="ws-button ws-secondary" onClick={() => void state.reload().catch(e => setLocalError(e.message))}>Повторить загрузку</button>{localError && <p>{localError}</p>}</> : <><div className="ws-spinner" /><p>Готовим рабочее пространство…</p></>}</main>;
  const available = sections.filter(s => s.roles.includes(state.data!.actor.role)); const current = available.find(s => s.id === active) || available[0];
  if (!current) return <main className="ws-loading"><h1>Личный кабинет</h1><Link className="ws-button" href="/portal">Перейти в кабинет клиента</Link></main>;
  const Content = current.component; const actor = state.data.actor;
  return <div className="ws-shell ws-studio"><Link className="ws-skip" href="#workspace-content">Перейти к содержимому</Link>{mobile && <button className="ws-sidebar-scrim" aria-label="Закрыть меню" onClick={() => setMobile(false)} />}<aside className={`ws-sidebar ${mobile ? "is-open" : ""}`}><div className="ws-sidebar-brand"><Link className="ws-brand" href="/">SalonIt<span>STUDIO OS / 01</span></Link><button className="ws-icon-button ws-mobile-only" onClick={() => setMobile(false)} aria-label="Закрыть меню"><X size={20} /></button></div><div className="ws-salon"><span className="ws-salon-icon"><Scissors size={20} /></span><div><strong>{state.data.settings.name}</strong><small>{state.data.settings.mode === "demo" ? "Общая демоустановка" : "Рабочее пространство"}</small></div><ChevronRight size={15} /></div><nav aria-label="Рабочее пространство">{available.map((s, i) => <div key={s.id}>{(i === 0 || available[i - 1].group !== s.group) && <p className="ws-nav-group">{s.group}</p>}<button className={`ws-nav-item ${current.id === s.id ? "is-active" : ""}`} aria-current={current.id === s.id ? "page" : undefined} onClick={() => { setActive(s.id); setMobile(false); }}><s.icon size={18} /><span>{s.name}</span>{s.id === "tasks" && state.data!.tasks.filter(t => t.status === "open").length > 0 && <small>{state.data!.tasks.filter(t => t.status === "open").length}</small>}</button></div>)}</nav><div className="ws-sidebar-foot"><Link href="/" target="_blank" rel="noreferrer">Приложение для гостей <ArrowUpRight size={16} /></Link><span>Ваш салон. Ваш ритм.</span></div></aside><div className="ws-main"><header className="ws-topbar"><div className="ws-actions"><button className="ws-icon-button ws-mobile-only" aria-label="Открыть меню" onClick={() => setMobile(true)}><Menu size={21} /></button><span className="ws-breadcrumb">Рабочее пространство <ChevronRight size={13} /> <strong>{current.name}</strong></span></div><div className="ws-actions"><Link className="ws-quick-book" href="/book"><Plus size={16} /><span>Новая запись</span></Link><button className="ws-icon-button" title="Обновить данные" aria-label="Обновить данные" disabled={state.busy} onClick={() => { setLocalError(""); void state.reload().catch(e => setLocalError(e.message)); }}><RefreshCw size={17} /></button><span className="ws-user"><span className="ws-avatar">{actor.name.split(" ").map(p => p[0]).slice(0, 2).join("")}</span><span><strong>{actor.name}</strong><small>{roleNames[actor.role]}</small></span></span><button className="ws-icon-button" aria-label="Выйти" onClick={async () => { try { const response = await fetch("/api/logout", { method: "POST" }); if (!response.ok) throw new Error("Не удалось выйти"); router.push("/login"); } catch (e) { setLocalError(e instanceof Error ? e.message : "Ошибка сети"); } }}><LogOut size={18} /></button></div></header><main id="workspace-content" className="ws-content"><div className="ws-page-heading"><div><span className="ws-eyebrow">{current.id === "overview" ? "ВАШ ДЕНЬ, В ДЕТАЛЯХ" : `STUDIO / ${roleNames[actor.role].toLocaleUpperCase("ru")}`}</span><h1>{current.id === "overview" ? "Хороший день начинается здесь" : current.name}</h1></div><span className="ws-date">{new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Moscow" })}</span></div>{(state.error || localError) && <div className="ws-error" role="alert">{state.error || localError}</div>}{state.notice && <div className="ws-success" role="status">{state.notice}</div>}<div className="ws-view" key={current.id}><Content data={state.data} command={state.command} busy={state.busy} /></div></main><footer className="ws-main-footer">SalonIt <span>Красота начинается с порядка.</span></footer></div></div>;
}
function Overview(props: SectionProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const { data } = props;
  const m = data.metrics;
  const owner = data.actor.role === "owner";
  const dayVisits = data.visits.filter(v => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v.startAt)) === today());
  const activeVisits = dayVisits.filter(v => !["cancelled", "no_show", "hold"].includes(v.status));
  const completed = activeVisits.filter(v => v.status === "completed").length;
  const inProgress = activeVisits.filter(v => v.status === "in_progress").length;
  const tasks = data.tasks.filter(t => !["done", "cancelled"].includes(t.status));
  const visit = data.visits.find(v => v.id === selected);
  const nextVisit = [...activeVisits].sort((a, b) => a.startAt.localeCompare(b.startAt)).find(v => ["confirmed", "arrived"].includes(v.status));
  return <>
    <section className="ws-dayboard" aria-label="Ритм рабочего дня">
      <div className="ws-dayboard-main">
        <div className="ws-dayboard-label"><span className="ws-live-dot" /> СЕГОДНЯ В СТУДИИ <span>01 — ДЕНЬ</span></div>
        <div className="ws-dayboard-number"><strong>{String(activeVisits.length).padStart(2, "0")}</strong><div><span>визитов<br />в вашем ритме</span><p>{completed} завершено · {inProgress} в работе</p></div></div>
        <div className="ws-dayboard-track" role="img" aria-label={`${completed} завершённых визитов из ${activeVisits.length}`}>
          {Array.from({ length: Math.max(12, Math.min(activeVisits.length, 36)) }, (_, index) => <span key={index} className={index < (activeVisits.length ? Math.round(completed / activeVisits.length * Math.max(12, Math.min(activeVisits.length, 36))) : 0) ? "is-complete" : ""} />)}
        </div>
        <div className="ws-dayboard-caption"><span>Каждый гость — отдельная история.</span><span>{activeVisits.length ? Math.round(completed / activeVisits.length * 100) : 0}% дня завершено</span></div>
      </div>
      <div className="ws-next-card"><div className="ws-next-top"><Clock3 size={18} /><span>БЛИЖАЙШИЙ ГОСТЬ</span><ArrowUpRight size={18} /></div>{nextVisit ? <button className="ws-next-visit" onClick={() => setSelected(nextVisit.id)}><span className="ws-next-time">{time(nextVisit.startAt)}</span><strong>{nextVisit.clientName}</strong><small>{nextVisit.items.filter(i => i.status !== "cancelled").map(i => i.serviceName).join(" + ")}</small><span className="ws-next-open">Открыть визит <ChevronRight size={16} /></span></button> : <div className="ws-next-empty"><span>Есть время<br />для нового.</span><p>Ожидающих гостей на сегодня пока нет.</p><Link href="/book">Записать гостя <Plus size={18} /></Link></div>}</div>
    </section>
    <div className="ws-metrics ws-overview-metrics">
      {owner ? <><Metric label="Выручка" value={money(m.revenueMinor)} note="По завершённым визитам, весь период" /><Metric label="Результат" value={money(m.resultMinor)} note="После учтённых затрат, весь период" /></> : <><Metric label="Сейчас в работе" value={inProgress} /><Metric label="Ожидают прихода" value={dayVisits.filter(v => v.status === "confirmed").length} /></>}
      <Metric label="Открытые задачи" value={tasks.length} note={`${data.complaints.filter(c => c.status === "open").length} обращений гостей`} />
      <Metric label="Записи на сегодня" value={dayVisits.length} note="Включая отменённые записи" />
    </div>
    <div className="ws-overview-grid"><section className="ws-section ws-day-agenda"><div className="ws-section-heading"><div><span className="ws-panel-index">02 / РАСПИСАНИЕ</span><h2>Сегодня в салоне</h2><p>Весь день — перед глазами</p></div><Link className="ws-button ws-secondary" href="/book">Записать гостя <Plus size={15} /></Link></div>{dayVisits.length ? <div className="ws-agenda">{[...dayVisits].sort((a, b) => a.startAt.localeCompare(b.startAt)).map(v => <button key={v.id} className="ws-agenda-row" onClick={() => setSelected(v.id)}><span className="ws-agenda-time">{time(v.startAt)}<small>{time(v.endAt)}</small></span><span><strong>{v.clientName}</strong><small>{v.items.filter(i => i.status !== "cancelled").map(i => i.serviceName).join(" + ")}</small></span><Badge value={v.status} /><ChevronRight size={16} /></button>)}</div> : <Empty>Сегодня пока нет записей. Начните день с первого гостя.</Empty>}</section>
      <div className="ws-overview-side"><section className="ws-section ws-focus-panel"><div className="ws-section-heading"><div><span className="ws-panel-index">03 / ВНИМАНИЕ</span><h2>В фокусе</h2></div><span className="ws-count-tag">{String(tasks.length).padStart(2, "0")}</span></div>{tasks.length ? tasks.slice(0, 5).map(t => <div className="ws-focus-task" key={t.id}><span className={`ws-priority-dot ${t.priority === "high" ? "is-high" : ""}`} /><div><strong>{t.name}</strong><small>{t.assignee} · до {t.dueDate}</small></div><Badge value={t.status} /></div>) : <Empty>Все задачи выполнены.</Empty>}</section>{owner && <section className="ws-section ws-control-panel"><div className="ws-section-heading"><h2>На контроле</h2><CreditCard size={19} /></div><div className="ws-finance-breakdown"><div><span>Долги клиентов</span><strong>{money(m.debtMinor)}</strong></div><div><span>Низкие остатки</span><strong>{data.materials.filter(x => x.stockMilli <= x.minStockMilli).length}</strong></div></div></section>}
      <Link className="ws-guest-entry" href="/book"><Sparkles size={20} /><span>Посмотреть глазами гостя<small>Онлайн-запись в вашу студию</small></span><ArrowUpRight size={22} /></Link></div>
    </div>{visit && <VisitDetails {...props} visit={visit} close={() => setSelected(null)} key={`${visit.id}-${visit.version}`} />}
  </>;
}
