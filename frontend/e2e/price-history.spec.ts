import { expect, test } from "@playwright/test";

import { STATION_OPEN, primeDeviceState, setupBase } from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * История цены графиком (spec в vibe/spec.md, vibe-pipeline): третий спарклайн
 * в карточке станции строится только по наблюдениям с ненулевой ценой, записи
 * без цены между ценовыми считаются честно («после N записей без цены»).
 */
test("график цены: две цены с пропуском между ними → спарклайн и честный подсчёт", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  // История с ценами регистрируется ПОСЛЕ setupBase (позже = важнее):
  // цена 58.0 в 09:00, две записи без цены, цена 60.5 в 12:00.
  await page.route("**/api/v1/stations/**/history*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-12T09:00:00", received_at: null, price: 58.0, price_currency: "RUB" },
        { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 92, source: "OSM", observed_at: "2026-09-12T10:00:00", received_at: null },
        { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 93, source: "OSM", observed_at: "2026-09-12T11:00:00", received_at: null },
        { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 95, source: "Пользовательские отчёты", observed_at: "2026-09-12T12:00:00", received_at: null, price: 60.5, price_currency: "RUB" },
      ]),
    }),
  );

  await page.goto("/");
  await page.getByRole("tab", { name: /Список/ }).click();
  const openRow = page.getByRole("button", { name: /Лукойл.*92%/ });
  await expect(openRow).toBeVisible();
  await openRow.click();

  // Третий блок истории: спарклайн цены + подпись с числом точек и пропусков.
  await expect(page.getByText(/Цена во времени, 2 точки/)).toBeVisible();
  await expect(page.getByText(/часть записей без цены пропущена/)).toBeVisible();
  // Подписи точек — <title> внутри кружков Sparkline: цена, источник, счёт пропуска.
  await expect(page.locator("svg title", { hasText: "58.00 ₽ — OSM" })).toHaveCount(1);
  await expect(page.locator("svg title", { hasText: "60.50 ₽ — Пользовательские отчёты" })).toHaveCount(1);
  await expect(page.locator("svg title", { hasText: "2 записей без цены" })).toHaveCount(1);

  // Крайние точки подписаны прямо на графике: мин и макс — это SVG-текст.
  await expect(page.locator("svg text", { hasText: "58.00 ₽" })).toBeVisible();
  await expect(page.locator("svg text", { hasText: "60.50 ₽" })).toBeVisible();

  assertNoConsoleErrors(errors);
});

test("история без цен → блока цены нет, остальные графики на месте", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  // История без цен (заменяем мок-историю ПОСЛЕ setupBase на записи без цены).
  await page.route("**/api/v1/stations/**/history*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-12T09:00:00", received_at: null },
        { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 95, source: "OSM", observed_at: "2026-09-12T12:00:00", received_at: null },
      ]),
    }),
  );

  await page.goto("/");
  await page.getByRole("tab", { name: /Список/ }).click();
  const openRow = page.getByRole("button", { name: /Лукойл.*92%/ });
  await expect(openRow).toBeVisible();
  await openRow.click();

  // Блока цены нет вовсе; график достоверности остаётся.
  await expect(page.getByText(/Цена во времени/)).toHaveCount(0);
  await expect(page.getByText(/По цене данных пока мало/)).toHaveCount(0);
  await expect(page.getByText(/Достоверность наблюдений во времени/)).toBeVisible();

  assertNoConsoleErrors(errors);
});
