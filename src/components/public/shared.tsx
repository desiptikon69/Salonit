"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, Layers3, CalendarDays, UserRound, ArrowUpRight, Download, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { InstallPrompt, InstallTrigger } from "@/components/pwa/install-prompt";

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({ error: "Сервер вернул непонятный ответ. Попробуйте ещё раз." }));
  if (!response.ok) throw new Error(data.error || "Не удалось выполнить запрос. Попробуйте ещё раз.");
  return data as T;
}

export const money = (value: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value / 100);
export const time = (value: string) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value));
export const dateLabel = (value: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" }).format(new Date(value));
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const message = (error: unknown) => error instanceof Error ? error.message : "Что-то пошло не так. Попробуйте ещё раз.";

export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h16m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function Spark({ size = 32 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 1v30M1 16h30M5.4 5.4l21.2 21.2M5.4 26.6 26.6 5.4" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

export function PublicShell({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const pathname = usePathname();
  const links = [{ href: "/", label: "Открывать", icon: Compass }, { href: "/#services", label: "Услуги", icon: Layers3 }, { href: "/book", label: "Запись", icon: CalendarDays }, { href: "/account", label: "Мой профиль", icon: UserRound }];
  return <div className={`pub-root studio-app ${compact ? "studio-compact" : ""}`}>
    <a className="studio-skip" href="#studio-content">К содержимому</a>
    <aside className="studio-rail"><Link className="studio-symbol" href="/" aria-label="SalonIt — главная">s<span>ı</span></Link><nav aria-label="Основная навигация">{links.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={pathname === href ? "is-active" : ""} aria-current={pathname === href ? "page" : undefined}><Icon size={22} strokeWidth={1.6} /><span>{label}</span></Link>)}</nav><span className="studio-rail-caption">BEAUTY, YOUR WAY.</span><Link className="studio-team-link" href="/login" aria-label="Вход для команды"><ArrowUpRight size={21} /></Link></aside>
    <div className="studio-app-body"><header className="studio-topbar"><Link className="studio-wordmark" href="/">salon<span>it</span><span className="studio-wordmark-dot">®</span></Link><span className="studio-topbar-caption">ВАША ЛИЧНАЯ BEAUTY-СТУДИЯ</span><div className="studio-topbar-actions"><span className="studio-demo-label"><i />Демо-студия</span><Link href="/account" className="studio-profile-link" aria-label="Мои записи"><UserRound size={17} /><span>Мои записи</span></Link></div></header>
    <div id="studio-content">{children}</div>
    <footer className="studio-footer"><span><Sparkles size={14} /> Сделано для вашего времени.</span><small>Демонстрационные услуги и профили</small><InstallTrigger className="studio-install-trigger"><Download size={13} /> Установить приложение</InstallTrigger><Link href="/login">Вход для команды <ArrowUpRight size={13} /></Link></footer></div>
    <InstallPrompt />
  </div>;
}

export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  return <motion.div className={className} initial={false} whileInView={reduce ? undefined : { y: [12, 0], opacity: [0.7, 1] }} viewport={{ once: true, amount: 0.1 }} transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.div>;
}

export function Notice({ children, kind = "error" }: { children: ReactNode; kind?: "error" | "success" | "info" }) {
  return <div className={`pub-notice pub-notice-${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

export function Loading({ text = "Загружаем данные студии…" }: { text?: string }) {
  return <div className="pub-loading" role="status"><span className="pub-spinner" />{text}</div>;
}

export function useRemote<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    api<T>(path).then(value => { if (alive) { setData(value); setError(""); } }).catch(reason => { if (alive) setError(message(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, revision]);
  return { data, error, loading, reload: () => { setLoading(true); setRevision(value => value + 1); } };
}
