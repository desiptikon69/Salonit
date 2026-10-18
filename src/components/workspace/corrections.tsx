"use client";
import { useState } from "react";
import type { FinancialCorrection } from "@/server/financial-corrections";
import { Badge, Dialog, Empty, today, type SectionProps } from "./common";

const targets = { revenue: "Выручка", materials: "Стоимость материалов", expenses: "Прочие расходы", payroll: "Начисление мастеру" };
const amount = (value: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(value / 100);
const stamp = (value?: string) => value ? new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }) : "—";

export function Corrections(props: SectionProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [payout, setPayout] = useState<FinancialCorrection | null>(null);
  const [target, setTarget] = useState<FinancialCorrection["target"]>("revenue");
  const [sourceVisitId, setSourceVisitId] = useState("");
  const [error, setError] = useState("");
  const corrections = (props.data as typeof props.data & { financialCorrections?: FinancialCorrection[] }).financialCorrections ?? [];
  const closed = props.data.visits.filter(v => v.closedAt);
  const eligibleAccruals = props.data.accruals.filter(a => a.visitId === sourceVisitId);
  async function approve(correction: FinancialCorrection) {
    setError("");
    try { await props.command("finance.correction.approve", { id: correction.id, version: correction.version }); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось согласовать корректировку"); }
  }
  return <section className="ws-section">
    <div className="ws-section-heading"><div><h2>Связанные корректировки</h2><p>Исправление результата закрытого визита отдельной записью текущего периода</p></div><button className="ws-button" disabled={props.busy} onClick={() => { setError(""); setSourceVisitId(""); setTarget("revenue"); setCreateOpen(true); }}>Создать корректировку</button></div>
    <p className="ws-info">Исходный визит, расход материалов и начисления сохраняются. Сначала создайте запись с причиной, затем согласуйте её. Согласование отражает изменение в показателях за дату проведения. Доплату мастеру зарегистрируйте отдельно после фактической передачи денег.</p>
    {error && !createOpen && !payout && <p className="ws-error" role="alert">{error}</p>}
    {corrections.length ? <div className="ws-table-wrap"><table className="ws-table"><thead><tr><th>Источник</th><th>Изменение</th><th>Проведение</th><th>Причина и автор</th><th>Согласование</th><th>Расчёт с мастером</th><th>Действия</th></tr></thead><tbody>{corrections.map(c => <tr key={c.id}>
      <td><strong>{c.sourceReference}</strong><br /><small>Исходный период: {c.sourcePeriod}</small><br /><small>Исходная сумма: {amount(c.sourceAmountMinor)}</small>{c.staffName && <><br /><span>{c.staffName}</span></>}</td>
      <td>{targets[c.target]}<br /><strong>{c.deltaMinor > 0 ? "+" : ""}{amount(c.deltaMinor)}</strong></td>
      <td>{c.postingDate}<br /><Badge value={c.status} /></td>
      <td>{c.reason}<br /><small>{c.createdBy} · {stamp(c.createdAt)}</small></td>
      <td>{c.approvedBy ? <>{c.approvedBy}<br /><small>{stamp(c.approvedAt)}</small></> : "Ожидает согласования"}</td>
      <td>{c.target !== "payroll" ? "Денежная выплата не предусмотрена" : c.deltaMinor < 0 ? <><strong>Требует отдельного рассмотрения зачёта</strong><br /><small>Автоматического удержания и уменьшения гарантии нет.</small></> : c.status === "paid" ? <>{amount(c.deltaMinor)}<br /><small>{c.paidBy} · {stamp(c.paidAt)}<br />{c.externalReference}</small></> : "Доплата ещё не зарегистрирована"}</td>
      <td><div className="ws-actions">{c.status === "draft" && <button className="ws-button ws-secondary" disabled={props.busy} onClick={() => void approve(c)}>Согласовать</button>}{c.status === "approved" && c.target === "payroll" && c.deltaMinor > 0 && <button className="ws-button" disabled={props.busy} onClick={() => { setError(""); setPayout(c); }}>Зарегистрировать доплату</button>}</div></td>
    </tr>)}</tbody></table></div> : <Empty>Корректировок пока нет. Для исправления закрытого визита создайте связанную запись.</Empty>}
    {createOpen && <Dialog title="Новая связанная корректировка" close={() => setCreateOpen(false)}><form className="ws-form" onSubmit={async e => {
      e.preventDefault(); setError(""); const fd = new FormData(e.currentTarget); const value = Number(fd.get("delta")); const deltaMinor = Math.round(value * 100);
      if (!Number.isFinite(value) || !Number.isSafeInteger(deltaMinor) || deltaMinor === 0) { setError("Введите ненулевое изменение суммы"); return; }
      try { await props.command("finance.correction.create", { sourceVisitId, target, ...(target === "payroll" ? { sourceAccrualId: String(fd.get("sourceAccrualId")) } : {}), deltaMinor, postingDate: String(fd.get("postingDate")), reason: String(fd.get("reason")) }); setCreateOpen(false); }
      catch (e) { setError(e instanceof Error ? e.message : "Не удалось создать корректировку"); }
    }}>
      <label className="ws-field">Закрытый визит<select required value={sourceVisitId} onChange={e => setSourceVisitId(e.target.value)}><option value="">Выберите исходный визит</option>{closed.map(v => <option key={v.id} value={v.id}>{v.reference} · {v.clientName} · {v.startAt.slice(0, 10)}</option>)}</select></label>
      <label className="ws-field">Что корректируем<select value={target} onChange={e => setTarget(e.target.value as FinancialCorrection["target"])}>{Object.entries(targets).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      {target === "payroll" && <label className="ws-field">Исходное начисление<select name="sourceAccrualId" required key={sourceVisitId}><option value="">Выберите начисление</option>{eligibleAccruals.map(a => <option key={a.id} value={a.id}>{a.staffName} · {a.serviceName} · {amount(a.amountMinor)}</option>)}</select></label>}
      <div className="ws-fields"><label className="ws-field">Изменение, ₽<input name="delta" type="number" step="0.01" required placeholder="Например, -500 или 1200" /><small>Плюс увеличивает выбранный показатель, минус уменьшает.</small></label><label className="ws-field">Дата проведения<input name="postingDate" type="date" min={`${today().slice(0, 7)}-01`} max={today()} defaultValue={today()} required /></label></div>
      <label className="ws-field">Причина<textarea name="reason" required minLength={3} maxLength={500} rows={3} /></label>
      {target === "payroll" && <p className="ws-info">Положительная корректировка требует отдельной доплаты. Отрицательная передаётся на рассмотрение зачёта и автоматически не удерживается из зарплаты или гарантии.</p>}
      {error && <p role="alert" className="ws-error">{error}</p>}<footer className="ws-form-footer"><button type="button" className="ws-button ws-secondary" onClick={() => setCreateOpen(false)}>Отмена</button><button className="ws-button" disabled={props.busy || !closed.length}>Создать черновик</button></footer>
    </form></Dialog>}
    {payout && <Dialog title="Регистрация фактической доплаты" close={() => setPayout(null)}><form className="ws-form" onSubmit={async e => {
      e.preventDefault(); setError(""); const fd = new FormData(e.currentTarget);
      try { await props.command("finance.correction.payout", { id: payout.id, version: payout.version, method: String(fd.get("method")), externalReference: String(fd.get("externalReference")) }); setPayout(null); }
      catch (e) { setError(e instanceof Error ? e.message : "Не удалось зарегистрировать доплату"); }
    }}><p><strong>{payout.staffName} · {amount(payout.deltaMinor)}</strong></p><p className="ws-info">Подтвердите уже выполненный расчёт. SalonIt регистрирует факт доплаты; деньги передаются через банк или кассу салона.</p><label className="ws-field">Способ расчёта<select name="method"><option value="card">Банковский перевод</option><option value="sbp">СБП</option><option value="cash">Наличные</option></select></label><label className="ws-field">Номер документа или пояснение<input name="externalReference" required minLength={3} maxLength={500} placeholder="Платёжное поручение или расходный документ" /></label>{error && <p role="alert" className="ws-error">{error}</p>}<footer className="ws-form-footer"><button type="button" className="ws-button ws-secondary" onClick={() => setPayout(null)}>Отмена</button><button className="ws-button" disabled={props.busy}>Доплата выполнена — зарегистрировать</button></footer></form></Dialog>}
  </section>;
}
