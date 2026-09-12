import { defineConfig, devices } from "@playwright/test";

/**
 * Браузерные E2E (T15, R88). Критические сценарии в Chromium одной командой:
 * `npm run test:e2e`. API и внешние ресурсы перехватываются локальными
 * mocks/fixtures (e2e/mocks.ts) — реальные backend, Telegram/VAPID, карта-тайлы
 * и любая внешняя сеть не нужны (критерий приёмки тикета).
 *
 * Trace и screenshot сохраняются ТОЛЬКО при падении (retain-on-failure /
 * only-on-failure) — успешный прогон не оставляет артефактов.
 * Отчёты/артефакты лежат в test-results/ (в .gitignore).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 },
    locale: "ru-RU",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Канал "chrome" — системный Chromium (Chrome): в оффлайн-окружении
        // playwright install не может скачать браузер с CDN, а системный
        // Chrome уже установлен. При наличии скачанного браузера Playwright
        // можно убрать channel — поведение тестов не меняется.
        channel: "chrome",
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
