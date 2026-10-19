import "dotenv/config";
import { hashPassword } from "better-auth/crypto";
import { pool } from "../src/server/db";
import { saveRecord } from "../src/server/records";
import { services, staff, resources, materials, bundles, settings } from "../src/server/sample-data";

pool.on("error", (error) => console.error("pool error", error.message));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 6) throw error;
      console.log("retry", label, attempt, message);
      await sleep(800 * attempt);
    }
  }
  throw new Error("unreachable");
}

async function save(kind: string, id: string, data: object) {
  await retry(kind + ":" + id, () => saveRecord(kind, id, data, pool));
  await sleep(150);
}

async function main() {
  const password = process.env.DEMO_PASSWORD;
  if (!password) throw new Error("DEMO_PASSWORD required");
  const hash = await hashPassword(password);
  const roles = ["owner", "admin", "master", "stock", "accountant", "operator", "client"] as const;

  for (const [kind, items] of [["service", services], ["resource", resources], ["material", materials], ["bundle", bundles]] as const) {
    for (const item of items) await save(kind, item.id, item);
    console.log("catalog", kind, "ok");
  }
  for (const member of staff) await save("staff", member.id, member);
  await save("settings", "salon-settings", settings);
  console.log("team ok");

  const names = ["Алиса Белова", "Полина Крылова", "Дарья Васильева"];
  for (let i = 0; i < names.length; i++) {
    await save("client", "client-" + i, {
      name: names[i], phone: "+7900000" + String(i).padStart(4, "0"), email: "",
      notes: "Вымышленный профиль для знакомства с SalonIt", marketingConsent: i % 3 === 0,
      createdAt: new Date(Date.now() - (i + 2) * 86400000).toISOString(),
    });
  }

  for (const role of roles) {
    const uid = "demo-" + role;
    await retry("user:" + role, () => pool.query('INSERT INTO auth."user"(id,name,email,email_verified,role,staff_id,client_id) VALUES($1,$2,$3,true,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [uid, role === "master" ? "Анна Соколова" : role === "client" ? names[0] : { owner: "Владелец", admin: "Администратор", stock: "Закупщик", accountant: "Бухгалтер", operator: "Оператор" }[role], role + "@demo.salonit.invalid", role, role === "master" ? "anna" : null, role === "client" ? "client-0" : null]));
    await sleep(150);
    await retry("account:" + role, () => pool.query("INSERT INTO auth.account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3) ON CONFLICT(id) DO NOTHING", ["credential-" + role, uid, hash]));
    await sleep(150);
  }
  console.log("accounts ok");

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  for (const member of staff) await save("shift", "shift-" + member.id, { name: member.name, staffId: member.id, date: today, start: member.workStart, end: member.workEnd, status: "planned" });
  console.log("MINIMAL SEED READY");
  await pool.end();
}

main().catch(async (error) => {
  console.error("SEED FAILED", error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
