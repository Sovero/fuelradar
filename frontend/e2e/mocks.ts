/**
 * Локальные mocks/fixtures для E2E (T15): перехват /api/v1/* на уровне сети —
 * реальные backend, внешняя сеть и секреты не нужны (критерий приёмки тикета).
 * Внешним ресурсам (тайлы OSM, глифы MapLibre) отвечаем пустышками, чтобы карта
 * инициализировалась детерминированно и без консольных ошибок.
 *
 * Порядок перехватов: в Playwright при нескольких совпадающих route побеждает
 * ЗАРЕГИСТРИРОВАННЫЙ ПОЗЖЕ — поэтому специфичные для сценария моки (mockReportAccepted
 * и т.п.) вызываются ПОСЛЕ installApiMocks.
 */
import type { Page, Route } from "@playwright/test";
import type { Meta, NotificationItem, StationBrief } from "../lib/types";

/** Стабильные координаты (центр вьюпорта — данные, не код, см. frontend/.env.example). */
export const VIEWPORT_CENTER = { lat: 45.0355, lon: 38.9753 };

export const A95 = "AI_95";
export const A92 = "AI_92";

const now = "2026-09-12T12:00:00Z";

/** Станция с доступным АИ-95 и высокой достоверностью — для поиска/карточки. */
export const STATION_OPEN: StationBrief = {
  id: "fr_station_000101",
  name: "Тестовая АЗС «Лукойл»",
  brand: "Лукойл",
  latitude: VIEWPORT_CENTER.lat + 0.01,
  longitude: VIEWPORT_CENTER.lon,
  address: "ул. Красная, 1",
  city: "Краснодар",
  distance_km: 1.1,
  eta_minutes: 4,
  statuses: [
    { fuel_code: A95, status: "AVAILABLE", confidence: 92, updated_at: now, expires_at: "2026-09-12T18:00:00Z" },
    { fuel_code: A92, status: "UNKNOWN", confidence: 0, updated_at: now, expires_at: "2026-09-12T18:00:00Z" },
  ],
  queue: { level: "LOW", vehicles: 2, estimated_wait_minutes: 5 },
  score: 87,
};

/** Станция, где АИ-95 закончился — для сценария «следить → уведомление». */
export const STATION_EMPTY: StationBrief = {
  id: "fr_station_000202",
  name: "Тестовая АЗС «Роснефть»",
  brand: "Роснефть",
  latitude: VIEWPORT_CENTER.lat - 0.01,
  longitude: VIEWPORT_CENTER.lon + 0.005,
  address: "ул. Северная, 2",
  city: "Краснодар",
  distance_km: 1.6,
  eta_minutes: 6,
  statuses: [{ fuel_code: A95, status: "UNAVAILABLE", confidence: 88, updated_at: now, expires_at: "2026-09-12T18:00:00Z" }],
  queue: null,
  score: 64,
};

export const META: Meta = {
  fuel_types: [
    // АИ-95 первым: форма отчёта рендерит виды топлива в порядке /meta, а
    // сценарии выбирают статус АИ-95 кнопкой «Есть» (первая в группе).
    { code: A95, name_ru: "АИ-95", commercial: [] },
    { code: A92, name_ru: "АИ-92", commercial: [] },
  ],
  station_brands: [{ id: 1, name: "Лукойл", priority: 10 }],
  sources: [
    { code: "osm_overpass", name: "OpenStreetMap", status: "ACTIVE", attribution: "© OpenStreetMap" },
    { code: "user_reports", name: "Пользовательские отчёты", status: "ACTIVE", attribution: "Сообщество FuelRadar" },
  ],
  fuel_statuses: [
    // Полный набор из fuel_status/statuses.py — легенда и фильтры не должны
    // показывать «сырые» коды (R98i: переводы статусов — только из /meta).
    { code: "AVAILABLE", name_ru: "Есть" },
    { code: "LIKELY_AVAILABLE", name_ru: "Вероятно есть" },
    { code: "LOW_STOCK", name_ru: "Заканчивается" },
    { code: "UNCERTAIN", name_ru: "Неоднозначно" },
    { code: "UNAVAILABLE", name_ru: "Нет" },
    { code: "UNKNOWN", name_ru: "Нет данных" },
  ],
  queue_levels: [
    { code: "NONE", name_ru: "Нет" },
    { code: "LOW", name_ru: "Небольшая" },
    { code: "MEDIUM", name_ru: "Средняя" },
    { code: "HIGH", name_ru: "Большая" },
    { code: "VERY_HIGH", name_ru: "Огромная" },
  ],
  push: { enabled: false, vapid_public_key: null },
};

