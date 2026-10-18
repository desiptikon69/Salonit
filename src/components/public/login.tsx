"use client";

import { useState, type FormEvent } from "react";
import {useRouter} from "next/navigation";
import type { CatalogData, Role } from "@/lib/contracts";
import { api, Arrow, message, Notice, PublicShell, useRemote } from "./shared";

const roles: { role: Role; title: string; text: string; symbol: string }[] = [
  { role: "owner", title: "Владелец", text: "Весь салон, финансы и настройки", symbol: "01" },
  { role: "admin", title: "Администратор", text: "Расписание, гости и визиты", symbol: "02" },
  { role: "master", title: "Мастер", text: "Свои записи и начисления", symbol: "03" },
  { role: "stock", title: "Склад", text: "Материалы, остатки и закупки", symbol: "04" },
  { role: "accountant", title: "Бухгалтер", text: "Доходы, расходы и расчёты", symbol: "05" },
  { role: "operator", title: "Оператор платформы", text: "Реестр установок и их состояние", symbol: "06" },
  { role: "client", title: "Клиент", text: "Мои визиты и сертификаты", symbol: "07" },
];
export default function Login() {
  const router=useRouter();
  const [busy, setBusy] = useState<Role | "credentials" | null>(null);
  const [error, setError] = useState("");
  const { data: catalog } = useRemote<CatalogData>("/api/catalog");
  const demo = catalog?.settings.mode === "demo";
  async function login(role: Role) {
    setBusy(role); setError("");
    try { await api("/api/demo/login", { role }); router.push(role === "client" ? "/account" : "/workspace"); }
    catch (reason) { setError(message(reason)); setBusy(null); }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy("credentials"); setError("");
    try {
      const response = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: String(values.get("email") || "").trim(), password: String(values.get("password") || "") }) });
      if (!response.ok) throw new Error(response.status === 429 ? "Слишком много попыток. Подождите немного и повторите." : "Не удалось войти. Проверьте почту и пароль.");
      router.push("/workspace");
    } catch (reason) { setError(message(reason)); setBusy(null); }
  }
  return <PublicShell compact><main className="portal-login"><div className="portal-login-intro"><div className="pub-eyebrow"><span />SALONIT / WORKSPACE</div><h1>Всё на<br />своих<br /><em>местах.</em></h1><p>Рабочее пространство команды. Расписание, гости и забота о салоне — в одном месте.</p><div className="portal-login-emblem" aria-hidden="true"><span>↗</span><small>MAKE<br />IT YOURS</small></div>{demo && <p className="pub-data-note">Общее демонстрационное пространство. Изменения сохраняются и видны другим участникам.</p>}</div><section className="portal-login-roles"><div className="portal-login-caption"><span>01 / ВАШ АККАУНТ</span><span>↗</span></div><h2>Вход для команды</h2>{error && <Notice>{error}</Notice>}<form onSubmit={signIn}><label className="pub-field">Электронная почта<input name="email" type="email" autoComplete="username" required maxLength={254} disabled={busy !== null} /></label><label className="pub-field">Пароль<input name="password" type="password" autoComplete="current-password" required maxLength={128} disabled={busy !== null} /></label><button className="pub-button" disabled={busy !== null} type="submit">{busy === "credentials" ? "Входим…" : "Войти"}<Arrow /></button></form>{demo && <><div className="portal-demo-heading"><span>02 / ИССЛЕДУЙТЕ</span><h3>Попробовать демоверсию</h3><p>Выберите роль и посмотрите, как устроена студия.</p></div><div className="portal-role-grid">{roles.map(item => <button key={item.role} className="portal-role" disabled={busy !== null} onClick={() => void login(item.role)}><span className="portal-role-number">{item.symbol}</span><span><strong>{item.title}</strong><small>{busy === item.role ? "Открываем пространство…" : item.text}</small></span><Arrow /></button>)}</div></>}</section></main></PublicShell>;
}

