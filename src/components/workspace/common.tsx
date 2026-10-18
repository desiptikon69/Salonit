"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkspaceState } from "@/lib/contracts";

export const money = (value: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value / 100);
export const day = (value: string) => new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
export const time = (value: string) => new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const statusLabels: Record<string, string> = { planned: "Запланировано", dirty: "Требует обработки", cleaning: "Очистка", sterilizing: "Стерилизация", control: "Контроль", ready: "Готово", hold: "Ожидает подтверждения", confirmed: "Подтверждён", arrived: "Клиент пришёл", in_progress: "В работе", completed: "Завершён", cancelled: "Отменён", no_show: "Не пришёл", draft: "Черновик", approved: "Согласовано", paid: "Оплачено", open: "Открыто", done: "Выполнено", pending: "Ожидает", received: "Получено", active: "Активен", test: "Тест", queued: "В очереди", resolved: "Решено" };
export function Badge({ value }: { value: string }) { return <span className={`ws-badge ws-badge-${value}`}>{statusLabels[value] || value}</span>; }
export function Empty({ children = "Записей пока нет. Добавьте первую запись." }: { children?: ReactNode }) { return <div className="ws-empty"><span>◇</span><p>{children}</p></div>; }
export function Metric({ label, value, note }: { label: string; value: ReactNode; note?: string }) { return <div className="ws-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>; }
export type Command = (action: string, payload: unknown) => Promise<unknown>;
export interface SectionProps { data: WorkspaceState; command: Command; busy: boolean; }
export function useWorkspace() {
  const [data, setData] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  async function reload() {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Не удалось загрузить рабочее пространство");
    setData(body);
  }
  useEffect(() => { void reload().catch(e => setError(e.message)); }, []);
  const command: Command = async (action, payload) => {
    if (busy) throw new Error("Подождите завершения текущей операции");
    setBusy(true); setError(""); setNotice("");
    const key = JSON.stringify({ action, payload });
    const id = pending.current?.key === key ? pending.current.id : crypto.randomUUID();
    pending.current = { key, id };
    try {
      const response = await fetch("/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload, commandId: id }) });
      const body = await response.json();
      if (!response.ok) { if (response.status < 500) pending.current = null; throw new Error(body.error || "Не удалось сохранить изменения"); }
      pending.current = null;
      await reload();
      setNotice(action === "import.preview" ? "Предпросмотр импорта готов" : "Изменения сохранены");
      return body.result;
    } catch (e) { const message = e instanceof Error ? e.message : "Ошибка соединения. Повторите операцию."; setError(message); throw e; }
    finally { setBusy(false); }
  };
  return { data, error, notice, busy, command, reload, clearError: () => setError("") };
}
export function Dialog({ title, close, children, wide = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  return <dialog className={`ws-dialog ${wide ? "ws-dialog-wide" : ""}`} ref={ref} onCancel={e => { e.preventDefault(); close(); }}><div className="ws-dialog-head"><h2>{title}</h2><button type="button" className="ws-icon-button" onClick={close} aria-label="Закрыть">×</button></div>{children}</dialog>;
}
export type Field = { key: string; label: string; type?: "text" | "number" | "email" | "tel" | "date" | "time" | "textarea" | "checkbox" | "select" | "money" | "quantity" | "percent" | "list"; required?: boolean; options?: { value: string; label: string }[]; min?: number; hint?: string; };
export function RecordForm({ title, fields, initial = {}, onSave, close, busy }: { title: string; fields: Field[]; initial?: Record<string, unknown>; onSave: (value: Record<string, unknown>) => Promise<unknown>; close: () => void; busy: boolean }) {
  const [error, setError] = useState("");
  return <Dialog title={title} close={close}><form className="ws-form" onSubmit={async e => {
    e.preventDefault(); setError(""); const fd = new FormData(e.currentTarget); const payload = { ...initial };
    for (const f of fields) { const v = fd.get(f.key); payload[f.key] = f.type === "checkbox" ? v === "on" : f.type === "list" ? String(v || "").split(",").map(x => x.trim()).filter(Boolean) : ["number", "money", "quantity", "percent"].includes(f.type || "") ? Math.round(Number(v) * (f.type === "money" || f.type === "percent" ? 100 : f.type === "quantity" ? 1000 : 1)) : String(v ?? ""); }
    try { await onSave(payload); close(); } catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить"); }
  }}><div className="ws-fields">{fields.map(f => {
    const value = initial[f.key]; const display = f.type === "money" || f.type === "percent" ? Number(value || 0) / 100 : f.type === "quantity" ? Number(value || 0) / 1000 : Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return <label className={f.type === "textarea" ? "ws-field ws-field-full" : "ws-field"} key={f.key}><span>{f.label}{f.required && " *"}</span>{f.type === "checkbox" ? <input name={f.key} type="checkbox" defaultChecked={Boolean(value)} /> : f.type === "select" ? <select name={f.key} defaultValue={String(value ?? f.options?.[0]?.value ?? "")} required={f.required}>{f.options?.map(o => <option value={o.value} key={o.value}>{o.label}</option>)}</select> : f.type === "textarea" ? <textarea name={f.key} defaultValue={String(display)} rows={3} required={f.required} /> : <input name={f.key} type={["money", "quantity", "percent"].includes(f.type || "") ? "number" : f.type === "list" ? "text" : f.type || "text"} defaultValue={display} required={f.required} min={f.min ?? (["money", "quantity", "percent", "number"].includes(f.type || "") ? 0 : undefined)} step={f.type === "money" || f.type === "percent" ? "0.01" : f.type === "quantity" ? "0.001" : f.type === "number" ? "1" : undefined} />}{f.hint && <small>{f.hint}</small>}</label>;
  })}</div>{error && <p role="alert" className="ws-error">{error}</p>}<footer className="ws-form-footer"><button type="button" className="ws-button ws-secondary" onClick={close}>Отмена</button><button className="ws-button" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button></footer></form></Dialog>;
}
export function Export({ entity }: { entity: string }) { return <a className="ws-button ws-secondary" href={`/api/export?entity=${encodeURIComponent(entity)}`}>↓ Экспорт CSV</a>; }

