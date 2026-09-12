import { expect, test } from "@playwright/test";

import { mockAuthUser, mockReportAccepted, primeDeviceState, setupBase } from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * Сценарий брифа: «нажимает “Сообщить” … GPS подтверждает … Observation
 * сохраняется … Confidence пересчитывается». Backend-часть покрыта юнит-тестами
 * (test_reports.py) — здесь UI-контракт: без профиля «Сообщить» зовёт логин (R65),
 * с профилем открывает форму, GPS-точка подставляется (грант геолокации в mocks),
 * ответ 201 → экран успеха.
 */
test("сообщить о наличии топлива с GPS-подтверждением", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await mockAuthUser(page);
  await mockReportAccepted(page);
  await primeDeviceState(page);

  await page.goto("/?tab=list");
  // Карточка списка: бренд + лучший статус с достоверностью (§107).
  await page.getByRole("button", { name: /Лукойл.*92%/ }).click();
  // Форма отчёта открывается кнопкой «Сообщить» в карточке (гость получил бы LoginPanel).
  await page.getByRole("button", { name: /Сообщить/ }).click();

  // GPS рядом (<300 м от фиксированной точки) → «вы рядом» (R40).
  await expect(page.getByText(/Вы рядом со станцией/)).toBeVisible();

  // Статус АИ-95 «Есть» → отправка → успех.
  await page.getByRole("button", { name: "Есть", exact: true }).first().click();
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByText(/Отчёт сохранён/)).toBeVisible();

  assertNoConsoleErrors(errors);
});

/** Без профиля «Сообщить» не открывает форму, а зовёт на вход (R65/R30.2). */
test("гость у кнопки «Сообщить» получает приглашение на вход", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  await page.goto("/?tab=list");
  await page.getByRole("button", { name: /Лукойл.*92%/ }).click();

  // Карточка открыта, но форму без профиля не открыть: LoginPanel вместо ReportForm.
  await page.getByRole("button", { name: /Сообщить/ }).click();
  await expect(page.getByRole("heading", { name: /Вход/ })).toBeVisible();
  await expect(page.getByText(/Вы рядом со станцией/)).toHaveCount(0);

  assertNoConsoleErrors(errors);
});
