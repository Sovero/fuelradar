import { expect, test } from "@playwright/test";

import { COLLECTION_STALLED, primeDeviceState, setupBase } from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * R58: простой сбора виден на главном экране, а не только в админке. Сценарий
 * подменяет базовый мок «сбор в порядке» на молчащий сбор и проверяет честное
 * предупреждение с числами backend'а; консоль обязана остаться чистой.
 */
test("молчащий сбор показывается предупреждением на главном экране", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);
  // Позже зарегистрированный route важнее (см. e2e/mocks.ts).
  await page.route("**/api/v1/collection/health", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(COLLECTION_STALLED) }),
  );

  await page.goto("/");

  const banner = page.locator('[data-collection-state="stalled"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/Сбор данных молчит/);
  await expect(banner).toContainText(/Статусы АЗС могут быть устаревшими/);
  await expect(banner).toContainText(/план просрочен на 360 мин/);

  // Экран при этом продолжает работать: станции из мока на месте.
  await page.getByRole("tab", { name: /Список/ }).click();
  await expect(page.getByText(/2 станций/)).toBeVisible();

  assertNoConsoleErrors(errors);
});
