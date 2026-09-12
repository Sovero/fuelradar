/**
 * Сбор ошибок браузера: любая console.error/uncaught-ошибка — дефект теста
 * (пустой рендер или ошибка в консоли — дефект, каким бы чистым ни был код).
 * Ожидаемые сетевые 4xx не подпадают: моки отвечают 2xx/JSON по контрактам.
 */
import type { Page } from "@playwright/test";

export function watchConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`[console.error] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`[pageerror] ${error.message}`);
  });
  return errors;
}

export function assertNoConsoleErrors(errors: string[]) {
  if (errors.length) {
    throw new Error(`Браузерные ошибки в консоли (${errors.length}):\n${errors.join("\n")}`);
  }
}
