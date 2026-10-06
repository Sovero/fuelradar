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

PWA-система независимой агрегации данных о наличии топлива на АЗС (пилот — Краснодар). Для агента, впервые открывшего репозиторий: основная сборка завершена полностью — 15/15 тасков (T14/T15 закрыты).

## Команды (проверены 09.09.2026)

Новая машина (Windows) — один скрипт вместо всего списка ниже: `powershell -ExecutionPolicy Bypass -File .\setup.ps1` (или двойной клик `setup.cmd`). Создаёт venv, ставит зависимости backend+frontend, генерирует `.env`/`frontend/.env.local`, сеет демо-каталог, запускает оба сервера. Идемпотентен — тот же скрипт обновляет уже развёрнутое окружение (`git pull` + переустановка зависимостей).

```
make install                              # pip install backend + npm install frontend
make dev                                  # backend: uvicorn app.main:app --reload --port 8000 (dev — SQLite, без Docker)
cd backend && pytest                      # 354 passed
cd backend && pytest tests/test_api.py    # один файл
cd backend && pytest -k dedup             # по имени
cd backend && ruff check .                # линт, "All checks passed!"
cd backend && python -m cli.seed --region krasnodar --offline   # наполнить каталог из фикстур, без сети
cd frontend && npm install
cd frontend && npm run dev                # localhost:3000, проксирует /api/* на API_INTERNAL_URL
cd frontend && npm run typecheck          # tsc --noEmit, чисто
cd frontend && npm run build              # успешно, ~331 kB First Load JS
cd frontend && npm test                   # vitest run — 258 passed (48 файлов)
cd frontend && npm run test:e2e           # Playwright/Chromium E2E — 9 passed (нужен system Chrome)
make e2e                                  # то же, одной командой
cd frontend && npm test -- ReportForm     # один файл/маска
make compose-up                           # полный docker-compose: api+worker+db(Postgres/PostGIS)+redis+frontend+caddy
make desktop-dist                         # Electron-приложение: NSIS-установщик desktop/dist/FuelRadar-Setup-<v>.exe; сборка замораживает backend внутрь установщика (PyInstaller → resources/backend), поэтому Python на машине пилота не нужен (+ автообновление: фид — Releases приватного репозитория, токен перед сборкой в desktop/.update-feed-token, см. desktop/README.md)
make desktop-smoke                        # smoke-проверка оболочки (backend поднимает сама оболочка — автозапуск)
cd desktop && npm run smoke:first-run      # то же + первый запуск с наполнением демо-каталога из офлайн-фикстур
cd desktop && npm test                     # node --test оболочки — 62 passed
```

`make test` = `pytest` (backend) + `npm run typecheck` (frontend) — не гоняет frontend-тесты, гонять `npm test` отдельно.

## Структура

