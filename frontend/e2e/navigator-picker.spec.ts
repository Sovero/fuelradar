import { expect, test } from "@playwright/test";

import { primeDeviceState, setupBase } from "./mocks";
import { assertNoConsoleErrors, watchConsoleErrors } from "./console";

/**
 * Выбор навигатора в карточке станции (spec в vibe/spec.md, vibe-pipeline):
 * клик по 2ГИС подсвечивает вариант и сохраняется в localStorage; после
 * перезагрузки карточки выбор восстановлен. Deep-links провайдеров покрыты
 * юнит-тестами buildRouteUrl — здесь проверяем персистентность выбора в UI.
 */
test("выбор навигатора: клик 2ГИС сохраняется и восстанавливается после перезагрузки", async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await setupBase(page);
  await primeDeviceState(page);

  await page.goto("/");
  await page.getByRole("tab", { name: /Список/ }).click();

  // Открыть карточку тестовой АЗС (mock: «Лукойл», АИ-95 92%).
  const openRow = page.getByRole("button", { name: /Лукойл.*92%/ });
  await expect(openRow).toBeVisible();
  await openRow.click();

  // Сегмент выбора навигатора: по умолчанию — Яндекс (дефолт без сохранения).
  const yandex = page.getByRole("button", { name: "Яндекс", exact: true });
  const gis = page.getByRole("button", { name: "2ГИС", exact: true });
  await expect(yandex).toBeVisible();
  await expect(yandex).toHaveAttribute("aria-pressed", "true");
  await expect(gis).toHaveAttribute("aria-pressed", "false");

  // Клик по 2ГИС: подсветка переехала, выбор лег в localStorage.
  await gis.click();
  await expect(gis).toHaveAttribute("aria-pressed", "true");
  await expect(yandex).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("fuelradar:nav-provider")), {
      message: "выбор навигатора не сохранился в localStorage",
    })
    .toBe("2gis");

  // Перезагрузка: карточка открывается снова (?station=… в URL), выбор
  // восстанавливается из хранилища — 2ГИС подсвечен, не дефолтный Яндекс.
  await page.reload();
  await expect(yandex).toBeVisible();
  await expect(gis).toHaveAttribute("aria-pressed", "true");
  await expect(yandex).toHaveAttribute("aria-pressed", "false");

  assertNoConsoleErrors(errors);
});
