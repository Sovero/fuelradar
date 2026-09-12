import { expect, test } from "@playwright/test";

import { primeDeviceState, setupBase } from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * Сценарий брифа: «…запускает маршрут» (T11, R22). Routing-провайдера нет по
 * архитектуре — проверяем честный коридор: включение режима, клики по карте
 * добавляют точки, ≥2 точек → запрос коридора → станции в панели.
 */
test("коридор маршрута: две точки → станции коридора", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  // Коридорный запрос отличается от обычного списка — проверяем, что он состоялся.
  let corridorRequested = false;
  await page.route("**/api/v1/route/stations*", (route) => {
    corridorRequested = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Коридор маршрута/ }).click();

  // Панель режима: честная пометка «без routing-провайдера».
  await expect(page.getByText(/routing|коридор/i).first()).toBeVisible();

  // Два клика по карте → 2 точки (счётчик «Выбрано: N», i18n-ключ route.pointCount).
  // Позиции — в верхней половине карты: после первой точки панель режима
  // вырастает и контейнер карты сжимается, нижние y выпадают из контейнера.
  const map = page.getByTestId("maplibre-container");
  await map.click({ position: { x: 300, y: 250 } });
  await expect(page.getByText("Выбрано: 1")).toBeVisible();
  await map.click({ position: { x: 550, y: 280 } });
  await expect(page.getByText("Выбрано: 2")).toBeVisible();

  // ≥2 точек → запрос коридора выполнен.
  await expect
    .poll(() => corridorRequested, { message: "POST|GET /route/stations не вызван после двух точек" })
    .toBe(true);

  assertNoConsoleErrors(errors);
});