```
backend/app/
  main.py            — точка входа FastAPI: /health /ready /metrics, монтирует api_router + alerts/analytics/reports роутеры, CORS, обработчик 422
  core/               — config.py (Settings — pydantic-settings, единственный источник дефолтов), metrics.py (in-memory счётчики)
  db/                 — models.py (все таблицы), session.py (SessionLocal/get_db/init_db), migrations.py (идемпотентные post-init миграции), base.py (Base)
  sources/            — SourceAdapter (base.py) + overpass/network_import/user_reports (ACTIVE) + network_lists (реальный HTTP-адаптер сетевых списков АЗС: каталог и НАЛИЧИЕ топлива из одного списка — `fuel` в JSON / колонки `fuel_*` в CSV, `availability_bulk`; NOT_USED до настройки NETWORK_LISTS_URLS, активация через админку), fuel_fields.py (разбор наличия: R13/R15), research.py (RESEARCH_REQUIRED-заглушки без сети), registry.py
  stations/           — ingest.py: source_station_records → мастер-каталог
  normalization/      — fuel.py, names.py — нормализация топлива/брендов/названий
  dedup/              — compare.py (compare_records — чистая функция), service.py (DedupService: авто-слияние/REVIEW/admin_merge/admin_split)
  fuel_status/        — наборы статусов топлива/очереди, инвариант UNKNOWN≠UNAVAILABLE
  confidence/         — aggregate.py (aggregate — чистая функция), service.py (StatusService: запись наблюдений + пересчёт + expire_stale)
  ranking/            — score.py — FuelRadar Score, 7 компонент + ETA
  alerts/             — events.py (diff_event), service.py (evaluate_rules), channels.py (in-app/Web Push/Telegram), router.py, models.py
  reports/            — router.py (POST /reports), service.py (поверх StatusService), schemas.py
  analytics/          — service.py (summarize/deficit_statistics — читают кэш AnalyticsSnapshot), models.py, router.py
  digest/             — service.py — Telegram-дайджест: сводка событий по расписанию (getUpdates/discovery/отправка), настройки в БД
  api/                — stations.py, meta.py, personal.py (favorites/monitoring-zones/alerts — открыты, без профиля), admin.py, settings.py (Telegram-дайджест), deps.py (rate_limit), cache.py, schemas.py
  worker/             — Worker/run_once, schedule_priority_job, locking.py (advisory/файловый лок); __main__.py — точка входа `python -m app.worker`; inprocess.py — фоновый тикер сбора в процессе API (COLLECT_IN_PROCESS — автономный запуск/desktop; пишет наблюдаемое состояние тика `ticker_state()` — его читает админский журнал циклов); health.py — честный сигнал о простое сбора (pure `collection_signal`): его видят `/ready` (статус degraded) и главный экран (`GET /api/v1/collection/health`)
backend/cli/          — seed.py (`python -m cli.seed --region <regions.py> [--offline]`), regions.py
backend/tests/        — по одному файлу на модуль (test_<module>.py) + fixtures/ (офлайн-данные для seed), conftest.py (client/db_session — session-scope)

frontend/app/          — Next.js App Router: page.tsx (главный экран), admin/, settings/, stations/
frontend/components/
  HomeScreen.tsx        — главный экран (шапка, топливо/радиус, табы Карта/Список/Избранное)
  map/                  — MapView.tsx, Legend.tsx
  station/              — StationCard/StationList/ReportForm/HistoryChart/WhyExplanation/StatusBadge
  filters/, favorites/  — FiltersPanel, FavoritesPanel/FavoriteRulesBar
  layout/               — Header, NotificationsPanel, CollectionIdleBanner (R58 — предупреждение «сбор стоит»), MapProviderToggle, ThemeToggle, LocaleToggle
  settings/             — SettingsScreen + Privacy/MonitoringZones/ObservationMode/NetworkPreferences/AlertRules/Push/TelegramDigest панели
  admin/                — AdminScreen + SourcesTable/CollectionCycles/CollectionLog/Coverage/DedupQueue/AdminTokenGate
  onboarding/, providers/, ui/ — OnboardingTour, AppProviders/ServiceWorkerRegister/OfflineReportsSync, EmptyState
frontend/lib/
  api.ts, adminApi.ts   — fetch-обёртки (сессий/ролей нет — приложение открытое, всё доступно запустившему)
  types.ts, filters.ts, format.ts, fuel.ts, availability.ts, geo.ts, i18n.ts, personalization.ts, offlineReports.ts, telegram.ts, collectionCycles.ts (отсчёт/смещение часов для живой вкладки «Циклы сбора»)
  map/                  — types.ts (MapProviderProps — единый контракт), maplibre-provider.tsx, yandex-provider.tsx, index.ts (выбор провайдера), statusColor/brandColor/markerIcon/markerData/cluster/config/osmStyle/yandexLoader
  hooks/                — useMeta, useFilters, useStations, useStationDetail, useFavorites, useNotifications, useTheme, useI18n, useOnboarding, useMapProviderPreference, usePrivacy, useObservationMode, useNetworkPreferences, useMonitoringZones, useAlertRules, useFollowMeZone, useAdminAuth, useRoutePlan, useCollectionHealth, useCyclesRefresh
frontend/public/       — manifest.json, icon.svg, sw.js (PWA, network-first для навигации)
deploy/Caddyfile        — прод-реверс-прокси: /api/* → api:8000, остальное → frontend:3000
desktop/                — Electron-оболочка (Windows): встроенный Next standalone + reverse-proxy /api/* (Origin переписывается), автозапуск локального backend с honest-экраном при недоступности (backend.cjs, config.json → apiBaseUrl/backend.*, самопроверка FUELRADAR_BACKEND_STATUS=1), встроенный backend — заморожен PyInstaller'ом (scripts/prepare-backend.mjs → backend-dist → resources/backend, точка входа backend/desktop_server.py: --data-dir/--seed-offline/--backup-db/--migrate-db, данные в %APPDATA%\FuelRadar\data), вкладка настроек «Данные» (копия/экспорт локальной базы и перенос во внешний Postgres — backend.cjs::maintenanceCommand + IPC fuelradar:db-*, панель frontend/components/settings/DatabasePanel.tsx), NSIS-установщик, автообновление electron-updater, Telegram-popup; сборка `make desktop-dist`, детали desktop/README.md
.claude/launch.json     — дев-превью (`npm run dev --prefix frontend`), не код приложения
```

## Ключевые файлы

- `backend/app/main.py` — все роутеры монтируются здесь; новый роутер добавлять тем же паттерном (`app.include_router(x_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])`).
- `backend/app/core/config.py` — единственное место дефолтов (TTL/интервалы/пороги/веса); не дублировать константы в других модулях.
- `backend/app/db/models.py` — владелец схемы; новые таблицы/поля — только здесь, миграции для прод-БД — `db/migrations.py` (идемпотентно).
- `backend/app/confidence/service.py` — `StatusService.record_fuel_observation`/`recompute_station_fuel`/`recompute_station_queue`/`expire_stale`; сюда встроены хуки `alerts.service.evaluate_rules` — не задваивать вызов записи статуса в других модулях.
- `backend/app/worker/__main__.py` + `backend/app/worker/service.py` — реальный воркер (`python -m app.worker`), `schedule_priority_job()` — единственная точка постановки задания сбора (используется и `POST /admin/sources/{id}/refresh`).
- `backend/app/worker/inprocess.py` — сбор по расписанию в процессе API для автономного запуска (встроенный backend десктоп-сборки, `make dev` без воркера): тот же `Worker.run_once` под общим `worker_lock`, включается настройкой `COLLECT_IN_PROCESS` (десктоп включает её сам).
- `frontend/lib/map/types.ts` (`MapProviderProps`) — контракт карты; `frontend/lib/map/index.ts` — выбор MapLibre/Яндекс по `NEXT_PUBLIC_MAP_PROVIDER`/наличию ключа.
- `frontend/lib/filters.ts` (`Filters`) + `useFilters()` — единственное состояние фильтров, живёт в URL query.
- `frontend/lib/i18n.ts` — оба словаря (ru/en) обновлять вместе, ключ не может существовать в одном и отсутствовать в другом.
- `frontend/lib/adminApi.ts` — админ-fetch поверх cookie-сессии; токенов в sessionStorage больше нет (M16).

## Архитектура

Поток данных: `sources/*` (SourceAdapter, только ACTIVE: osm_overpass/network_import/user_reports/network_lists) → `source_station_records` → `stations/ingest.py` строит/обновляет мастер-каталог → `normalization/*` нормализует топливо/бренды → `dedup/*` сравнивает и авто-сливает/ставит в REVIEW → наблюдения (`fuel_observations`/`queue_observations`, всегда новая строка, история не перезаписывается) → `confidence/aggregate.py` взвешенно голосует (trust×свежесть×репутация×GPS) → `station_current_status` → `ranking/score.py` считает Score (7 компонент) → `api/stations.py` отдаёт наружу → `frontend` рендерит карту/список.

