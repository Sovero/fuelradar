# FuelRadar

PWA-система независимой агрегации данных о наличии топлива на АЗС (пилот — Краснодар).

Собственный мастер-каталог АЗС из нескольких источников; отделение факта существования
станции от факта наличия топлива; честное различие «нет» и «не знаю»; достоверность
каждого статуса с объяснением; очереди и ETA; уведомления по правилам пользователя.

Стек: FastAPI (Python) + SQLite (dev) / PostgreSQL+PostGIS (prod) + Next.js (React, TypeScript, Tailwind) + MapLibre GL.

## Быстрый старт на новой машине (Windows)

```
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```
Или просто дважды кликнуть `setup.cmd`. Создаст venv и `.env`/`frontend/.env.local`,
поставит все зависимости, нальёт демо-каталог АЗС (офлайн, без сети) и запустит
backend (новое окно) и frontend (текущее окно) — откроется на http://localhost:3000.
Тот же скрипт безопасно перезапускать позже для обновления (`git pull` + зависимости).

## Команды

| Команда | Что делает |
|---------|------------|
| `make install` | Установить зависимости (backend pip + frontend npm) |
| `make dev` | Запустить API локально (uvicorn, http://localhost:8000) |
| `make test` | Прогнать тесты backend + typecheck frontend |
| `make lint` | Линт backend (ruff) |
| `make e2e` | Браузерные E2E (Playwright/Chromium) критических сценариев |
| `make compose-up` | Поднять dev-окружение в Docker (api, worker, frontend) |
| `make compose-prod` | Поднять prod-профиль (+PostGIS, Redis, reverse proxy) |

Переменные окружения — `cp .env.example .env`, секреты заполняются пользователем (R68).

## Роли и доступ (M16)

Первый `ADMIN` создаётся через мастер первоначальной настройки при первом открытии
интерфейса (одноразовый bootstrap). Дальше доступ по ролям `USER`/`OPERATOR`/`ADMIN`
через cookie-сессию: чтение админки — OPERATOR+, изменения — ADMIN. Выдача ролей —
CLI: `python -m cli.roles list` / `set --user <email|id> --role OPERATOR` —
подробности в [docs/roles.md](docs/roles.md).

## Источники данных

Каталог строится из нескольких источников (OSM/Overpass, файловый импорт списков
сетей, пользовательские отчёты; HTTP-адаптер сетевых списков — `network_lists` —
ждёт настройки `NETWORK_LISTS_URLS`). Как подключить новый источник — от адаптера
до включения через админку: [docs/new-source.md](docs/new-source.md).

## Состояние roadmap

Завершены T01–T15: каталог и дедупликация, Confidence Engine, публичный API,
воркер, уведомления, frontend, Route Mode, прогноз/heatmap/BI, цена топлива
end-to-end, realtime/Web Push и браузерные E2E.

T13 добавляет nullable цену с временем/источником, `POST /reports` с ценой вместе
со статусом, фильтр `fuel` + `price_max` и честное «нет данных» в UI. Секреты и
внешние источники цен не подставляются автоматически: отсутствующая цена остаётся
отсутствующей.

## Границы объёма MVP (R90)

Намеренно не строим в первом MVP: нативные приложения, микросервисы, Kubernetes,
ML/LLM на каждый запрос, платный routing API. Heatmap, прогноз,
route-corridor и реальные цены реализованы в расширенной волне T11–T13; полный
список оставшихся ограничений — в `.autopilot/fuelradar/spec.md`.

## Структура

```
backend/app/        модульный монолит (FastAPI): core, db, api, sources, worker, …
frontend/app/       Next.js (App Router), карта — MapLibre GL через абстракцию
.autopilot/         бриф, манифест, спецификация, таски, дашборд
```

Подробная архитектура, API-контракты и инварианты — `.autopilot/fuelradar/tickets/interfaces.md`.