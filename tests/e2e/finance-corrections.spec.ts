import {test,expect} from "@playwright/test";
test("approved financial correction changes current result and preserves original visit",async({page})=>{
 await page.goto("/login");await page.getByRole("button",{name:"01 Владелец"}).click();await page.waitForURL("**/workspace");
 const before=await page.evaluate(async()=> (await fetch("/api/workspace")).json());const visit=before.visits.find((v:{closedAt?:string})=>v.closedAt);expect(visit).toBeTruthy();
 await page.getByRole("navigation").getByRole("button",{name:"Финансы",exact:true}).click();await page.getByRole("tab",{name:"Корректировки",exact:true}).click();await page.getByRole("button",{name:"Создать корректировку",exact:true}).click();
 const dialog=page.getByRole("dialog"),reason="Браузерная сверка "+Date.now();
 await dialog.getByRole("combobox",{name:"Закрытый визит",exact:true}).selectOption(visit.id);await dialog.getByRole("spinbutton",{name:/Изменение/}).fill("12.34");await dialog.getByRole("textbox",{name:"Причина",exact:true}).fill(reason);await dialog.getByRole("button",{name:"Создать черновик"}).click();
 const row=page.getByRole("row").filter({hasText:reason});await row.getByRole("button",{name:"Согласовать",exact:true}).click();await expect(row).toContainText("Согласовано");
 const after=await page.evaluate(async()=> (await fetch("/api/workspace")).json());expect(after.metrics.revenueMinor).toBe(before.metrics.revenueMinor+1234);expect(after.metrics.cashMinor).toBe(before.metrics.cashMinor);expect(after.visits.find((v:{id:string})=>v.id===visit.id)).toEqual(visit);
 await page.screenshot({path:"artifacts/financial-correction.png",fullPage:true});
});
