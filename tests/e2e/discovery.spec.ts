import { test, expect } from "@playwright/test";

test("discovery selection, favorites and price survive reload and reach booking", async ({ page }) => {
  await page.goto("/");
  const service = page.locator(".menu-service").filter({ has: page.getByRole("heading", { name: "Мужская стрижка", exact: true }) });
  await page.getByRole("textbox", { name: "Найти услугу" }).fill("Мужская стрижка");
  await expect(page.locator(".menu-service")).toHaveCount(1);
  await service.getByRole("button", { name: "В избранное: Мужская стрижка", exact: true }).click();
  await service.getByRole("button", { name: "Добавить: Мужская стрижка", exact: true }).click();
  await expect(page.locator(".ticket-total")).toContainText("1 из 6 услуг");
  await expect(page.locator(".ticket-total strong")).toHaveText(await service.locator(".menu-service-price strong").innerText());
  await page.reload();
  await expect(page.locator(".ticket-item")).toContainText("Мужская стрижка");
  await page.getByRole("button", { name: /^Избранное/ }).click();
  await expect(page.locator(".menu-service")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Найти услугу" }).fill("нет-такой-процедуры");
  await expect(page.locator(".catalog-empty")).toBeVisible();
  await page.getByRole("button", { name: "Показать все услуги" }).click();
  await expect(page.locator(".menu-service")).toHaveCount(20);
  await page.locator(".ticket-book").click();
  await expect(page).toHaveURL(/services=hair-men/);
  await expect(page.getByRole("checkbox", { name: /Мужская стрижка/ })).toBeChecked();
});

test("mobile discovery limits selection and keeps checkout above navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".menu-service").first()).toBeVisible();
  for (let i = 0; i < 7; i++) await page.locator(".menu-service").nth(i).locator(".service-add").click();
  await expect(page.locator(".menu-service.is-selected")).toHaveCount(6);
  await expect(page.getByText("В один визит можно добавить до 6 услуг.", { exact: false })).toBeVisible();
  const bar = await page.locator(".mobile-visit-bar").boundingBox();
  const dock = await page.locator(".studio-rail").boundingBox();
  expect(bar!.y + bar!.height).toBeLessThan(dock!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".studio-profile-link")).toHaveAccessibleName("Мои записи");
  await page.screenshot({ path: "artifacts/redesign-mobile-selection.png" });
  await page.locator(".mobile-visit-bar").getByRole("link", { name: "Выбрать время" }).click();
  await expect(page.locator(".book-service-option input:checked")).toHaveCount(6);
});

test("staff preference from discovery survives selecting a compatible service", async ({ page }) => {
  await page.goto("/");
  const catalog = await page.evaluate(async () => (await fetch("/api/catalog")).json());
  const staff = catalog.staff.find((person: { active: boolean; skills: string[] }) => person.active && person.skills.includes("hair"));
  expect(staff).toBeTruthy();
  const service = catalog.services.find((item: { active: boolean; skill: string }) => item.active && staff.skills.includes(item.skill));
  await page.locator(".person-row").filter({ hasText: staff.name }).click();
  await page.locator(".book-service-option").filter({ has: page.getByRole("checkbox", { name: new RegExp(service.name) }) }).click();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.locator(".book-staff-option.book-selected")).toContainText(staff.name);
});
