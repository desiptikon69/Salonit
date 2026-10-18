import {test,expect} from "@playwright/test";
import "dotenv/config";
test("employee signs in with password",async({page})=>{await page.goto("/login");await page.getByLabel("Электронная почта",{exact:true}).fill("owner@demo.salonit.invalid");await page.getByLabel("Пароль",{exact:true}).fill(process.env.DEMO_PASSWORD!);await page.getByRole("button",{name:"Войти",exact:true}).click();await page.waitForURL("**/workspace");await expect(page.locator(".ws-user")).toContainText("Владелец");});
test("owner navigation and role isolation",async({page,request})=>{
 await page.goto("/login");await page.getByRole("button",{name:"01 Владелец"}).click();
 await expect(page.getByRole("heading",{name:"Хороший день начинается здесь"})).toBeVisible();
 for(const name of ["Расписание","Клиенты","Услуги","Команда","Склад и ресурсы","Финансы","Начисления","Сертификаты","Настройки"]){await page.getByRole("navigation",{name:"Рабочее пространство"}).getByRole("button",{name,exact:true}).click();await expect(page.getByRole("main")).not.toContainText("Не удалось");}
 await page.screenshot({path:"artifacts/owner-settings.png",fullPage:true});
 await page.goto("/login");await page.getByRole("button",{name:"04 Склад"}).click();await page.waitForURL("**/workspace");await expect(page.locator(".ws-user")).toContainText("Кладовщик");await expect(page.getByRole("navigation").getByRole("button",{name:"Финансы",exact:true})).toHaveCount(0);
 const data=await page.evaluate(async()=> (await fetch("/api/workspace")).json());expect(data.clients).toEqual([]);expect(data.visits).toEqual([]);expect(data.accruals).toEqual([]);
 const response=await request.get("/api/workspace");expect(response.status()).toBe(401);
});
test("guest reserves, verifies OTP, persists visit and cancels",async({page})=>{
 await page.goto("/book?services=hair-men");
 await page.getByRole("button",{name:"Продолжить"}).click();await page.getByRole("button",{name:"Продолжить"}).click();
 const date=new Date(Date.now()+5*86400000).toISOString().slice(0,10);await page.getByLabel("Дата визита",{exact:true}).fill(date);
 const slot=page.locator(".book-slot").first();await expect(slot).toBeVisible();await slot.click();await page.getByRole("button",{name:"Продолжить"}).click();
 await page.getByLabel("Как к вам обращаться").fill("Тестовый Гость");await page.getByLabel("Номер телефона").fill("+7900"+String(Date.now()).slice(-7));await page.getByRole("button",{name:"Получить код",exact:true}).click();
 await expect(page.locator(".book-otp-code")).toBeVisible();const code=await page.locator(".book-otp-code").innerText();await page.getByLabel("Код подтверждения",{exact:true}).fill(code);await page.getByRole("button",{name:"Подтвердить запись"}).click();
 await expect(page.getByRole("heading",{name:"До встречи в студии."})).toBeVisible();await page.getByRole("link",{name:"Мои записи",exact:true}).last().click();await expect(page.locator(".portal-visit")).toHaveCount(1);
 await page.reload();await expect(page.locator(".portal-visit")).toHaveCount(1);await page.getByRole("button",{name:"Отменить запись",exact:true}).click();await page.getByRole("button",{name:"Да, отменить запись"}).click();await expect(page.locator(".portal-status-cancelled")).toBeVisible();
});
test("mobile home fits viewport",async({page})=>{await page.setViewportSize({width:390,height:844});await page.goto("/");await expect(page.getByRole("link",{name:"Найти своё время"})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:"artifacts/home-mobile.png",fullPage:true});});

test("owner completes a booked visit and posts payment and accrual exactly once",async({page})=>{
 await page.goto("/book");
 const date=new Date(Date.now()+6*86400000).toISOString().slice(0,10),phone="+7900"+String(Date.now()).slice(-7);
 const booking=await page.evaluate(async({date,phone})=>{
  const post=async(path:string,body:unknown)=>{const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();};
  const {slots}=await (await fetch(`/api/booking/slots?date=${date}&services=hair-men,care-hair-mask&mode=sequential`)).json();
  const hold=await post("/api/booking/hold",{serviceIds:["hair-men","care-hair-mask"],mode:"sequential",startAt:slots[0].startAt,name:"Проверка "+phone,phone});
  const otp=await post("/api/booking/otp",{phone});return (await post("/api/booking/confirm",{...hold,phone,code:otp.demoCode})).visit;
 },{date,phone});
 await page.goto("/login");await page.getByRole("button",{name:"01 Владелец"}).click();await page.waitForURL("**/workspace");
 await page.getByRole("navigation").getByRole("button",{name:"Расписание",exact:true}).click();await page.getByLabel("Дата расписания").fill(date);await page.getByRole("button",{name:new RegExp("Проверка "+phone.replace("+","\\+"))}).first().click();
 const cancelForm=page.getByRole("dialog").locator("form").filter({has:page.getByLabel(/Причина отмены:.*уход/i)});await cancelForm.getByRole("textbox").fill("Клиент отказался от ухода");await cancelForm.getByRole("button").click();await expect(page.getByRole("dialog")).toContainText("Отменён");
 await page.getByRole("combobox",{name:"Дополнительная услуга",exact:true}).selectOption("care-hair-mask");await page.getByLabel("Причина добавления",{exact:true}).fill("Клиент выбрал уход заново");await page.getByRole("button",{name:"Добавить услугу",exact:true}).click();await expect.poll(async()=> (await page.evaluate(async()=> (await fetch("/api/workspace")).json())).visits.find((v:{id:string})=>v.id===booking.id).items.length).toBe(3);
 for(const name of ["Клиент пришёл","Начать услуги","Завершить услуги","Перейти к расчёту"]){await page.getByRole("button",{name,exact:true}).click();}
 await Promise.all([page.waitForResponse(r=>r.url().endsWith("/api/commands")&&r.request().method()==="POST"),page.getByRole("button",{name:"Закрыть визит и провести расчёт"}).click()]);await page.getByRole("button",{name:"Расчёт",exact:true}).click();await expect(page.getByRole("heading",{name:"Возврат",exact:true})).toBeVisible();
 const state=await page.evaluate(async()=> (await fetch("/api/workspace")).json());const closed=state.visits.find((v:{id:string})=>v.id===booking.id);expect(closed.closedAt).toBeTruthy();expect(closed.paidMinor).toBe(250000);expect(closed.items.filter((i:{status:string})=>i.status==="cancelled")).toHaveLength(1);expect(state.accruals.filter((a:{visitId:string})=>a.visitId===booking.id)).toHaveLength(2);
 await page.screenshot({path:"artifacts/visit-closed.png",fullPage:true});
});









