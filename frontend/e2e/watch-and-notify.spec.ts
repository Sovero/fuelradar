import { expect, test } from "@playwright/test";

import {
  A95,
  STATION_EMPTY,
  mockNotificationsWith,
  notificationItem,
  primeDeviceState,
  setupBase,
} from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * Сценарий брифа: «AI95 отсутствует … нажимает “Следить” … получает push».
 * Web Push в Chromium E2E без VAPID/сервис-воркера не проверяем (R97i: честно
 * вне охвата T15) — проверяем UI-контракт: правило создаётся, событие появляется
 * в ленте уведомлений. Приложение открытое — профиль не нужен.
 */
test("следить за АЗС без АИ-95 → правило создано → уведомление в ленте", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  // Фильтр АИ-95 + статус «Нет» → пустой результат (мок фильтрует честно) →
  // EmptyState с кнопкой «Создать уведомление / Следить».
  await page.goto("/?fuels=AI_95&status=UNAVAILABLE");
  const watch = page.getByRole("button", { name: /Следить|уведомление/i });
  await expect(watch).toBeVisible();

  // Клик «Следить» → POST /alerts (201) → экран честно подтверждает создание.
  await watch.click();
  await expect(page.getByText("Уведомление создано")).toBeVisible();

  // Событие пришло → лента уведомлений показывает FUEL_APPEARED по станции.
  await mockNotificationsWith(page, [
    notificationItem({ id: 7, event_type: "FUEL_APPEARED", station_id: STATION_EMPTY.id, station_name: STATION_EMPTY.name, fuel_code: A95 }),
  ]);
  await page.getByRole("button", { name: /Уведомления/ }).click();
  await expect(page.getByRole("heading", { name: /Уведомления/ })).toBeVisible();
  await expect(page.getByText(STATION_EMPTY.name)).toBeVisible();
  await expect(page.getByText(/Топливо появилось/)).toBeVisible();

  assertNoConsoleErrors(errors);
});
