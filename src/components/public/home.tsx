"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, ArrowUpRight, Check, Heart, Layers3, Minus, Plus, Search, Scissors, Sparkles, X } from "lucide-react";
import type { CatalogData } from "@/lib/contracts";
import { Loading, money, Notice, PublicShell, useRemote } from "./shared";

const selectionKey = "salonit.discovery.selection";
const favoritesKey = "salonit.discovery.favorites";
const categoryLabels = ["Все услуги", "Волосы", "Ногти", "Брови и ресницы", "Макияж", "Уход"];
function storedIds(key: string): string[] {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(key) || "[]"); return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : []; }
  catch { return []; }
}
function storeIds(key: string, ids: string[]) {
  try { sessionStorage.setItem(key, JSON.stringify(ids)); } catch { /* The catalog remains usable when storage is disabled. */ }
}

export default function Home() {
  const { data, loading, error, reload } = useRemote<CatalogData>("/api/catalog");
  const reducedMotion = useReducedMotion();
  const [category, setCategory] = useState("Все услуги");
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [restored, setRestored] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!data || restored) return;
    const active = new Set(data.services.filter(service => service.active).map(service => service.id));
    setSelectedIds(storedIds(selectionKey).filter(id => active.has(id)).slice(0, 6));
    setFavoriteIds(storedIds(favoritesKey).filter(id => active.has(id)));
    setRestored(true);
  }, [data, restored]);
  useEffect(() => { if (restored) storeIds(selectionKey, selectedIds); }, [selectedIds, restored]);
  useEffect(() => { if (restored) storeIds(favoritesKey, favoriteIds); }, [favoriteIds, restored]);
  const services = data?.services.filter(service => service.active) ?? [];
  const selected = selectedIds.flatMap(id => { const service = services.find(item => item.id === id); return service ? [service] : []; });
  const favorites = services.filter(service => favoriteIds.includes(service.id));
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const visible = services.filter(service => (category === "Все услуги" || service.category === category) && (!favoritesOnly || favoriteIds.includes(service.id)) && `${service.name} ${service.category} ${service.description}`.toLocaleLowerCase("ru").includes(normalizedQuery));
  const total = selected.reduce((sum, service) => sum + service.priceMinor, 0);
  const duration = selected.reduce((sum, service) => sum + service.durationMinutes, 0);
  const bookingHref = selected.length ? `/book?services=${encodeURIComponent(selected.map(service => service.id).join(","))}` : "/book";
  function chooseCategory(value: string) { setCategory(value); setFavoritesOnly(false); setQuery(""); setFeedback(""); document.getElementById("services")?.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" }); }
  function toggleService(id: string) {
    if (selectedIds.includes(id)) { setSelectedIds(ids => ids.filter(value => value !== id)); setFeedback(""); return; }
    if (selected.length >= 6) { setFeedback("В один визит можно добавить до 6 услуг. Уберите одну, чтобы выбрать другую."); return; }
    setSelectedIds([...selected.map(service => service.id), id]); setFeedback("");
  }
  function resetFilters() { setQuery(""); setCategory("Все услуги"); setFavoritesOnly(false); }
  const availableBundles = data?.bundles.filter(bundle => bundle.serviceIds.length > 0 && bundle.serviceIds.every(id => services.some(service => service.id === id))) ?? [];
  return <PublicShell><main className="discovery">
    <div className="discovery-heading"><div><span className="studio-kicker">BEAUTY, YOUR WAY. / ЛИЧНОЕ ВРЕМЯ</span><h1>Сегодня — <span>для себя.</span><span className="heading-spark" aria-hidden="true">✳</span></h1></div><p>Ваши ритуалы. Ваше расписание.<br />Соберите визит под своё настроение.</p></div>
    <section className="discovery-feature-grid" aria-label="Идеи для вашего визита">
      <article className="editorial-feature"><Image src="/images/salonit-editorial.png" alt="Редакционный портрет с выразительной стрижкой в лавандовых оттенках" fill priority sizes="(max-width: 620px) 90vw, (max-width: 850px) 65vw, 44vw" /><div className="editorial-shade" /><div className="editorial-topline"><span><i className="live-dot" /> SALONIT EDIT / 01</span><span>НОВЫЙ РАКУРС НА СЕБЯ</span></div><div className="editorial-copy"><span className="editorial-pill">Волосы / ваш характер</span><h2>Сменить образ.<br /><span>Остаться собой.</span></h2><button className="editorial-cta" onClick={() => chooseCategory("Волосы")}>Выбрать для волос <ArrowUpRight size={16} /></button></div><div className="editorial-bottom"><span>МАЛЕНЬКИЙ ШАГ. НОВОЕ ОЩУЩЕНИЕ.</span><span>ВИЗУАЛЬНАЯ КОНЦЕПЦИЯ СТУДИИ</span></div></article>
      <article className="ritual-card"><div className="ritual-top"><span className="studio-kicker">В ЦЕНТРЕ ВНИМАНИЯ</span><Sparkles size={17} /></div><div className="ritual-orbit" aria-hidden="true"><div /><span>you</span><i>✳</i></div><div className="ritual-copy"><h2>Время, которое<br />принадлежит вам.</h2><p>Любимый уход и свежие идеи.<br />Запишитесь в своём ритме.</p><Link className="ritual-link" href={bookingHref}>Найти своё время <span><ArrowUpRight size={16} /></span></Link></div></article>
    </section>
    <div className="discovery-shortcuts"><span>С ЧЕГО НАЧНЁМ?</span>{[{ label: "Новый образ", category: "Волосы", icon: Scissors }, { label: "До кончиков пальцев", category: "Ногти", icon: Plus }, { label: "Пауза для себя", category: "Уход", icon: Sparkles }].map(({ label, category: value, icon: Icon }) => <button key={value} onClick={() => chooseCategory(value)}><Icon size={14} /><span>{label}</span><ArrowUpRight size={12} /></button>)}</div>
    <section className="discovery-shop" id="services" aria-labelledby="catalog-heading">
      <div className="discovery-catalog"><div className="catalog-heading"><div><span className="studio-kicker">01 / СОБЕРИТЕ СВОЙ ВИЗИТ</span><h2 id="catalog-heading">Меню заботы<span>{services.length ? String(services.length).padStart(2, "0") : ""}</span></h2></div><button className={`saved-filter ${favoritesOnly ? "is-active" : ""}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(value => !value)}><Heart size={15} fill={favoritesOnly ? "currentColor" : "none"} />Избранное <span>{favorites.length}</span></button></div>
        <div className="catalog-tools"><label className="catalog-search"><Search size={17} /><input aria-label="Найти услугу" placeholder="Что хочется сегодня?" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery("")}><X size={15} /></button>}</label><span className="catalog-tools-mark" aria-hidden="true"><Layers3 size={18} /></span></div>
        <div className="catalog-categories" aria-label="Категории услуг">{categoryLabels.map(label => <button key={label} className={category === label ? "is-active" : ""} aria-pressed={category === label} onClick={() => setCategory(label)}>{category === label && <motion.span className="category-active-bg" layoutId={reducedMotion ? undefined : "discovery-category"} transition={{ type: "spring", stiffness: 380, damping: 34 }} />}<span>{label}</span></button>)}</div>
        {loading && !data && <Loading />}{error && <Notice>{error} <button className="pub-inline-button" onClick={reload}>Повторить загрузку</button></Notice>}{feedback && <Notice kind="info">{feedback}</Notice>}
        <div className="service-menu"><AnimatePresence initial={false} mode="popLayout">{visible.map((service, index) => { const isSelected = selectedIds.includes(service.id); const isFavorite = favoriteIds.includes(service.id); return <motion.article key={service.id} layout={reducedMotion ? false : "position"} initial={{ opacity: 0, y: reducedMotion ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : .18 }} className={`menu-service ${isSelected ? "is-selected" : ""}`}><span className="menu-service-index">{String(index + 1).padStart(2, "0")}</span><div className="menu-service-info"><div className="menu-service-category"><span>{service.category}</span><i /><span>{service.durationMinutes} мин</span></div><h3>{service.name}</h3><p>{service.description}</p></div><div className="menu-service-price"><strong>{money(service.priceMinor)}</strong><button className="service-save" aria-label={`${isFavorite ? "Убрать из избранного" : "В избранное"}: ${service.name}`} aria-pressed={isFavorite} onClick={() => setFavoriteIds(ids => ids.includes(service.id) ? ids.filter(id => id !== service.id) : [...ids, service.id])}><Heart size={15} fill={isFavorite ? "currentColor" : "none"} /></button></div><button className="service-add" aria-label={`${isSelected ? "Убрать" : "Добавить"}: ${service.name}`} aria-pressed={isSelected} onClick={() => toggleService(service.id)}>{isSelected ? <Check size={17} /> : <Plus size={17} />}</button></motion.article>; })}</AnimatePresence></div>
        {!loading && !error && !visible.length && <div className="catalog-empty"><Search size={26} /><h3>{favoritesOnly ? "Пока ничего не найдено" : "Попробуем по-другому?"}</h3><p>{favoritesOnly ? "Отмечайте услуги сердечком — они появятся здесь." : "Измените запрос или выберите другое направление."}</p><button onClick={resetFilters}>Показать все услуги <ArrowRight size={15} /></button></div>}
        <p className="catalog-footnote">Демонстрационный прайс. Время и доступность мастеров уточняются при записи.</p>
      </div>
      <aside className="session-ticket" aria-label="Ваш визит"><div className="ticket-header"><span className="studio-kicker">СОБРАНО ДЛЯ ВАС</span><span className="ticket-symbol" aria-hidden="true">✳</span></div><h2>Ваш<br /><span>ритуал.</span></h2><div className="ticket-separator" />{selected.length ? selected.map(service => <div className="ticket-item" key={service.id}><div>{service.name}<small>{service.durationMinutes} мин · {money(service.priceMinor)}</small></div><button aria-label={`Убрать из визита: ${service.name}`} onClick={() => toggleService(service.id)}><Minus size={14} /></button></div>) : <div className="ticket-empty"><span><Plus size={15} /></span><p>Добавьте то, что нравится.<br />Здесь соберётся ваш визит.</p></div>}<div className="ticket-total" aria-live="polite"><span>{selected.length ? `${selected.length} из 6 услуг` : "ВАШ ВЫБОР"}<strong>{selected.length ? money(total) : "Начнём?"}</strong></span><span>{selected.length ? `${duration} мин услуг` : ""}</span></div><Link className="ticket-book" href={bookingHref}>{selected.length ? "Подобрать время" : "Перейти к записи"}<ArrowUpRight size={17} /></Link><small className="ticket-note">{selected.length ? "Длительность указана для услуг подряд. Точное время визита покажем при выборе слота." : "Выбирайте до 6 услуг. Подходящих мастеров и свободное время покажем на следующем шаге."}</small><div className="ticket-barcode" aria-hidden="true" /><span className="ticket-serial">SALONIT / YOUR TIME, YOUR WAY</span></aside>
    </section>
    {!!availableBundles.length && <section className="discovery-collections" aria-labelledby="collections-heading"><div className="catalog-heading"><div><span className="studio-kicker">02 / ХОРОШО ВМЕСТЕ</span><h2 id="collections-heading">Готовые сочетания.</h2></div><span className="collections-caption">Меньше выбирать. Больше радоваться.</span></div><div className="collection-grid">{availableBundles.map((bundle, index) => { const included = services.filter(service => bundle.serviceIds.includes(service.id)); return <Link className={`collection-card collection-${index % 3}`} href={`/book?bundle=${encodeURIComponent(bundle.id)}`} key={bundle.id}><div className="collection-top"><span>RITUAL / {String(index + 1).padStart(2, "0")}</span><ArrowUpRight size={18} /></div><span className="collection-art" aria-hidden="true">{["✳", "✺", "↗"][index % 3]}</span><h3>{bundle.name}</h3><p>{bundle.description}</p><div className="collection-bottom"><strong>{money(included.reduce((sum, service) => sum + service.priceMinor, 0))}</strong><span>{bundle.mode === "parallel" ? "УСЛУГИ ОДНОВРЕМЕННО" : "УСЛУГИ ДРУГ ЗА ДРУГОМ"}</span></div></Link>; })}</div></section>}
    <section className="discovery-team" id="team" aria-labelledby="team-heading"><div className="catalog-heading"><div><span className="studio-kicker">03 / В ХОРОШИХ РУКАХ</span><h2 id="team-heading">Ваши люди.</h2></div><span className="collections-caption">Выберите того, кому доверите свой образ.</span></div><div className="people-list">{data?.staff.filter(person => person.active).map((person, index) => <Link className="person-row" href={`/book?staff=${encodeURIComponent(person.id)}`} key={person.id}><span className={`person-avatar person-tone-${index % 3}`}>{person.initials}</span><span><strong>{person.name}</strong><small>{person.title}</small></span><ArrowUpRight size={20} /></Link>)}</div>{data && !data.staff.some(person => person.active) && <p className="catalog-footnote">Команда появится здесь после настройки студии.</p>}<p className="catalog-footnote">Демонстрационные профили. В вашей студии здесь будет ваша команда.</p></section>
    <section className="discovery-endnote"><span>Меньше спешки.<br /><strong>Больше себя.</strong></span><span className="endnote-symbol" aria-hidden="true">✳</span><Link href="/account">Мои записи <ArrowUpRight size={17} /></Link></section>
    {!!selected.length && <div className="mobile-visit-bar"><span>{selected.length} услуг · {duration} мин<strong>{money(total)}</strong></span><Link href={bookingHref}>Выбрать время <ArrowRight size={17} /></Link></div>}
  </main></PublicShell>;
}
