"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PortalState, Slot, Visit, VisitStatus } from "@/lib/contracts";
import { api, Arrow, dateLabel, Loading, message, money, Notice, PublicShell, time, today, useRemote } from "./shared";

const statuses: Record<VisitStatus, string> = { hold: "Ожидает подтверждения", confirmed: "Запись подтверждена", arrived: "Вы в студии", in_progress: "Идёт визит", completed: "Визит завершён", cancelled: "Отменено", no_show: "Визит пропущен" };
export default function Account() {
  const router = useRouter();
  const { data, error, loading, reload } = useRemote<PortalState>("/api/portal");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<{ visit: Visit; action: "move" | "cancel" | "feedback" } | null>(null);
  const [date, setDate] = useState(today());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [feedback, setFeedback] = useState("");
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneChange, setPhoneChange] = useState<{ changeId: string; phone: string; demoCode?: string } | null>(null);
  const [phoneError, setPhoneError] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  async function changePhone(event: React.FormEvent) {
    event.preventDefault(); setPhoneBusy(true); setPhoneError("");
    try {
      if (!phoneChange) {
        const result = await api<{ changeId: string; phone: string; demoCode?: string }>("/api/account/phone/otp", { phone: newPhone });
        setPhoneChange(result); setPhoneCode("");
      } else {
        await api("/api/account/phone/confirm", { changeId: phoneChange.changeId, code: phoneCode });
        setPhoneOpen(false); setPhoneChange(null); setNewPhone(""); setPhoneCode("");
        setNotice("Телефон изменён. Ваши записи и личный ключ доступа сохранены."); reload();
      }
    } catch (reason) { setPhoneError(message(reason)); } finally { setPhoneBusy(false); }
  }
  const [subject, setSubject] = useState("Обратная связь о визите");
  useEffect(() => {
    if (!active || active.action !== "move") return;
    let alive = true;
    setSlotsLoading(true); setSlots([]); setSelected(""); setActionError("");
    const visit = active.visit;
    const remaining = visit.items.filter(item => item.status !== "cancelled");
    const parallel = remaining.length > 1 && remaining.every(item => item.startAt === remaining[0].startAt);
    const query = new URLSearchParams({ date, services: remaining.map(item => item.serviceId).join(","), mode: parallel ? "parallel" : "sequential", visitId: visit.id });
    api<{ slots: Slot[] }>(`/api/booking/slots?${query}`).then(result => { if (alive) setSlots(result.slots); }).catch(reason => { if (alive) setActionError(message(reason)); }).finally(() => { if (alive) setSlotsLoading(false); });
    return () => { alive = false; };
  }, [date, active]);
  async function command(action: string, payload: unknown, success: string) {
    setBusy(true); setActionError(""); setNotice("");
    try { await api("/api/commands", { action, payload, commandId: crypto.randomUUID() }); setActive(null); setNotice(success); reload(); }
    catch (reason) { setActionError(message(reason)); } finally { setBusy(false); }
  }
  function open(visit: Visit, action: "move" | "cancel" | "feedback") { setActive({ visit, action }); setDate(today()); setActionError(""); setNotice(""); setFeedback(""); }
  const upcoming = data?.visits.filter(visit => ["hold", "confirmed", "arrived", "in_progress"].includes(visit.status)).sort((a, b) => a.startAt.localeCompare(b.startAt)) ?? [];
  const past = data?.visits.filter(visit => !["hold", "confirmed", "arrived", "in_progress"].includes(visit.status)).sort((a, b) => b.startAt.localeCompare(a.startAt)) ?? [];
  function visitCard(visit: Visit) {
    const editable = visit.status === "confirmed" && new Date(visit.startAt).getTime() > now;
    return <article className="portal-visit" key={visit.id}><div className="portal-visit-rail" aria-hidden="true"><span>{new Intl.DateTimeFormat("ru-RU", { day: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(visit.startAt))}</span><small>{new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "Europe/Moscow" }).format(new Date(visit.startAt))}</small></div><div className="portal-visit-content"><div className="portal-visit-top"><span className={`portal-status portal-status-${visit.status}`}>{statuses[visit.status]}</span><span>№ {visit.reference}</span></div><h3>{dateLabel(visit.startAt)} <span>{time(visit.startAt)}</span></h3><div className="portal-items">{visit.items.map(item => <div key={item.id}><strong>{item.serviceName}{item.status === "cancelled" ? " · Отменено" : ""}</strong><span>{item.staffName} · {time(item.startAt)}–{time(item.endAt)}</span></div>)}</div><div className="portal-visit-bottom"><strong>{money(visit.totalMinor)}</strong><span>{visit.paidMinor > 0 ? `Оплачено ${money(visit.paidMinor)}` : "Оплата в студии"}</span></div><div className="portal-actions">{visit.status === "completed" && <Link className="pub-text-link" href={"/book?services="+encodeURIComponent(visit.items.filter(i=>i.status!=="cancelled").map(i=>i.serviceId).join(","))}>Повторить запись <Arrow /></Link>}{editable && <><button onClick={() => open(visit, "move")}>Перенести</button><button onClick={() => open(visit, "cancel")}>Отменить запись</button></>}{visit.status === "completed" && <button onClick={() => open(visit, "feedback")}>Оставить обратную связь <Arrow diagonal /></button>}</div>{active?.visit.id === visit.id && <section className="portal-action-form" aria-label="Изменение записи">
      {actionError && <Notice>{actionError}</Notice>}
      {active.action === "cancel" && <><h4>Отменить этот визит?</h4><p>Время станет доступно другим гостям. Вы сможете создать новую запись.</p><button className="pub-button pub-button-danger" disabled={busy} onClick={() => void command("visit.status", { id: visit.id, status: "cancelled", version: visit.version }, "Запись отменена.")}>{busy ? "Отменяем…" : "Да, отменить запись"}</button></>}
      {active.action === "move" && <><h4>Новое время визита</h4><label className="pub-field">Дата<input type="date" value={date} min={today()} disabled={busy} onChange={event => setDate(event.target.value)} /></label>{slotsLoading ? <Loading text="Ищем свободное время…" /> : <div className="book-slots">{slots.map(slot => <button key={slot.startAt} className={selected === slot.startAt ? "book-slot book-selected" : "book-slot"} onClick={() => setSelected(slot.startAt)} disabled={busy}><strong>{time(slot.startAt)}</strong><small>до {time(slot.endAt)}</small></button>)}</div>}{!slotsLoading && !slots.length && !actionError && <p>Свободного времени нет. Выберите другую дату.</p>}<p className="pub-data-note">Время московское. При сохранении система повторно проверит занятость.</p><button className="pub-button" disabled={busy || !selected} onClick={() => void command("visit.move", { id: visit.id, startAt: selected, version: visit.version }, "Запись перенесена. Новое время показано в карточке.")}>{busy ? "Переносим…" : "Сохранить новое время"}</button></>}
      {active.action === "feedback" && <form onSubmit={event => { event.preventDefault(); void command("complaint.save", { name: subject, clientId: data?.client.id, visitId: visit.id, reason: feedback, assignee: "", status: "open", dueDate: today(), resolution: "" }, "Обратная связь сохранена. Администратор увидит ваше обращение."); }}><h4>Как прошёл визит?</h4><label className="pub-field">Тема<select value={subject} onChange={event => setSubject(event.target.value)} disabled={busy}><option>Обратная связь о визите</option><option>Благодарность мастеру</option><option>Проблема с услугой</option><option>Предложение</option></select></label><label className="pub-field">Ваше сообщение<textarea minLength={5} maxLength={3000} required value={feedback} onChange={event => setFeedback(event.target.value)} disabled={busy} placeholder="Что понравилось или что нам стоит улучшить?" rows={4} /></label><button className="pub-button" disabled={busy}>{busy ? "Сохраняем…" : "Отправить обратную связь"}</button></form>}
      <button className="pub-inline-button" disabled={busy} onClick={() => setActive(null)}>Закрыть</button>
    </section>}</div></article>;
  }
  return <PublicShell compact><main className="portal-page"><div className="portal-heading"><div><div className="pub-eyebrow"><span />ВАШЕ ПРОСТРАНСТВО / SALONIT</div><h1>{data ? `Здравствуйте, ${data.client.name.split(" ")[0]}.` : "Ваше пространство."}</h1><p>Все ваши бьюти-планы. В одном месте.</p></div>{data && <button className="pub-inline-button" disabled={busy} onClick={async () => { setBusy(true); try { await api("/api/logout", {}); router.push("/login"); } catch (reason) { setActionError(message(reason)); setBusy(false); } }}>Выйти</button>}</div>
    {notice && <Notice kind="success">{notice}</Notice>}{actionError && !active && <Notice>{actionError}</Notice>}
    {loading && !data && <Loading text="Загружаем ваши записи…" />}
    {error && <div className="portal-access"><Notice>{error}</Notice><p>Войдите в демонстрационный кабинет или подтвердите новую запись по телефону.</p><Link href="/login" className="pub-button">Войти в кабинет <Arrow /></Link><button className="pub-inline-button" onClick={reload}>Повторить загрузку</button></div>}
    {data && <><div className="portal-overview"><div><span>В планах</span><strong>{String(upcoming.length).padStart(2, "0")}<small> визитов</small></strong></div><div><span>Уже в истории</span><strong>{String(past.length).padStart(2, "0")}<small> визитов</small></strong></div><Link href="/book"><span>Время для нового</span><strong>Собрать визит <Arrow diagonal /></strong></Link></div><div className="portal-layout"><div><div className="portal-section-title"><h2>Ближайшие визиты</h2><Link className="pub-text-link" href="/book">Новая запись <Arrow /></Link></div>{upcoming.length ? upcoming.map(visitCard) : <div className="pub-empty"><h3>Пока никаких планов</h3><p>Выберите время, которое оставите только для себя.</p><Link className="pub-button" href="/book">Выбрать услугу <Arrow /></Link></div>}<div className="portal-section-title"><h2>История посещений</h2><span>{past.length} визитов</span></div>{past.length ? past.map(visitCard) : <p className="pub-empty">Завершённые и отменённые визиты появятся здесь.</p>}</div><aside className="portal-sidebar"><section className="portal-profile"><span className="book-avatar">{data.client.name.charAt(0)}</span><h3>{data.client.name}</h3><p>{data.client.phone}</p><span className="pub-data-note">Личная карта / SalonIt</span><button className="pub-inline-button" disabled={phoneBusy} onClick={() => { setPhoneOpen(!phoneOpen); setPhoneError(""); }}>Изменить телефон</button>{phoneOpen && <form onSubmit={changePhone} className="portal-action-form"><h4>Новый телефон</h4>{phoneError && <Notice>{phoneError}</Notice>}{!phoneChange ? <label className="pub-field">Номер телефона<input type="tel" autoComplete="tel" placeholder="+7 900 000-00-00" required value={newPhone} disabled={phoneBusy} onChange={event => setNewPhone(event.target.value)} /></label> : <><p>Код для {phoneChange.phone}</p>{phoneChange.demoCode && <Notice kind="info">Демонстрационный код: <strong>{phoneChange.demoCode}</strong>. SMS не отправляется.</Notice>}<label className="pub-field">Код подтверждения<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={phoneCode} disabled={phoneBusy} onChange={event => setPhoneCode(event.target.value.replace(/\D/g, ""))} /></label><button type="button" className="pub-inline-button" disabled={phoneBusy} onClick={() => { setPhoneChange(null); setPhoneCode(""); }}>Другой номер или новый код</button></>}<p className="pub-data-note">Сохраняется ваш профиль и история посещений. Личный ключ доступа продолжит действовать.</p><button className="pub-button pub-button-small" disabled={phoneBusy}>{phoneBusy ? "Сохраняем…" : phoneChange ? "Подтвердить номер" : "Получить код"}</button></form>}</section><section className="portal-certificates"><div className="pub-eyebrow">ПОДАРКИ И УХОД</div><h2>Ваши сертификаты</h2>{data.certificates.length ? data.certificates.map(certificate => <div className="portal-certificate" key={certificate.id}><span>{certificate.kind === "package" ? "Абонемент" : "Подарочный сертификат"}</span><strong>{money(certificate.balanceMinor)}</strong><code>{certificate.code}</code><small>{certificate.status === "active" ? "Действует" : certificate.status === "used" ? "Использован" : certificate.status === "expired" ? "Срок истёк" : certificate.status}{certificate.unitsRemaining !== undefined && ` · Осталось посещений: ${certificate.unitsRemaining}`}</small></div>) : <p>Пока нет сертификатов. После оформления они появятся здесь.</p>}</section><section className="portal-recommendations"><span className="pub-eyebrow">С ЗАБОТОЙ О ВАС</span><h2>На заметку</h2>{data.recommendations.length ? <ul>{data.recommendations.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>Рекомендации появятся после посещения студии.</p>}</section></aside></div></>}
  </main></PublicShell>;
}