export function notificationsPage(items: NotificationItem[] = []) {
  // Свежие события — непрочитанные (unread_count = все новые).
  return { items, unread_count: items.length };
}

export function notificationItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    event_type: "FUEL_APPEARED",
    station_id: STATION_OPEN.id,
    station_name: STATION_OPEN.name,
    fuel_code: A95,
    payload: {},
    delivered: true,
    delivered_at: now,
    created_at: now,
    ...overrides,
  };
}

const json = (data: unknown, status = 200) => async (route: Route) => {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
};

function stationDetail(brief: StationBrief) {
  return { ...brief, status_explanation: { note: "Свежие наблюдения пользователей" } };
}

/** created-правило для POST /alerts; GET /alerts возвращает массив. */
const createdAlert = {
  id: 1,
  name: "Новое правило",
  fuel_code: A95,
  distance_km: null,
  status_filter: "AVAILABLE",
  confidence_min: null,
  queue_max: null,
  scope: { station_id: STATION_EMPTY.id },
  is_active: true,
  trigger_count: 0,
  last_event_at: null,
};

export async function installApiMocks(page: Page) {
  await page.route("**/api/v1/meta", json(META));
  await page.route("**/api/v1/auth/me", json({ user: null }));
  await page.route("**/api/v1/auth/bootstrap", json({ required: false }));
  // Минимально честная фильтрация как у backend: fuel/status из query сужают
  // выдачу (сама логика фильтров покрыта backend-тестами — тут фикс.truth).
  await page.route("**/api/v1/stations?*", (route) => {
    const url = new URL(route.request().url());
    const fuel = url.searchParams.get("fuel");
    const status = url.searchParams.get("status");
    let stations = [STATION_OPEN, STATION_EMPTY];
    if (fuel) stations = stations.filter((s) => s.statuses.some((st) => st.fuel_code === fuel));
    if (status) stations = stations.filter((s) => s.statuses.some((st) => st.status === status));
    return json(stations)(route);
  });
  // Детали станции: id + опциональный query (?lat&lon) — регистрации ПОСЛЕ
  // общего "**/api/v1/stations?*", чтобы выиграть (позже = важнее).
  await page.route(/\/api\/v1\/stations\/[^/?]+(\?.*)?$/, (route) =>
    json(stationDetail(route.request().url().includes(STATION_EMPTY.id) ? STATION_EMPTY : STATION_OPEN))(route),
  );
  await page.route(/\/api\/v1\/stations\/[^?]+\/(queue-)?history/, json([]));
  await page.route("**/api/v1/notifications*", (route) =>
    route.request().method() === "GET" ? json(notificationsPage())(route) : json({ ok: true })(route),
  );
  await page.route("**/api/v1/monitoring-zones*", json([]));
  await page.route("**/api/v1/favorites*", json([]));
  await page.route("**/api/v1/alerts*", (route) =>
    route.request().method() === "GET" ? json([])(route) : json(createdAlert, 201)(route),
  );
  await page.route("**/api/v1/push/subscriptions*", json([]));

  // SSE realtime: честный контент-тип + стартовое событие revision (R64: сигнал,
  // не данные). Поток НЕ завершаем — фолбэк-тело в route.fulfill разорвал бы
  // соединение, EventSource увидел бы ошибку и показал «offline».
  await page.route("**/api/v1/realtime/stream", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_600_000));
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: "id: -\nevent: revision\ndata: 1|1|1\n\n",
    });
  });
}

