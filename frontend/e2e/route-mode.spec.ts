import { expect, test } from "@playwright/test";

import { ROUTE_PLAN_UNAVAILABLE, primeDeviceState, setupBase } from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * Сценарий брифа: «…запускает маршрут» (T11, R22 + R22.1). Маршрут строится по
 * дорогам и улицам (роутер из конфигурации, профиль driving), а его длина/время
 * берутся из ответа роутера. Коридор станций при этом считается по той же
 * дорожной линии.
 */
test("маршрут по дорогам: две точки → геометрия роутера, маневры и км/мин", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  // Коридорный запрос отличается от обычного списка — проверяем, что он состоялся.
  let corridorRequested = false;
  let corridorPolyline: Array<{ lat: number; lon: number }> = [];
  await page.route("**/api/v1/route/stations*", (route) => {
    corridorRequested = true;
    corridorPolyline = JSON.parse(String(route.request().postData())).polyline;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Коридор маршрута/ }).click();

  // Два клика по карте → 2 точки (счётчик «Выбрано: N», i18n-ключ route.pointCount).
  // Позиции — в верхней половине карты: после первой точки панель режима
  // вырастает и контейнер карты сжимается, нижние y выпадают из контейнера.
  const map = page.getByTestId("maplibre-container");
  await map.click({ position: { x: 300, y: 250 } });
  await expect(page.getByText("Выбрано: 1")).toBeVisible();
  await map.click({ position: { x: 550, y: 280 } });
  await expect(page.getByText("Выбрано: 2")).toBeVisible();

  // Роутер ответил по дорогам: компактный чип с км/мин роутера (детали — в title).
  await expect(page.getByTestId("route-road-note")).toContainText("По дорогам");
  await expect(page.getByTestId("route-road-note")).toContainText("6.2 км");
  await expect(page.getByTestId("route-road-note")).toContainText("14 мин");

  // Маневры — за переключателем-вкладкой.
  await page.getByTestId("route-steps-toggle").click();
  await expect(page.getByTestId("route-steps")).toContainText("Поверните направо");
  await expect(page.getByTestId("route-steps")).toContainText("ул. Северная");

  // Подпись на линии — числа роутера (6.2 км / 14 мин), а не прямая между кликами.
  const routeLabel = page.getByTestId("route-label");
  await expect(routeLabel).toBeVisible();
  await expect(routeLabel).toContainText("6.2 км");
  await expect(routeLabel).toContainText("14 мин");

  // Коридор станций считается по дорожной линии (первая точка — геометрия мока).
  await expect
    .poll(() => corridorRequested, { message: "POST /route/stations не вызван после двух точек" })
    .toBe(true);
  await expect.poll(() => corridorPolyline.length).toBeGreaterThan(2);
  expect(corridorPolyline[0].lat).toBeCloseTo(45.0356, 3);
  expect(corridorPolyline.at(-1)?.lon).toBeCloseTo(38.979, 3);

  assertNoConsoleErrors(errors);
});

test("роутер недоступен → прямая линия с честной причиной", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  // Переопределяем план: последняя регистрация выигрывает.
  await page.route("**/api/v1/route/plan", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ROUTE_PLAN_UNAVAILABLE),
    }),
  );
  await page.route("**/api/v1/route/stations*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: /Коридор маршрута/ }).click();
  const map = page.getByTestId("maplibre-container");
  await map.click({ position: { x: 300, y: 250 } });
  await map.click({ position: { x: 550, y: 280 } });

  await expect(page.getByTestId("route-straight-note")).toContainText("прямая линия");
  await expect(page.getByText(/Роутер недоступен/)).toBeVisible();
  await expect(page.getByTestId("route-steps")).toHaveCount(0);

  // Линия всё равно есть — но это прямая по точкам, и подпись считается по ней.
  const routeLabel = page.getByTestId("route-label");
  await expect(routeLabel).toBeVisible();
  await expect(routeLabel).toContainText("км");

  assertNoConsoleErrors(errors);
});
