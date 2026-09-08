---
ijfw_version: 1.3.2
ijfw_schema: 1
type: software
primary_type: software
secondary_types: []
confidence: 0.906
detected_at: 2026-09-08T19:04:33.673Z
signals:
  - kind: manifest
    weight: 0.9
    manifests: [Makefile, package.json, pyproject.toml]
  - kind: file_extension_ratio
    weight: 0.7
    domain: software
    ratio: 0.987
    count: 77
---
<!-- autopilot:start -->
# FuelRadar

PWA-система независимой агрегации данных о наличии топлива на АЗС (пилот — Краснодар), модульный монолит: FastAPI + PostgreSQL/PostGIS + Redis, фронт Next.js.

## Как здесь работает Autopilot

Сборка ведётся навыком `/autopilot`. Требования, спецификация и таски — в `.autopilot/`.
Прогресс — `.autopilot/dashboard.html`. Правило: требование из `manifest.md`
может снять только пользователь.

Если работа продолжается — скажи «продолжи автопилот»: состояние поднимется
из `.autopilot/state.json`, переспрашивать ничего не нужно.

## Репозиторий

Собственный git-репозиторий проекта — эта папка (`C:\Projects\Python\fuelradar`
; 07.09.2026 переименована из `fpetrol`), remote `origin` =
https://github.com/Sovero/fuelradar.git (ветка `main`). Коммиты — только здесь;
родительский репозиторий `C:\Projects\Python` FuelRadar больше не трогает.

## Что открыто в сборке (build log)

- T01: каркас FastAPI + схемы §83, сиды словарей, PWA-каркас. Команды: `make dev|test|lint|compose-up`.
- T02: источники через `SourceAdapter` (интерфейс в `backend/app/sources/base.py`); активны только osm_overpass/network_import/user_reports, остальные RESEARCH_REQUIRED и не выполняют сети. Наполнение каталога — `make seed ARGS="--region krasnodar [--offline]"` (offline — фикстуры `backend/tests/fixtures/`). Ошибки источника изолированы (collection_jobs/logs + source_health), данные не удаляются. Тесты: 27 passed.
- T03: из `source_station_records` строится мастер-каталог `stations` (`fr_station_*`): нормализация топлива/брендов (`backend/app/normalization/`), взвешенная дедупликация по §11 (`backend/app/dedup/` — `compare_records`, `DedupService`; автослияние/REVIEW-очередь, админ `admin_merge`/`admin_split` с журналом `dedup_decisions`). `seed` запускает дедупликацию и печатает сводку (`--no-dedup` — отключить). Пороги/веса — конфигурация (DEDUP_*). Тесты: 42 passed.
- T04: Confidence Engine (`backend/app/confidence/` — `aggregate`: взвешенное голосование trust×свежесть×репутация×GPS, конфликты → LIKELY_AVAILABLE/UNCERTAIN; `StatusService`: запись наблюдений новыми строками R17 + пересчёт `station_current_status`, `expire_stale()` → UNKNOWN по TTL R56); Score (`backend/app/ranking/` — 7 компонент с разбором, приоритет сети — только сортировка); наборы статусов и инвариант UNKNOWN≠UNAVAILABLE (`backend/app/fuel_status/`). Пороги — CONFIDENCE_*/QUEUE_*/SCORE_WEIGHTS в конфиге. Тесты: 63 passed. expire_stale в расписание воркера — T06.
- T06: Воркер сбора (`backend/app/worker/` — отдельный процесс `python -m app.worker`, compose-сервис `worker`): приоритеты P1–P4, интервалы и rate-limit из конфига, backoff при сбое источника (данные не тронуты), рестарт с advisory/файловым локом без дублей (`worker_lock`), `schedule_priority_job()` — общая точка постановки задания (использует и `POST /admin/sources/{id}/refresh` из T05). Инвариант «один активный job на источник+тип+станцию» — миграция `db/migrations.py` (идемпотентна, включая prod PostGIS geography-индекс). Тесты: 106 passed (весь backend).
- T05: Публичный API (`backend/app/api/` — `/api/v1`: stations/nearby/history/meta/favorites/monitoring-zones/alerts + admin с `X-Admin-Token`) и безопасность (`backend/app/auth/` — JWT в httpOnly-cookie, dev-вход, magic-link по SMTP_URL, Telegram-вход): CORS-белый список, rate limiting, Pydantic-валидация (422 на русском), кэш карты/списка (R82). `status_explanation`/`score_breakdown`/`eta` в карточке станции (R92). Frontend ходит к API через прокси Next.js (`API_INTERNAL_URL`), `Caddyfile` разводит `/api/*` → api. Тесты: 106 passed.
- T08: Аналитика (`backend/app/analytics/`) — Coverage по региону/bbox/городу, покрытие по источникам до/после дедупа без раздувания повторным сбором (R52), Fuel Availability Index с явным исключением UNKNOWN/неоднозначных станций из знаменателя (R48), агрегаты дефицита по истории (частота/длительность/восстановление, TTL-разрывы не выдумывают длительность — R47). Пересчёт фоновый, `/admin/coverage*|/fuel-index|/deficit-stats` только читают кэш (503 без прогрева). Тесты: 106 passed.
<!-- autopilot:end -->

<!-- IJFW-MEMORY-START -->
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.
<!-- IJFW-MEMORY-END -->

<!-- IJFW-AGENTS-START -->
No project agents yet. Run `ijfw team` to set them up.
<!-- IJFW-AGENTS-END -->
