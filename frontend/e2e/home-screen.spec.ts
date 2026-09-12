import { expect, test } from "@playwright/test";

import { STATION_OPEN, primeDeviceState, setupBase } from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * Smoke-сценарий брифа: «пользователь открывает FuelRadar … выбирает АИ-95 …
 * видит статус и confidence». Ноль ошибок в консоли обязателен: пустой рендер
 * или ошибка — дефект независимо от того, как чисто читается код.
 */
test("домашний экран рендерится без единой ошибки в консоли", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  await page.goto("/");
  // Логотип — span (не heading): проверяем видимый бренд-текст в шапке.
  await expect(page.getByText("FuelRadar", { exact: true })).toBeVisible();

  // Карта инициализировалась (таб «Карта» — дефолт).
  await expect(page.getByTestId("maplibre-container")).toBeVisible();
  // Realtime-канал жив: оффлайн-баннер «Живое обновление потеряно» отсутствует.
  await expect(page.getByText(/Живое обновление потеряно/i)).toHaveCount(0);

  // Данные с mocked /stations: счётчик «2 станций» и карточки со статусом+confidence.
  await page.getByRole("tab", { name: /Список/ }).click();
  await expect(page.getByText(/2 станций/)).toBeVisible();
  // Карточка списка показывает бренд + лучший статус с достоверностью (§107).
  const openRow = page.getByRole("button", { name: /Лукойл.*92%/ });
  await expect(openRow).toBeVisible();
  await expect(openRow).toContainText("АИ-95 · Есть, 92%");

  // Выбор АИ-95: чип фильтра (подпись «АИ-95», не код) → URL-параметр (R-filters).
  await page.getByRole("button", { name: "АИ-95", exact: true }).click();
  await expect(page).toHaveURL(/fuels=AI_95/);

  assertNoConsoleErrors(errors);
});
