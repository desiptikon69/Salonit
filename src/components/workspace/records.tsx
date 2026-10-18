"use client";
import { useState, type ReactNode } from "react";
import { Plus, Search, Pencil } from "lucide-react";
import { Empty, Export, RecordForm, type Field, type SectionProps } from "./common";

type Row = { id: string; [key: string]: unknown };
export interface Column { label: string; key: string; render?: (row: Row) => ReactNode; }
export function Records({ command, busy, title, subtitle, entity, action, rows, fields, columns, defaults = {}, readOnly = false, extra }: SectionProps & { title: string; subtitle?: string; entity?: string; action: string; rows: object[]; fields: Field[]; columns: Column[]; defaults?: Record<string, unknown>; readOnly?: boolean; extra?: (row: Row) => ReactNode }) {
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const visible = (rows as Row[]).filter(row => JSON.stringify(row).toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")));
  return <section className="ws-section"><div className="ws-section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><div className="ws-actions">{entity && <Export entity={entity} />}{!readOnly && <button className="ws-button" onClick={() => setEdit(defaults)}><Plus size={16} /> Добавить</button>}</div></div><div className="ws-toolbar"><label className="ws-search"><Search size={16} /><input aria-label={`Поиск: ${title}`} placeholder="Найти по имени, названию или статусу" value={query} onChange={e => setQuery(e.target.value)} /></label><span className="ws-muted">{visible.length} из {rows.length}</span></div>{visible.length ? <div className="ws-table-wrap"><table className="ws-table"><thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}{(!readOnly || extra) && <th><span className="ws-sr-only">Действия</span></th>}</tr></thead><tbody>{visible.map(row => <tr key={row.id}>{columns.map(c => <td key={c.key}>{c.render ? c.render(row) : String(row[c.key] ?? "—")}</td>)}{(!readOnly || extra) && <td><div className="ws-actions">{extra?.(row)}{!readOnly && <button className="ws-icon-button" aria-label={`Редактировать ${String(row.name ?? row.id)}`} onClick={() => setEdit(row)}><Pencil size={16} /></button>}</div></td>}</tr>)}</tbody></table></div> : <Empty>{query ? "По вашему запросу ничего не найдено." : "Здесь появятся записи. Добавьте первую."}</Empty>}{edit && <RecordForm key={String(edit.id ?? "new")} title={`${edit.id ? "Редактировать" : "Добавить"}: ${title.toLocaleLowerCase("ru")}`} initial={edit} fields={fields} busy={busy} close={() => setEdit(null)} onSave={value => command(action, value)} />}</section>;
}
export const field = (key: string, label: string, type: Field["type"] = "text", required = true, options?: Field["options"]): Field => ({ key, label, type, required, options });
export const options = (values: string[]) => values.map(value => ({ value, label: value }));
export const named = (values: { id: string; name: string }[]) => values.map(value => ({ value: value.id, label: value.name }));
export function Subnav({ items, active, onChange }: { items: string[]; active: string; onChange: (value: string) => void }) { return <div className="ws-subnav" role="tablist">{items.map(item => <button key={item} role="tab" aria-selected={active === item} className={active === item ? "is-active" : ""} onClick={() => onChange(item)}>{item}</button>)}</div>; }