Сбор — только через `worker/` (P1–P4 по приоритету, интервалы/backoff из config); API никогда не дёргает источники синхронно (R83) — `POST /admin/sources/{id}/refresh` лишь создаёт `CollectionJob` через `schedule_priority_job`. Единственное исключение — фоновый тикер `worker/inprocess.py` (автономный/десктоп-запуск, где отдельного воркера нет): он не участвует в обработке HTTP, берёт тот же лок и выключен по умолчанию (`COLLECT_IN_PROCESS`).

MapProvider-абстракция: `lib/map/types.ts::MapProviderProps` — единый интерфейс; `maplibre-provider.tsx` (дефолт, OSM-тайлы, без ключей) и `yandex-provider.tsx` (включается только при непустом `NEXT_PUBLIC_YANDEX_MAPS_API_KEY`) — обе реализации подставляются в `lib/map/index.ts`, вызывающий код (`MapView.tsx`) не знает, какая активна.

Доступ: пользователей/ролей/сессий нет — приложение полностью открытое, всё доступно запустившему (favorites/monitoring-zones/admin отвечают 200 без входа). Единственная подписка на события — Telegram-дайджест (`backend/app/digest/service.py` + `GET/PUT /api/v1/settings/telegram`): оператор вводит токен бота и интервал в настройках UI, чат определяется через getUpdates, сводка событий шлётся воркером по расписанию; без токена канал честно «не настроено», токен наружу не отдаётся (R68) — только отпечаток.

Frontend не ходит в backend напрямую — `next.config.mjs` рёрайтит `/api/:path*` на `API_INTERNAL_URL` (дев: `http://127.0.0.1:8000`); в проде перед обоими стоит `deploy/Caddyfile`.

## Соглашения кода

- Справочники (топливо, бренды, статусы+переводы) — только из `GET /meta`, во frontend никогда не хардкодить список видов топлива/статусов (R98i).
- Регион (город/радиус/координаты карты по умолчанию) — только из `.env`/`.env.local`, в коде backend и frontend имени региона нет (R04/R81).
- UNKNOWN и UNAVAILABLE — разные статусы, ни один код их не конвертирует друг в друга (R15, есть тест-инвариант).
- Наблюдение — всегда новая строка (`fuel_observations`/`queue_observations`), апдейт существующей строки истории запрещён (R17).
- Секреты только в `.env`/`.env.local`, имена — в `.env.example`; при отсутствии секрета канал отвечает явным «не настроено», не имитирует работу и не падает 500.
- Все чистые функции — конкретные модульные точки для юнит-тестов без сети/БД: `confidence.aggregate`, `normalization.normalize_fuel`, `dedup.compare_records`, `ranking.score`, `alerts.events.diff_event`.
- Новый ключ i18n — сразу в оба словаря `frontend/lib/i18n.ts` (ru и en), не в один.
- Новый провайдер карты — реализовать `MapProviderProps` целиком, не расширять интерфейс под частный случай одной реализации.

## Окружение

