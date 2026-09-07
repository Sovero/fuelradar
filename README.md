# FuelRadar

PWA-система независимой агрегации данных о наличии топлива на АЗС (пилот — Краснодар).

Собственный мастер-каталог АЗС из нескольких источников; отделение факта существования
станции от факта наличия топлива; честное различие «нет» и «не знаю»; достоверность
каждого статуса с объяснением; очереди и ETA; уведомления по правилам пользователя.

Стек: FastAPI (Python) + SQLite (dev) / PostgreSQL+PostGIS (prod) + Next.js (React, TypeScript, Tailwind) + MapLibre GL.

## Команды

| Команда | Что делает |
|---------|------------|
| `make install` | Установить зависимости (backend pip + frontend npm) |
| `make dev` | Запустить API локально (uvicorn, http://localhost:8000) |
| `make test` | Прогнать тесты backend + typecheck frontend |
| `make lint` | Линт backend (ruff) |
| `make compose-up` | Поднять dev-окружение в Docker (api, worker, frontend) |
| `make compose-prod` | Поднять prod-профиль (+PostGIS, Redis, reverse proxy) |

Переменные окружения — `cp .env.example .env`, секреты заполняются пользователем (R68).

## Границы объёма MVP (R90)

Намеренно не строим в первом MVP: нативные приложения, микросервисы, Kubernetes,
ML/LLM на каждый запрос, платный routing API, heatmap, прогноз наличия, route-corridor,
браузерный E2E, реальные цены. Полный список отложенного — в `.autopilot/fuelradar/spec.md` («Вне рамок»).

## Структура

```
backend/app/        модульный монолит (FastAPI): core, db, api, sources, worker, …
frontend/app/       Next.js (App Router), карта — MapLibre GL через абстракцию
.autopilot/         бриф, манифест, спецификация, таски, дашборд
```

Подробная архитектура, API-контракты и инварианты — `.autopilot/fuelradar/tickets/interfaces.md`.