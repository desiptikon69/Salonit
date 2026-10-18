"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CatalogData, Service, Slot, Visit } from "@/lib/contracts";
import { api, Arrow, dateLabel, Loading, message, money, Notice, PublicShell, time, today, useRemote } from "./shared";

type Hold = { holdId: string; holdToken: string; expiresAt: string; totalMinor: number };
type Draft = { ids: string[]; mode: "parallel" | "sequential"; staffId: string; date: string; name: string; phone: string };
const draftKey = "salonit.booking.draft";
function compatibleStaff(catalog: CatalogData, staffId: string, ids: string[]) {
  const member = catalog.staff.find(person => person.id === staffId && person.active);
  // Both scheduling modes pin the preferred specialist to at least one suitable service.
  return member && (!ids.length || ids.some(id => catalog.services.some(service => service.id === id && service.active && member.skills.includes(service.skill)))) ? member.id : "";
}
function save(key: string, value: unknown) { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be disabled; booking still works. */ } }
function read(key: string): unknown { try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; } }

export default function Booking() {
  const { data, error: catalogError, loading, reload } = useRemote<CatalogData>("/api/catalog");
  const [draft, setDraft] = useState<Draft>({ ids: [], mode: "sequential", staffId: "", date: today(), name: "", phone: "" });
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState("Все услуги");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsRevision, setSlotsRevision] = useState(0);
  const [hold, setHold] = useState<Hold | null>(null);
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [newAccessKey, setNewAccessKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [visit, setVisit] = useState<Visit | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!data || ready) return;
    const stored = read(draftKey) as Partial<Draft> | null;
    const params = new URLSearchParams(window.location.search);
    const bundle = data.bundles.find(item => item.id === params.get("bundle"));
    const requested = bundle?.serviceIds ?? params.get("services")?.split(",");
    const ids = [...new Set(requested ?? (Array.isArray(stored?.ids) ? stored.ids : []))].filter(id => typeof id === "string" && data.services.some(service => service.id === id && service.active));
    setDraft({ ids, mode: bundle?.mode ?? (stored?.mode === "parallel" ? "parallel" : "sequential"), staffId: compatibleStaff(data, params.get("staff") ?? (typeof stored?.staffId === "string" ? stored.staffId : ""), ids), date: typeof stored?.date === "string" && stored.date >= today() ? stored.date : today(), name: typeof stored?.name === "string" ? stored.name : "", phone: typeof stored?.phone === "string" ? stored.phone : "" });
    const saved = read("salonit.booking.hold") as Hold | null;
    if (!requested && !params.has("staff") && saved?.holdId && saved.holdToken && Date.parse(saved.expiresAt) > Date.now()) { setHold(saved); setStep(4); }
    else save("salonit.booking.hold", null);
    setReady(true);
  }, [data, ready]);
  useEffect(() => { if (ready) save(draftKey, draft); }, [draft, ready]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { heading.current?.focus(); }, [step, visit]);
  useEffect(() => {
    if (step !== 2 || !draft.ids.length) return;
    let active = true;
    setSlotsLoading(true); setError(""); setSlot(null); setSlots([]);
    const query = new URLSearchParams({ date: draft.date, services: draft.ids.join(","), mode: draft.mode });
    if (draft.staffId) query.set("staffId", draft.staffId);
    api<{ slots: Slot[] }>(`/api/booking/slots?${query}`).then(result => { if (active) setSlots(result.slots); }).catch(reason => { if (active) setError(message(reason)); }).finally(() => { if (active) setSlotsLoading(false); });
    return () => { active = false; };
  }, [draft.date, draft.ids, draft.mode, draft.staffId, step, slotsRevision]);
  const selected = draft.ids.map(id => data?.services.find(service => service.id === id && service.active)).filter((service): service is Service => Boolean(service));
  const total = selected.reduce((sum, service) => sum + service.priceMinor, 0);
  const duration = draft.mode === "parallel" ? Math.max(0, ...selected.map(service => service.durationMinutes)) : selected.reduce((sum, service) => sum + service.durationMinutes, 0);
  const remaining = hold ? Math.max(0, Math.ceil((Date.parse(hold.expiresAt) - now) / 1000)) : 0;
  const people = data?.staff.filter(person => person.active && selected.some(service => person.skills.includes(service.skill))) ?? [];
  function update(patch: Partial<Draft>) {
    setDraft(value => {
      const next = { ...value, ...patch };
      return { ...next, staffId: data ? compatibleStaff(data, next.staffId, next.ids) : "" };
    });
    setSlot(null); setError("");
  }
  async function requestCode() {
    setBusy(true); setError("");
    try { const result = await api<{ demoCode?: string }>("/api/booking/otp", { phone: draft.phone }); setDemoCode(result.demoCode ?? ""); }
    catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  async function reserve() {
    if (!slot) return;
    setBusy(true); setError("");
    try {
      const result = await api<Hold>("/api/booking/hold", { serviceIds: draft.ids, mode: draft.mode, startAt: slot.startAt, ...(draft.staffId ? { staffId: draft.staffId } : {}), name: draft.name.trim(), phone: draft.phone });
      setHold(result); save("salonit.booking.hold", result); setStep(4);
      const otp = await api<{ demoCode?: string }>("/api/booking/otp", { phone: draft.phone }); setDemoCode(otp.demoCode ?? "");
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!hold) return;
    setBusy(true); setError("");
    try { const result = await api<{ visit: Visit; accessKey?: string }>("/api/booking/confirm", { holdId: hold.holdId, holdToken: hold.holdToken, phone: draft.phone, code, ...(accessKey.trim() ? { accessKey: accessKey.trim() } : {}) }); setVisit(result.visit); setNewAccessKey(result.accessKey ?? ""); setAccessKey(""); save("salonit.booking.hold", null); save(draftKey, null); }
    catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  function chooseAgain() { setHold(null); save("salonit.booking.hold", null); setCode(""); setDemoCode(""); setError(""); setStep(2); }
  const categories = [...new Set(data?.services.filter(service => service.active).map(service => service.category) ?? [])];
  const titles = ["Ваш личный план.", "Найдём своего мастера.", "Время — ваше.", "Будем знакомы.", "Почти готово."];
  return <PublicShell compact><main className="book-page">
    <div className="book-page-heading"><div><div className="pub-eyebrow"><span />КОНСТРУКТОР ВИЗИТА / SALONIT</div><h1 ref={heading} tabIndex={-1}>{visit ? "До встречи в студии." : titles[step]}</h1></div><div className="book-stage-mark" aria-hidden="true"><span>{visit ? "✓" : String(step + 1).padStart(2, "0")}</span><small>{visit ? "ГОТОВО" : "/ 05"}</small></div></div>
    {catalogError && <Notice>{catalogError} <button onClick={reload}>Повторить</button></Notice>}
    {loading && !data ? <Loading /> : visit ? <section className="book-success"><div className="book-success-mark">✓</div><span className="pub-eyebrow">ЗАПИСЬ ПОДТВЕРЖДЕНА</span><h2>{dateLabel(visit.startAt)}, {time(visit.startAt)}</h2><p>Номер записи {visit.reference}. Данные сохранены в вашем личном кабинете.</p><div className="book-success-services">{visit.items.map(item => <p key={item.id}>{item.serviceName} <span>{item.staffName} · {time(item.startAt)}</span></p>)}</div><strong>{money(visit.totalMinor)}</strong>{newAccessKey && <Notice kind="info"><strong>Сохраните личный ключ доступа</strong><p>Он понадобится для входа с нового устройства. Показываем его только сейчас. Не передавайте ключ другим людям. При утрате обратитесь к администратору салона.</p><label className="pub-field">Ваш ключ<input readOnly value={newAccessKey} autoComplete="off" onFocus={event => event.target.select()} /></label><button type="button" className="pub-inline-button" onClick={() => { void navigator.clipboard?.writeText(newAccessKey); }}>Скопировать ключ</button></Notice>}<Link href="/account" className="pub-button">Мои записи <Arrow /></Link></section> : data && ready && <>
      <ol className="book-progress">{["Услуги", "Мастер", "Время", "Контакты", "Подтверждение"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} className={step === index ? "book-current" : step > index ? "book-done" : ""}><span>{step > index ? "✓" : index + 1}</span>{label}</li>)}</ol>
      <div className="book-layout"><section key={step} className="book-panel" aria-busy={busy}>
        {error && <Notice>{error}</Notice>}
        {step === 0 && <><div className="book-panel-heading"><p className="book-lead">Красота складывается из деталей.<br />Выберите свои.</p><span className="book-selection-count" aria-live="polite">Выбрано: {selected.length}</span></div><div className="book-bundle-picks">{data.bundles.map(bundle => <button key={bundle.id} aria-pressed={bundle.mode === draft.mode && bundle.serviceIds.length === draft.ids.length && bundle.serviceIds.every(id => draft.ids.includes(id))} onClick={() => update({ ids: bundle.serviceIds, mode: bundle.mode })}><span>СОБРАЛИ ЗА ВАС <Arrow diagonal /></span>{bundle.name}<small>{bundle.mode === "parallel" ? "Одновременно" : "Друг за другом"}</small></button>)}</div><div className="book-category-tabs" aria-label="Категории услуг">{["Все услуги", ...categories].map(category => <button key={category} type="button" aria-pressed={categoryFilter === category} onClick={() => setCategoryFilter(category)}>{category}</button>)}</div>{categories.filter(category => categoryFilter === "Все услуги" || categoryFilter === category).map(category => <div key={category} className="book-service-group"><h2><span>{String(categories.indexOf(category) + 1).padStart(2, "0")}</span>{category}</h2>{data.services.filter(service => service.active && service.category === category).map(service => <label key={service.id} className={`book-service-option ${draft.ids.includes(service.id) ? "book-selected" : ""}`}><input type="checkbox" checked={draft.ids.includes(service.id)} onChange={() => update({ ids: draft.ids.includes(service.id) ? draft.ids.filter(id => id !== service.id) : [...draft.ids, service.id] })} /><span><strong>{service.name}</strong><small>{service.description}</small></span><span className="book-option-price">{money(service.priceMinor)}<small>{service.durationMinutes} мин</small></span><span className="book-option-toggle" aria-hidden="true">{draft.ids.includes(service.id) ? "✓" : "+"}</span></label>)}</div>)}{selected.length > 1 && <fieldset className="book-mode"><legend>Как объединить услуги</legend><label><input type="radio" name="mode" checked={draft.mode === "sequential"} onChange={() => update({ mode: "sequential" })} />Друг за другом</label><label><input type="radio" name="mode" checked={draft.mode === "parallel"} onChange={() => update({ mode: "parallel" })} />Одновременно</label><p>Доступность сочетания проверим по мастерам и рабочим местам.</p></fieldset>}</>}
        {step === 1 && <><p className="book-lead">Выберите специалиста или оставьте подбор нам.</p><div className="book-staff-grid"><label className={`book-staff-option ${!draft.staffId ? "book-selected" : ""}`}><input type="radio" name="staff" checked={!draft.staffId} onChange={() => update({ staffId: "" })} /><span className="book-avatar">✳</span><strong>Любой подходящий</strong><small>Больше свободного времени</small></label>{people.map(person => <label key={person.id} className={`book-staff-option ${draft.staffId === person.id ? "book-selected" : ""}`}><input type="radio" name="staff" checked={draft.staffId === person.id} onChange={() => update({ staffId: person.id })} /><span className="book-avatar">{person.initials}</span><strong>{person.name}</strong><small>{person.title}</small></label>)}</div><p className="pub-data-note">При нескольких услугах система проверит навыки и подберёт остальных участников визита.</p></>}
        {step === 2 && <><label className="pub-field">Дата визита<input type="date" value={draft.date} min={today()} onChange={event => update({ date: event.target.value })} required /></label><p className="book-lead">Время студии: Москва (UTC+3). Длительность включает выбранные услуги.</p>{slotsLoading ? <Loading text="Проверяем расписание мастеров…" /> : <><div className="book-slots">{slots.map(item => <button key={item.startAt} className={slot?.startAt === item.startAt ? "book-slot book-selected" : "book-slot"} aria-pressed={slot?.startAt === item.startAt} onClick={() => { setSlot(item); setError(""); }}><strong>{time(item.startAt)}</strong><small>до {time(item.endAt)}</small></button>)}</div>{!slots.length && !error && <div className="pub-empty"><h3>На этот день времени нет</h3><p>Попробуйте другую дату, любого мастера или последовательный режим услуг.</p></div>}<button className="pub-inline-button" onClick={() => setSlotsRevision(value => value + 1)}>Обновить свободное время</button></>}{slot && <Notice kind="info">{slot.staffNames.join(" · ")}<br />{dateLabel(slot.startAt)}, {time(slot.startAt)}–{time(slot.endAt)}</Notice>}</>}
        {step === 3 && <form id="book-contact" onSubmit={event => { event.preventDefault(); void reserve(); }}><p className="book-lead">Укажем контакты в записи и подтвердим телефон одноразовым кодом.</p><label className="pub-field">Как к вам обращаться<input autoComplete="name" minLength={2} maxLength={100} value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} placeholder="Ваше имя" required disabled={busy} /></label><label className="pub-field">Номер телефона<input type="tel" autoComplete="tel" value={draft.phone} onChange={event => setDraft(value => ({ ...value, phone: event.target.value }))} placeholder="+7 999 123-45-67" minLength={10} maxLength={24} required disabled={busy} /></label><p className="pub-data-note">Контакты используются для создания записи и входа в кабинет. Это общая демонстрация — используйте тестовые данные.</p></form>}
        {step === 4 && <form id="book-confirm" onSubmit={event => { event.preventDefault(); void confirm(); }}><p className="book-lead">Код для номера <strong>{draft.phone}</strong></p>{remaining > 0 ? <Notice kind="info">Время удерживается ещё {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}. Доступность окончательно подтверждается сервером.</Notice> : <Notice>Время удержания истекло. Выберите свободный слот снова.</Notice>}{demoCode && <Notice kind="info">Демонстрационный код: <strong className="book-otp-code">{demoCode}</strong></Notice>}<label className="pub-field">Код подтверждения<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} required disabled={busy || !remaining} placeholder="6 цифр" /></label><label className="pub-field">Личный ключ доступа (для нового устройства)<input type="password" autoComplete="off" value={accessKey} onChange={event => setAccessKey(event.target.value)} disabled={busy || !remaining} placeholder="При первой записи оставьте пустым" maxLength={200} /></label><p className="pub-data-note">Одного кода из SMS недостаточно для открытия истории с нового устройства. Введите сохранённый личный ключ. Если ключ потерян, администратор салона проверит владельца и восстановит доступ.</p><button type="button" className="pub-inline-button" disabled={busy || !remaining} onClick={() => void requestCode()}>Получить новый код</button><button type="button" className="pub-inline-button" disabled={busy} onClick={chooseAgain}>Выбрать другое время</button></form>}
        <div className="book-navigation">{step > 0 && step < 4 && <button className="pub-button pub-button-ghost" disabled={busy} onClick={() => { setError(""); setStep(value => value - 1); }}>Назад</button>}{step < 3 && <button className="pub-button" disabled={busy || (step === 0 && !selected.length) || (step === 2 && !slot)} onClick={() => { setError(""); setStep(value => value + 1); }}>Продолжить <Arrow /></button>}{step === 3 && <button type="submit" form="book-contact" className="pub-button" disabled={busy}>{busy ? "Сохраняем время…" : "Получить код"}<Arrow /></button>}{step === 4 && <button type="submit" form="book-confirm" className="pub-button" disabled={busy || !remaining || code.length !== 6}>{busy ? "Подтверждаем…" : "Подтвердить запись"}<Arrow /></button>}</div>
      </section><aside className="book-summary"><div className="book-ticket-top"><div className="pub-eyebrow">ВАШ ВИЗИТ</div><span aria-hidden="true">↗</span></div><h2>Хороший<br />выбор.</h2><span className="book-ticket-label">SALONIT / PERSONAL PLAN</span>{selected.length ? selected.map(service => <div className="book-summary-line" key={service.id}><span>{service.name}</span><strong>{money(service.priceMinor)}</strong></div>) : <p>Выберите услуги — здесь появится ваш план визита.</p>}<div className="book-summary-total"><span>Итого</span><strong>{money(slot?.priceMinor ?? total)}</strong></div><p>{duration ? `Около ${duration} мин · ${draft.mode === "parallel" ? "одновременно" : "последовательно"}` : "Длительность зависит от услуг"}</p>{slot && <div className="book-summary-date">{dateLabel(slot.startAt)}<strong>{time(slot.startAt)}–{time(slot.endAt)}</strong></div>}<div className="book-summary-note"><span className="book-ticket-barcode" aria-hidden="true" /><span>Ваше время.<br />Ваши правила.</span></div></aside></div>
    </>}
  </main></PublicShell>;
}

