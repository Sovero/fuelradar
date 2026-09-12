/**
 * Service worker FuelRadar (R05/R05.1): кэш каркаса приложения, тайлов карты
 * OSM и последнего успешного ответа /api/v1/stations — минимально жизнеспособный
 * офлайн-режим (не полный offline-first). Действия, требующие сети (отправка
 * отчёта, вход), сами объясняют пользователю недоступность сети — сервис-воркер
 * их не подменяет фейковыми данными.
 */

const SHELL_CACHE = "fr-shell-v1";
const TILE_CACHE = "fr-tiles-v1";
const API_CACHE = "fr-api-v1";

const SHELL_URLS = ["/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![SHELL_CACHE, TILE_CACHE, API_CACHE].includes(key))
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

// ---------- Push (T14, R64): показать уведомление и открыть карточку станции ----------

/** Payload от backend (alerts/channels.py): {title, body, station_id, event_type}. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "FuelRadar", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "FuelRadar";
  const options = {
    body: data.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.station_id ? `fuelradar-${data.station_id}` : undefined, // не дублируем уведомления по той же АЗС
    data: { station_id: data.station_id || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const stationId = event.notification.data && event.notification.data.station_id;
  const target = stationId ? `/?station=${encodeURIComponent(stationId)}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Уже открытое окно — фокусируем и сообщаем ему про станцию, а не плодим вкладки.
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

function isTileRequest(url) {
  return /tile\.openstreetmap\.org/.test(url) || /\/\d+\/\d+\/\d+\.png$/.test(url);
}

function isStationsApi(url) {
  return url.includes("/api/v1/stations");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = request.url;

  // Тайлы карты — cache-first (R61: карта работает при плохой сети).
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch (err) {
          return cached || Response.error();
        }
      }),
    );
    return;
  }

  // Последний успешный ответ /stations — network-first с кэш-фолбэком (R05.1).
  if (isStationsApi(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(API_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.open(API_CACHE).then((cache) => cache.match(request))),
    );
    return;
  }

  // Навигация (HTML-страница) — ВСЕГДА network-first: React гидратирует HTML
  // с сервера против ЖИВОГО клиентского бандла, и отдача устаревшего HTML из
  // кэша при рабочей сети ломает гидратацию (текст/структура не совпадут).
  // Кэш — только честный офлайн-фолбэк, когда сети действительно нет (R05.1).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.open(SHELL_CACHE).then((cache) => cache.match(request))),
    );
    return;
  }

  // Остальной статичный каркас (манифест и т.п.) — cache-first с обновлением в фоне.
  if (SHELL_URLS.includes(new URL(url).pathname)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