`.env.example` (backend, читается из корня `backend/` через `env_file=".env"`):
- `DEBUG`, `DATABASE_URL` — SQLite (dev) / PostgreSQL+PostGIS (prod)
- `REDIS_URL` — пусто → метрики in-memory на процесс (`/metrics` у api не увидит счётчики воркера); задать — оба процесса делят один хэш (`core/metrics.py`), недоступный Redis тихо откатывается на in-memory
- `DEFAULT_REGION_CITY`, `DEFAULT_REGION_RADIUS_KM` — регион (данные, не код)
- `OVERPASS_ENDPOINT`, `NETWORK_IMPORT_PATH` — источники каталога
- `DEDUP_AUTO_MERGE`, `DEDUP_NEEDS_REVIEW`, `DEDUP_WEIGHTS` — пороги/веса дедупликации
- `CONFIDENCE_SHARE_STRONG`, `CONFIDENCE_SHARE_LIKELY`, `CONFIDENCE_MIN_WEIGHT`, `GPS_BOOST`, `GPS_PENALTY`, `QUEUE_SECONDS_PER_VEHICLE`, `AVG_SPEED_KMH`, `SCORE_WEIGHTS` — Confidence Engine и Score
- `TELEGRAM_BOT_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — секреты каналов, пусто → канал «не настроено»; токен Telegram-дайджеста также можно задать через настройки UI (хранится в БД, наружу не отдаётся)
- `CORS_ORIGINS`, `RATE_LIMIT_PER_MINUTE` (0 — выключить), `ADMIN_RATE_LIMIT_PER_MINUTE` (отдельный per-IP лимит admin API, 0 — выключить), `API_CACHE_TTL_SECONDS`
- `TELEGRAM_DIGEST_CHAT_ID` (опционально), `TELEGRAM_DIGEST_INTERVAL_MINUTES` — дефолты дайджеста, приоритет у настроек из UI
- `WORKER_TICK_SECONDS`, `WORKER_BACKOFF_MAX_MINUTES` — воркер
- `COLLECT_IN_PROCESS` — сбор по расписанию в процессе API (автономный запуск: встроенный backend десктоп-сборки); пусто/0 — сбор ведёт `python -m app.worker`
- `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` — дублируется здесь для docker-compose, реально читается frontend из своего `.env.local`

`frontend/.env.example` (Next.js читает только отсюда, не из корня):
- `API_INTERNAL_URL` — куда `next.config.mjs` рёрайтит `/api/*`
- `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` — пусто → Яндекс-провайдер не используется, к сервису не обращается
- `NEXT_PUBLIC_MAP_PROVIDER` — явный выбор `yandex|maplibre`, переопределяет автоопределение по ключу
- `NEXT_PUBLIC_DEFAULT_MAP_LAT`, `NEXT_PUBLIC_DEFAULT_MAP_LON` — начальный вьюпорт карты
- `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — публичное имя бота для виджета входа; сам токен на фронт не попадает

## Тесты

- Backend: `backend/tests/test_<module>.py`, один файл на модуль/API-поверхность (`test_api.py`, `test_dedup.py`, `test_worker.py`, `test_alerts.py`, `test_reports.py`, `test_analytics.py`, `test_confidence.py`, `test_confidence_freshness.py`, `test_ranking.py`, `test_normalization.py`, `test_fuel_status.py`, `test_sources.py`, `test_ingest.py`, `test_seed_cli.py`, `test_migrations.py`, `test_schema.py`, `test_health.py`, `test_desktop_server.py` — разбор аргументов/окружения точки входа встроенного backend, `test_worker_inprocess.py` — тикер сбора в процессе API, `test_collection_cycles.py` — админский журнал циклов сбора, `test_availability_lists.py` — наличие топлива из сетевых списков без отметок водителей, `test_db_transfer.py` — копия локальной SQLite и перенос данных во внешнюю базу, `test_collection_signal.py` — сигнал о простое сбора и `GET /api/v1/collection/health`, `test_regions.py` — газетир регионов, `test_session.py` — аргументы соединения с БД). Гонять один файл: `pytest tests/test_dedup.py`; по имени теста: `pytest -k merge`. 354 passed.
- Frontend: рядом с модулем как `*.test.ts(x)` (например `frontend/lib/geo.test.ts`, `frontend/components/station/ReportForm.test.tsx`). Один файл/маска: `npm test -- ReportForm`. 258 passed (48 файлов).
- E2E: `frontend/e2e/*.spec.ts` (Playwright, Chromium, 9 сценариев), общий раннер `npm run test:e2e`; моки/фикстуры — `frontend/e2e/mocks.ts` (setupBase — базовая установка: SW отключён + внешние заглушки + API-моки; сбор в порядке), ассерты консоли — `frontend/e2e/console.ts`.
- Офлайн-фикстуры для `seed`: `backend/tests/fixtures/`.

## Подводные камни

- `make dev` сам выставляет `DEBUG=true CORS_ORIGINS=http://localhost:3000` — без них при раздельном запуске (`uvicorn` напрямую) любой POST/PUT/PATCH/DELETE через прокси Next.js получает `403 Недопустимый источник запроса` (browser Origin ≠ адрес backend). В проде оба идут за одним Caddy — один origin, переменные не нужны. Отдельно: `Settings.model_config.env_file` (`core/config.py`) раньше был относительным (`".env"`) — pydantic-settings резолвит его от CWD процесса, а при `cd backend && uvicorn ...` CWD оказывается `backend/`, где `.env` нет, и корневой `.env` молча игнорировался целиком (не только DEBUG/CORS_ORIGINS). Исправлено на абсолютный путь до корня репозитория. Тесты при этом обязаны оставаться герметичными — `conftest.py` выставляет `FUELRADAR_NO_ENV_FILE=1`, чтобы реальный `.env` разработчика не тёк в прогон тестов.
- `setup.ps1` (корень репозитория) — разворачивает окружение на новой машине с нуля: venv, зависимости, `.env`/`frontend/.env.local` из примеров (DEBUG/CORS для dev), демо-данные офлайн, запуск обоих серверов. Идемпотентен, `git pull` внутри — годится и для обновления уже развёрнутого окружения. Двойной клик — `setup.cmd`.
- `backend/tests/conftest.py::db_session` — `scope="session"`, одна SQLite-БД на весь прогон backend-тестов; тест, оставляющий "висящую" запись (например PENDING `CollectionJob`), может задеть партиционный уникальный индекс `uq_collection_active` в другом файле теста — уже случалось между `test_api.py` и `test_ingest.py`, лечится доведением job до терминального статуса в тесте, который его создал.
- Next.js читает `.env*` только из `frontend/`, не из корня репозитория — переменные `NEXT_PUBLIC_*` в корневом `.env.example` там только для докера/справки, реальный источник для `npm run dev` — `frontend/.env.local`.
- `MapProviderProps` (`frontend/lib/map/types.ts`) — единственный контракт между `MapView.tsx` и обеими реализациями; добавление поля ломает вторую реализацию молча, если не обновить обе.
- Переменная без `NEXT_PUBLIC_` префикса не попадает в браузерный бандл — секреты вроде `TELEGRAM_BOT_TOKEN` намеренно не имеют клиентского аналога, есть только `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`.
- `dedup_weights`/`score_weights` в `core/config.py` — dict-поля pydantic-settings; переопределение через `.env` ожидает JSON-строку (см. комментарии в `.env.example`), не плоские ключи.
- R25/R77 (сетевые предпочтения в правилах/сортировке) — сознательно нереализованы на backend (`/meta` не отдаёт числовой `id` бренда, `GET /stations` не принимает `preferred_brands`); фронтенд компенсирует клиентским реордером (`lib/personalization.ts`) — не пытаться "починить" через выдуманный параметр API, это документированный пробел, а не баг.

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
- T05: Публичный API (`backend/app/api/` — `/api/v1`: stations/nearby/history/meta/favorites/monitoring-zones/alerts + admin, M16: RBAC вместо токена) и безопасность (`backend/app/auth/` — JWT в httpOnly-cookie, bootstrap/пароль/dev/magic-link/Telegram-вход): CORS-белый список, rate limiting, Pydantic-валидация (422 на русском), кэш карты/списка (R82). `status_explanation`/`score_breakdown`/`eta` в карточке станции (R92). Frontend ходит к API через прокси Next.js (`API_INTERNAL_URL`), `Caddyfile` разводит `/api/*` → api. Тесты: 106 passed.
- T08: Аналитика (`backend/app/analytics/`) — Coverage по региону/bbox/городу, покрытие по источникам до/после дедупа без раздувания повторным сбором (R52), Fuel Availability Index с явным исключением UNKNOWN/неоднозначных станций из знаменателя (R48), агрегаты дефицита по истории (частота/длительность/восстановление, TTL-разрывы не выдумывают длительность — R47). Пересчёт фоновый, `/admin/coverage*|/fuel-index|/deficit-stats` только читают кэш (503 без прогрева). Тесты: 106 passed.
- T07: Уведомления (`backend/app/alerts/`) — событийный движок (diff состояния → FUEL_APPEARED…STATION_NEW), оценка правил по scope (zone/favorites/network/координаты), дедуп событий (R37/R38), каналы in-app/Web Push/Telegram (последние — по ключам из .env, иначе «не настроено»). Отчёты (`backend/app/reports/`) — `POST /reports` поверх существующего `StatusService`, GPS-вес <300 м, идемпотентность. `GET/POST /notifications` — лента и счётчик (A03). Тесты: 137 passed.
- T09: Frontend-ядро (Next.js App Router, `frontend/app|components|lib`) — карта за абстракцией `MapProvider` (MapLibre+OSM по умолчанию, бесплатно; Яндекс.Карты — опционально, только при `NEXT_PUBLIC_YANDEX_MAPS_API_KEY`, с пользовательским тумблером, R102/R102.1), маркеры цветом по статусу топлива + кольцом по сети (R103, независимые — без кольца), список/фильтры/карточка станции/пустые состояния по макету, PWA. Сверх тикета по прямым просьбам пользователя: тема свет/тёмная (R99), язык RU/EN (R100, `/meta` отдаёт `name_en`), ознакомительный тур (R101). Тесты: 46 passed (vitest), typecheck/build чисты.
- T10 (последний): персонализация — зоны мониторинга (CRUD + «следить вокруг меня»), приватность (GPS off/ручная точка/забыть позицию), реальная форма «Сообщить» с офлайн-очередью, полная лента уведомлений, вход magic-link/Telegram. Админка (`app/admin`) — источники + журнал загрузок (R104), покрытие/индекс, очередь слияний, пользователи и отчёты (админ-токен — вводится человеком, `sessionStorage`, не `.env`). По ходу таска на backend добавлены `GET /admin/reports` и `POST /admin/users/{id}/block` — значились в контракте, но не были реализованы. R25/R77 (сети в правилах/сортировке) — клиентский компромисс: backend не отдаёт числовой id бренда и не хранит персональные приоритеты, см. interfaces.md. Тесты: 76 passed (frontend), 139 passed (backend).

Сборка в текущей волне: 15/15 тасков завершено (все требования брифа закрыты: 102/106 done, 4 inTicket от P0-мелочей ревью). Все требования брифа закрыты, отложены (роадмап) или помечены как заглушка/клиентский компромисс — детали в `.autopilot/fuelradar/manifest.md`.

Пост-приёмочная доводка (по прямому запросу пользователя «реши все проблемы» — оба открытых пункта из отчёта приёмки):
- `/metrics` был пуст у api-процесса (счётчики писал только воркер) — `core/metrics.py` получил опциональный Redis-бэкенд (`REDIS_URL`), без него поведение прежнее.
- R77/R25: `/meta` теперь отдаёт `id` сети, `GET /stations[/{id}]` принимают `preferred_brands=<id,...>` и персонализируют `Score.user_preferences`, `AlertRulesPanel` предлагает scope «Сеть» (`brand_id`). Побочно найдены и исправлены два реальных бага: `station_detail` дублировал расчёт Score и терял `score_breakdown` для станций без наблюдений (теперь `_station_brief` — единственное место расчёта); `init_db()` создавал таблицы только для уже импортированных моделей — `AlertStateSnapshot`/`AnalyticsSnapshot` регистрировались «повезло если», что ломало изолированный запуск одного тестового файла.
Тесты: 142 passed (backend), 76 passed (frontend).

Волна 8+ — второй проход по требованиям, снятым пользователем с роадмапа (таски 11–15):
- T11: Route Mode (R22, `backend/app/route/` + `frontend/components/route/`) — `POST /api/v1/route/stations`: коридор по polyline ≥2 точек (0,5–50 км, стандартные фильтры), расстояние до ближайшего сегмента, 422 на русском; UI — панель RouteModePanel (клики по карте добавляют точки, честная пометка «коридор, без routing-провайдера»), линия — в обеих реализациях карты через `MapProviderProps.routePolyline`/`onMapClick`. Тесты: 149 passed (backend), 79 passed (frontend).
- T12: Прогноз/heatmap/районы дефицита (R49/R50/R79, `backend/app/analytics/forecast.py|heat.py`, `frontend/lib/heatmap.ts`) — прогноз-эвристика (не ML) только из снэпшота аналитики: «появление» по доле завершённых эпизодов + ETA, «исчезновение» по Пуассону, мало данных → null + русская причина, `is_forecast=true`; heatmap — круги `MapProviderProps.heatCircles` в обеих картах, неоднозначные статусы не голосуют (ячейки нет), легенда с текстом; BI — `GET /admin/deficit-by-region` с размером выборки и предупреждением о пилотных данных (вкладка админки). Тесты: 156 passed (backend), 85 passed (frontend).
- T13: Цена топлива end-to-end (R78) — nullable цена/валюта/время/источник в текущем агрегате и идемпотентная additive-миграция; `POST /reports` принимает цену вместе со статусом и пишет append-only observation с валидацией; список/detail/favorites и Route Mode возвращают/учитывают `price_max`; последняя свежая цена не затирается пустым новым опросом до TTL; карточка/список/форма показывают цену, время/источник и «нет данных» на RU/EN. Тесты: 173 passed backend, 88 passed frontend; ruff/typecheck/build чистые.
- T14: Realtime/Web Push (R64/R97i, `backend/app/realtime/` + `frontend/lib/hooks/useRealtime.ts`) — SSE `GET /api/v1/realtime/stream`: сигнал `revision` (max-id станций/наблюдений, append-only R17) + heartbeat + `Last-Event-ID`, лимит `sse_max_clients`; клиент переподтягивает `/stations` обычным GET (R82 не дублируется), при обрыве данные не трогаются. Web Push — реально: `push_subscriptions` (идемпотентный POST по endpoint, endpoint только https, keys base64url-валидация, наружу без ключей R68), доставка pywebpush всем активным подпискам, 404/410 → деактивация, ошибки изолированы; `/meta` отдаёт `push.enabled`+публичный VAPID key; панель в настройках («Push») и обработчики `push`/`notificationclick` в `sw.js` (клик → `/?station=<id>`). Тесты: 191 passed backend (+18 realtime), 96 passed frontend; ruff/typecheck/build чистые.
- T15: Браузерные E2E (R88, `frontend/e2e/` + `frontend/playwright.config.ts`) — 5 Playwright-тестов в Chromium, запуск `npm run test:e2e` или `make e2e` (~10 с): zero-console smoke домашнего экрана (карта+realtime+фильтр+список), коридор маршрута (2 точки → запрос коридора), «Следить» → правило → уведомление в ленте, отчёт с GPS (гость → логин; профиль → форма → успех). API и внешняя сеть — локальные моки на уровне страницы, service worker в E2E отключён (SW-запросы Chromium мимо page.route); trace/screenshot только при падении; селекторы — роли/доступные имена. Chromium — системный Chrome (`channel: "chrome"`: CDN Playwright в среде сборки недоступен); Тесты: 192 passed backend, 98 passed frontend, 5 E2E.
- Пост-приёмочная доводка: вкладка «Обновления» в настройках desktop-оболочки — версия из `window.fuelradarDesktop.version` и ручная проверка обновлений через `fuelradarDesktop.checkForUpdates()` (IPC `fuelradar:check-updates` из desktop/main.cjs); в браузере вкладка не показывается вовсе. Честные состояния: dev-запуск → «обновлять не с чего», сбой фида → «последняя (но проверить не удалось)», отказ моста → «не удалось проверить».
- Пост-M16 волна: дорожный маршрут (R22.1) — `backend/app/routing/` (OSRM-совместимый роутер, `POST /api/v1/route/plan`; чистый разбор `parse_route_payload`, честные причины `not_configured`/`provider_unavailable`/`no_route`), линия на обеих картах идёт по улицам (профиль `driving` — односторонние и запреты поворотов учитывает граф OSM), подпись км/мин и список маневров берутся из роутера, коридор АЗС считается по дорожной геометрии (прореживание до 100 точек). Конфиг — `ROUTING_BASE_URL`/`ROUTING_PROFILE`/`ROUTING_TIMEOUT_SECONDS` (публичный демо-OSRM — только для дев/пилота, для прода поднять свой инстанс). Тесты: 254 backend, 169 frontend, 6 E2E.

Волна desktop-автономности (по прямым просьбам пользователя: «backend внутри установщика» → «исправь все недочёты и собери новое приложение»):
- Встроенный backend (PyInstaller one-dir, `backend/desktop_server.py`, `desktop/scripts/prepare-backend.mjs`) едет в `resources/backend` — на машине пилота нет Python/venv; данные в `%APPDATA%\FuelRadar\data`, первый запуск может наполнить каталог офлайн-фикстурами (`backend.seedRegion`).
- Сбор по расписанию: у установленного приложения нет процесса воркера, поэтому расписание ведёт фоновый тикер того же процесса (`app/worker/inprocess.py`, `COLLECT_IN_PROCESS`, общий `worker_lock`) — раньше TTL статусов истекал (все АЗС UNKNOWN), а задания из админки не исполнялись; десктоп включает тикер сам, серверные развёртывания — нет.
- Внешняя база: `backend.databaseUrl`/`DATABASE_URL` переключает встроенный backend на общий Postgres/PostGIS, psycopg едет в установщике (проверяется сборочным шагом), пароль не показывается на экране/в логе, демо-фикстуры во внешнюю базу не пишутся.
- Найден и исправлен попутный баг: `DEFAULT_REGION_RADIUS_KM` игнорировался, когда регион задан именем города (и воркер, и `seed` собирали по радиусу газетира).
Тесты: 286 backend, 58 desktop (node --test); прогоны больше не копят временные каталоги в системном temp (conftest закрывает пул соединений и убирает за собой).

Волна админского журнала циклов сбора (по прямой просьбе пользователя: «время последнего успешного сбора по источникам, следующий тик и причины сбоев»):
- `GET /api/v1/admin/collection-cycles` + вкладка «Циклы сбора»: по каждому источнику — время последнего успешного сбора (`source_health.last_success_at`), следующий запуск (ближайшее активное задание, иначе план последнего завершённого; прошедший план честно «просрочено»), последний цикл (статус/записи/триггер/время) и причина сбоя (число неудач подряд + класс ошибки, R68 — без текста HTTP-ошибок). Сверху — состояние планировщика: режим (в этом процессе / отдельный воркер / выключен), такт `WORKER_TICK_SECONDS`, очередь заданий и последний/следующий тик. «Следующий тик» пишет сам цикл (`worker/inprocess.py::record_tick`/`ticker_state`); у отдельного воркера он честно помечен как невидимый — админка не выдумывает время.
- `user_reports` (push-источник, не опрашивается) и неактивные источники помечены каждый своей причиной, а не одной общей фразой.
Тесты: 292 backend (`test_collection_cycles.py` — 5, `test_worker_inprocess.py` — состояние тика), 220 frontend (43 файла, `AdminCollectionCycles.test.tsx` — 7); ruff/typecheck/build чистые.

Волна первого реального источника НАЛИЧИЯ топлива (по прямой просьбе пользователя: «подключи первый реальный источник данных о наличии топлива, чтобы статусы обновлялись без отчётов водителей»):
- Публичного API наличия в РФ нет (сайты «где бензин» — это те же отметки водителей; власти публикуют перечни списками/через чат-боты) — поэтому реальным источником сделаны **сетевые списки**: один файл от сети/регионального штаба/городского портала, где у каждой АЗС есть статусы топлива. `network_lists` из discovery-only стал первым источником наличия без водителей: `fuel: {"АИ-95": "есть"}` в JSON/GeoJSON или колонки `fuel_аи-95` в CSV (`sources/fuel_fields.py`, алиасы `fuel:`/`топливо_`/`наличие-`), опционально `observed_at`.
- Наличие приезжает ВМЕСТЕ с каталогом одним запросом: `availability_bulk` в capabilities → `plan()` не ставит точечные задания на каждую АЗС, а `worker.service.apply_bulk_availability` пишет наблюдения через тот же `StatusService` (Confidence/TTL/алерты), с `idempotency_key` — повторная выгрузка того же списка не удваивает свидетельства (R17). Сбой записи наличия — отдельная строка в журнале, каталог остаётся DONE (R84). `StatusService.record_fuel_observation` получил `commit=False` для пакетной записи (один коммит на выгрузку, не на АЗС).
- R13/R15 не ослаблены: непонятный статус («уточняется») и незнакомое топливо — пропуск со счётчиком в журнале («availability: 8 наблюдений, 1 значений не распознано»), а не «нет топлива»; объявленное, но неразобранное `observed_at` заставляет пропустить строку целиком — свежесть не выдумывается (R56).
- Сид `network_lists` (базы до этой волны — идемпотентная миграция `upgrade_network_lists_availability`): capabilities + availability_bulk, `min_interval_minutes` 1440 → 15 (только если оператор не менял сам; TTL статуса 2 ч, суточный потолок дал бы вечные UNKNOWN).
- Живой сквозной прогон: список на локальном HTTP → `PUT /admin/sources/network-lists` → тик сбора → публичный `/stations` отдаёт «АЗС Красная 12: AI_95=AVAILABLE, DIESEL=UNAVAILABLE» при `total=0` отчётов водителей; в журнале задания — `availability: 8 наблюдений, 1 значений не распознано`.
Тесты: 310 backend (`test_availability_lists.py` — 12 сквозных через настоящий адаптер и SQLite, `test_sources.py` +5 разбора наличия, `test_migrations.py` +1 про границы миграции); ruff чистый; frontend не тронут (только подсказки в админке, ru+en — 220 тестов без изменений).

Волна «экспорт и бэкап локальной базы с переносом в Postgres» (по прямой просьбе пользователя: «добавь в настройки десктопа экспорт и бэкап локальной базы с переносом данных в Postgres»):
- Встроенный backend получил две служебные команды (`backend/desktop_server.py`), обе печатают одну ASCII-JSON-строку и пароль внешней базы не раскрывают (R68): `--backup-db [PATH]` — консистентный снимок локальной SQLite штатным онлайн-бэкапом (по умолчанию `<данные>/backups/fuelradar-<UTC-штамп>.db`, в отчёте путь/размер/таблицы/строки), `--migrate-db [--to-database-url URL]` — перенос накопленного во внешний Postgres/PostGIS.
- Перенос (`app/db/transfer.py`) идёт **со снимка** локальной базы (согласованный момент времени, приложение продолжает работать), схему цели создаёт из тех же моделей, строки вставляет пачками с `ON CONFLICT DO NOTHING` (повторный запуск безопасен: «вставлено 0, пропущено N»), после данных накатывает идемпотентные миграции и сиды штатным `init_db()` и догоняет SERIAL-последовательности цели до максимумов перенесённых id (иначе следующая вставка приложения получила бы занятый id). Предпроверки честные: только SQLite→Postgres, не свой же адрес, без цели — «укажите backend.databaseUrl…».
- Оболочка: `backend.cjs` получил `maintenanceCommand`/`parseMaintenanceReport`/`databaseStatus` (чистые функции), `main.cjs` — IPC `fuelradar:db-status|db-backup|db-export|db-migrate|db-reveal` (экспорт — системный диалог сохранения; нечем запускать — честное «нечем»), мост — в `preload.cjs`.
- Настройки: вкладка «Данные» (desktop-only, `frontend/components/settings/DatabasePanel.tsx`) — где лежит база и её размер, последняя копия, кнопки «Создать резервную копию»/«Экспортировать копию…» и «Перенести данные» с целью без пароля; результат цифрами, ошибки причиной, без внешней базы — «не настроено»; ключи ru+en.
- Живой прогон (dev-путь, те же флаги, что у оболочки): `--seed-offline` → `--backup-db` (59 строк, 241 КБ, файл на месте) → экспорт в выбранный путь → `--migrate-db` без цели (exit 4, честный JSON) → `--migrate-db` на недоступный Postgres (`OperationalError`, адрес в отчёте замаскирован — пароль не утёк). Тот же путь прогнан на ЗАМОРОЖЕННОМ бинарнике (`npm run prepare:backend`; флаги видны в `--help`, код выхода 5) и в самой оболочке: `npm run smoke` печатает `FUELRADAR_SMOKE_DB_BACKUP ok rows=26` и `FUELRADAR_SMOKE_DB_MIGRATE unconfigured` — то есть мост, бэкенд и разбор JSON проверены в реальном Electron. Настоящего Postgres на машине нет (ни Docker, ни локальной службы), поэтому перенос в живую Postgres-базу НЕ проверялся: диалектная ветка проверена компиляцией `ON CONFLICT DO NOTHING` для диалекта Postgres и юнит-тестами копирования.
Тесты: 338 backend (`test_db_transfer.py` — 18, `test_desktop_server.py` +10), 62 desktop (`node --test`), 228 frontend (44 файла, `DatabasePanel.test.tsx` — 7, `format.test.ts` +1); ruff/typecheck чистые.

Волна честного сигнала о простое сбора (по прямой просьбе пользователя: «если расписание выключено или план просрочен надолго, показывай предупреждение на главном экране и в /ready, а не только в админке»):
- `backend/app/worker/health.py` — единый источник сигнала: чистая `collection_signal(now, facts, ...)` (ok / disabled / overdue / stalled / unplanned + машинный `reason`, `age_minutes`, `overdue_minutes`) и тонкая обвязка `collection_facts`/`collection_report` над `source_health`/`collection_jobs`/`ticker_state`. «Свежий успех важнее режима»: живой внешний воркер при выключенном `COLLECT_IN_PROCESS` даёт `ok`, а не ложное «расписание выключено»; идущее задание считается работой только пока оно свежее (зависший RUNNING не прячет простой).
- Публичный `GET /api/v1/collection/health` (без админки и без текстов ошибок источников — R68) и `/ready` с третьим состоянием `degraded` + блоком `collection`: мониторинг видит «данные не обновляются», а не только «процесс жив». Пороги — `COLLECTION_STALE_MINUTES` (180) / `COLLECTION_OVERDUE_MINUTES` (30) в конфиге и `.env.example`.
- Главный экран: хук `useCollectionHealth` (перепроверка по realtime-событию и раз в 5 минут — простой случается, пока окно открыто) + баннер `CollectionIdleBanner` над картой: причина, «статусы АЗС могут быть устаревшими», последний успех, просрочка плана, идущие задания; ключи ru+en, состояние `ok` не шумит, а сетевой сбой не превращается в выдуманное предупреждение.
- Проверено: E2E `frontend/e2e/collection-idle.spec.ts` (молчащий сбор → баннер на главном экране, консоль чистая) — 9 E2E.
- Живой прогон: uvicorn на временной базе — пустой каталог → `/ready` `degraded` (`reason: nothing_planned`); свежий успех в `source_health` → `ready`/`ok` (режим `external` без ложного «расписание выключено»); успех 5 ч назад + задание, просроченное на 2 ч → `degraded`/`overdue` (`overdue_minutes: 120`, `age_minutes: 300`); `COLLECT_IN_PROCESS=1` без региона → `disabled`/`schedule_off` с честной причиной в `mode_reason`. Оболочка (`npm run smoke` / `smoke:first-run`) печатает `FUELRADAR_SMOKE_COLLECTION unplanned` на пустом каталоге и `ok` после офлайн-наполнения — сигнал не врёт в обе стороны; в упавшем smoke-прогоне временный каталог теперь убирается после выхода backend (раньше оставался).
Тесты: 353 backend (`test_collection_signal.py` — 13, `test_health.py` +2 про degraded/not_ready), 239 frontend (46 файлов, `CollectionIdleBanner.test.tsx` — 7, `useCollectionHealth.test.tsx` — 4); ruff/typecheck/build чистые.

Волна живой вкладки «Циклы сбора» (по прямой просьбе пользователя: «автообновление с обратным отсчётом до следующего тика и подсветкой источника, у которого цикл идёт прямо сейчас»):
- Журнал обновляется сам с периодом, который задаёт оператор полем «живое обновление» (дефолт 60 с, границы 5–3600; `normalizeRefreshSeconds` + хук `useCyclesRefresh` с localStorage): значение применяется по Enter/blur, в поле остаётся нормализованное («3» → 5, нечисловое → 60), скрытое окно не опрашивается, а возвращение обновляет сразу, запросы не наслаиваются (пока ответ не пришёл, нового нет). Рядом с заголовком — поле периода («живое обновление · каждые 60 с») и «обновлено N с назад»; сбой фонового опроса не стирает журнал, а честно помечает его: «не удалось обновить журнал — на экране данные N с назад».
- Обратный отсчёт — по серверным часам: ответ несёт `now`, по нему считается смещение часов браузера (`serverClockSkewMs`), иначе на машине со сбитым временем отсчёт показывал бы часы вместо секунд. Секунды в последнюю минуту (`через 45 с`), дальше минуты/часы; прошедший тик — «сейчас» (сборщик вот-вот вернётся), просроченный надолго — «просрочено». Текст собирается в компоненте (ru+en), математика — в `lib/collectionCycles.ts` (чистые функции + юнит-тесты).
- Подсветка — по факту, а не по догадке: `GET /admin/collection-cycles` отдаёт по источнику `active_job_status` (PENDING — «в очереди», RUNNING — уже собирается: раньше эти состояния были неотличимы), `running_jobs`/`running_job_id`/`running_since`. Строка источника с RUNNING подсвечивается, рядом подпись «идёт сейчас · 20 с · задание №8 · заданий: 2»; для PENDING остаётся «в очереди, задание №N». Зависшее RUNNING так же честно исчезает: каждый тик `run_once` возвращает брошенные задания в PENDING.
- Живой прогон (uvicorn на временной БД + `COLLECT_IN_PROCESS`, медленный список наличия на локальном HTTP с задержкой 25 с): вкладка без перезагрузки сама показала «идёт сейчас · 5 с · задание №8» → «идёт сейчас · 20 с» → после завершения подсветка ушла сама, а в журнале остался `DONE · записей: 1`; ответ API и экран совпадали в каждой точке (проверено также `data-running` в DOM).
Тесты: 354 backend (`test_collection_cycles.py` — 6: RUNNING-задание как факт, PENDING — не «идёт»), 258 frontend (48 файлов, `AdminCollectionCycles.test.tsx` — 16 про подсветку/отсчёт/период в поле/сбой опроса/скрытое окно, `collectionCycles.test.ts` — 5 про смещение часов и нормализацию периода, `useCyclesRefresh.test.tsx` — 5 про дефолт 60 с и localStorage); ruff/typecheck/build чистые, E2E 9.
<!-- autopilot:end -->

<!-- IJFW-MEMORY-START -->
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.
<!-- IJFW-MEMORY-END -->

<!-- IJFW-AGENTS-START -->
No project agents yet. Run `ijfw team` to set them up.
<!-- IJFW-AGENTS-END -->