/** POST /reports — GPS-подтверждённый отчёт (регистрировать ПОСЛЕ installApiMocks). */
export async function mockReportAccepted(page: Page) {
  await page.route("**/api/v1/reports", (route) =>
    json(
      {
        id: 1,
        station_id: STATION_OPEN.id,
        gps_confirmed: true,
        distance_to_station_m: 120,
        created: true,
        created_at: now,
      },
      201,
    )(route),
  );
}

/** Лента уведомлений с заданными событиями (регистрировать ПОСЛЕ installApiMocks). */
export async function mockNotificationsWith(page: Page, items: NotificationItem[]) {
  await page.route("**/api/v1/notifications*", (route) =>
    route.request().method() === "GET" ? json(notificationsPage(items))(route) : json({ ok: true })(route),
  );
}

/** Профиль вместо анонима (регистрировать ПОСЛЕ installApiMocks — позже = важнее). */
export async function mockAuthUser(page: Page, telegramId = "e2e-user") {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: 1,
          telegram_id: telegramId,
          email: null,
          display_name: "E2E user",
          role: "USER",
          reliability_score: 0.5,
        },
      }),
    }),
  );
}

/** Реакция на POST /alerts — можно вернуть ошибку для проверки честного сообщения. */
export async function mockAlertsCreate(page: Page, status: number, body: unknown) {
  await page.route("**/api/v1/alerts*", (route) =>
    route.request().method() === "GET" ? json([])(route) : json(body, status)(route),
  );
}

/**
 * Внешние ресурсы: карта инициализируется без сети. Тайлы — прозрачный PNG 1×1,
 * глифы/спрайты — пусто (подписи кластеров в E2E не проверяем). Прочее внешнее — abort.
 */
export async function stubExternalResources(page: Page) {
  const transparentPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  // Порядок важен: Playwright применяет ПОСЛЕДНИЙ зарегистрированный route.
  // Сначала catch-all abort для всего внешнего, затем специфичные fulfill —
  // они перекроют abort для нужных хостов.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  await page.route("**://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: transparentPng }));
  await page.route("**://demotiles.maplibre.org/**", (route) => route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.alloc(0) }));
  await page.route("**://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("**://fonts.gstatic.com/**", (route) => route.fulfill({ status: 200, contentType: "font/woff2", body: Buffer.alloc(0) }));
}

/** Service worker отключаем — детерминизм важнее офлайн-кэша (он не предмет T15). */
export async function disableServiceWorker(page: Page) {
  await page.route("**/sw.js", (route) => route.fulfill({ status: 204 }));
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator.serviceWorker, "register", {
        value: () => Promise.reject(new Error("sw disabled in e2e")),
        configurable: true,
      });
    } catch {
      // не критично: /sw.js уже отдаёт 204, регистрация не завершится
    }
  });
}

/**
 * Базовая установка страницы для любого E2E-сценария:
 * 1. отключаем service worker — иначе после его активации все /api/v1/stations*
 *    идут мимо page.route (SW-запросы Chromium не перехватывает на уровне
 *    страницы) и проваливаются в реальный backend: 404 «Станция не найдена»;
 * 2. внешняя сеть — заглушки, API — моки. Сценарные моки (mockAuthUser и т.п.)
 *    регистрировать ПОСЛЕ setupBase (позже = важнее).
 */
export async function setupBase(page: Page) {
  await stubExternalResources(page);
  await disableServiceWorker(page);
  await installApiMocks(page);
}

/**
 * Свежее устройство: тур пройден (диалог не перекрывает сценарии). GPS —
 * фиксированная точка в ~140 м от STATION_OPEN (<300 м → «вы рядом», R40):
 * +0.001° широты ≈ 111 м и +0.001° долготы ≈ 79 м на этой широте.
 */
export async function primeDeviceState(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("fr_tour_completed", "1"));
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({
    latitude: STATION_OPEN.latitude + 0.001,
    longitude: STATION_OPEN.longitude + 0.001,
    accuracy: 20,
  });
}
