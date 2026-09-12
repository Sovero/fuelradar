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
cd backend && pytest                      # 192 passed
cd backend && pytest tests/test_api.py    # один файл
cd backend && pytest -k dedup             # по имени
cd backend && ruff check .                # линт, "All checks passed!"
cd backend && python -m cli.seed --region krasnodar --offline   # наполнить каталог из фикстур, без сети
cd frontend && npm install
cd frontend && npm run dev                # localhost:3000, проксирует /api/* на API_INTERNAL_URL
cd frontend && npm run typecheck          # tsc --noEmit, чисто
cd frontend && npm run build              # успешно, ~331 kB First Load JS
cd frontend && npm test                   # vitest run — 103 passed (29 файлов)
cd frontend && npm run test:e2e           # Playwright/Chromium E2E — 5 passed (нужен system Chrome)
make e2e                                  # то же, одной командой
cd frontend && npm test -- ReportForm     # один файл/маска
make compose-up                           # полный docker-compose: api+worker+db(Postgres/PostGIS)+redis+frontend+caddy
make desktop-dist                         # Electron-приложение: NSIS-установщик desktop/dist/FuelRadar-Setup-<v>.exe (+ автообновление: фид — Releases приватного репозитория, токен перед сборкой в desktop/.update-feed-token, см. desktop/README.md)
make desktop-smoke                        # smoke-проверка оболочки (нужен backend на :8000)
```

`make test` = `pytest` (backend) + `npm run typecheck` (frontend) — не гоняет frontend-тесты, гонять `npm test` отдельно.

## Структура

```
backend/app/
  main.py            — точка входа FastAPI: /health /ready /metrics, монтирует api_router + alerts/analytics/reports роутеры, CORS, обработчик 422
  core/               — config.py (Settings — pydantic-settings, единственный источник дефолтов), metrics.py (in-memory счётчики)
  db/                 — models.py (все таблицы), session.py (SessionLocal/get_db/init_db), migrations.py (идемпотентные post-init миграции), base.py (Base)
  sources/            — SourceAdapter (base.py) + overpass/network_import/user_reports (ACTIVE), research.py (RESEARCH_REQUIRED-заглушки без сети), registry.py
  stations/           — ingest.py: source_station_records → мастер-каталог
  normalization/      — fuel.py, names.py — нормализация топлива/брендов/названий
  dedup/              — compare.py (compare_records — чистая функция), service.py (DedupService: авто-слияние/REVIEW/admin_merge/admin_split)
  fuel_status/        — наборы статусов топлива/очереди, инвариант UNKNOWN≠UNAVAILABLE
  confidence/         — aggregate.py (aggregate — чистая функция), service.py (StatusService: запись наблюдений + пересчёт + expire_stale)
  ranking/            — score.py — FuelRadar Score, 7 компонент + ETA
  alerts/             — events.py (diff_event), service.py (evaluate_rules), channels.py (in-app/Web Push/Telegram), router.py, authz.py, models.py
  reports/            — router.py (POST /reports), service.py (поверх StatusService), schemas.py
  analytics/          — service.py (summarize/deficit_statistics — читают кэш AnalyticsSnapshot), models.py, router.py
  auth/               — service.py — JWT/httpOnly-cookie, dev-вход, magic-link, Telegram
  api/                — stations.py, meta.py, personal.py (favorites/monitoring-zones/alerts — требуют профиль), admin.py, login.py, deps.py (rate_limit), cache.py, schemas.py
  worker/             — Worker/run_once, schedule_priority_job, locking.py (advisory/файловый лок); __main__.py — точка входа `python -m app.worker`
backend/cli/          — seed.py (`python -m cli.seed --region <regions.py> [--offline]`), regions.py
backend/tests/        — по одному файлу на модуль (test_<module>.py) + fixtures/ (офлайн-данные для seed), conftest.py (client/db_session — session-scope)

frontend/app/          — Next.js App Router: page.tsx (главный экран), admin/, settings/, auth/verify/, stations/
frontend/components/
  HomeScreen.tsx        — главный экран (шапка, топливо/радиус, табы Карта/Список/Избранное)
  map/                  — MapView.tsx, Legend.tsx
  station/              — StationCard/StationList/ReportForm/HistoryChart/WhyExplanation/StatusBadge
  filters/, favorites/  — FiltersPanel, FavoritesPanel/FavoriteRulesBar
  layout/               — Header, LoginPanel, NotificationsPanel, MapProviderToggle, ThemeToggle, LocaleToggle
  settings/             — SettingsScreen + Privacy/MonitoringZones/ObservationMode/NetworkPreferences/AlertRules панели
  admin/                — AdminScreen + SourcesTable/CollectionLog/Coverage/DedupQueue/UsersBlock, AdminTokenGate
  onboarding/, providers/, ui/ — OnboardingTour, AppProviders/ServiceWorkerRegister/OfflineReportsSync, EmptyState
frontend/lib/
  api.ts, adminApi.ts   — fetch-обёртки (adminApi добавляет X-Admin-Token из sessionStorage)
  types.ts, filters.ts, format.ts, fuel.ts, availability.ts, geo.ts, i18n.ts, personalization.ts, offlineReports.ts, telegram.ts
  map/                  — types.ts (MapProviderProps — единый контракт), maplibre-provider.tsx, yandex-provider.tsx, index.ts (выбор провайдера), statusColor/brandColor/markerIcon/markerData/cluster/config/osmStyle/yandexLoader
  hooks/                — useMeta, useAuth, useFilters, useStations, useStationDetail, useFavorites, useNotifications, useTheme, useI18n, useOnboarding, useMapProviderPreference, usePrivacy, useObservationMode, useNetworkPreferences, useMonitoringZones, useAlertRules, useFollowMeZone, useAdminAuth
frontend/public/       — manifest.json, icon.svg, sw.js (PWA, network-first для навигации)
deploy/Caddyfile        — прод-реверс-прокси: /api/* → api:8000, остальное → frontend:3000
desktop/                — Electron-оболочка (Windows): встроенный Next standalone + reverse-proxy /api/* (Origin переписывается), NSIS-установщик, автообновление electron-updater, Telegram-popup; сборка `make desktop-dist`, детали desktop/README.md
.claude/launch.json     — дев-превью (`npm run dev --prefix frontend`), не код приложения
```

## Ключевые файлы

- `backend/app/main.py` — все роутеры монтируются здесь; новый роутер добавлять тем же паттерном (`app.include_router(x_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])`).
- `backend/app/core/config.py` — единственное место дефолтов (TTL/интервалы/пороги/веса); не дублировать константы в других модулях.
- `backend/app/db/models.py` — владелец схемы; новые таблицы/поля — только здесь, миграции для прод-БД — `db/migrations.py` (идемпотентно).
- `backend/app/confidence/service.py` — `StatusService.record_fuel_observation`/`recompute_station_fuel`/`recompute_station_queue`/`expire_stale`; сюда встроены хуки `alerts.service.evaluate_rules` — не задваивать вызов записи статуса в других модулях.
- `backend/app/worker/__main__.py` + `backend/app/worker/service.py` — реальный воркер (`python -m app.worker`), `schedule_priority_job()` — единственная точка постановки задания сбора (используется и `POST /admin/sources/{id}/refresh`).
- `frontend/lib/map/types.ts` (`MapProviderProps`) — контракт карты; `frontend/lib/map/index.ts` — выбор MapLibre/Яндекс по `NEXT_PUBLIC_MAP_PROVIDER`/наличию ключа.
- `frontend/lib/filters.ts` (`Filters`) + `useFilters()` — единственное состояние фильтров, живёт в URL query.
- `frontend/lib/i18n.ts` — оба словаря (ru/en) обновлять вместе, ключ не может существовать в одном и отсутствовать в другом.
- `frontend/lib/adminApi.ts` — админ-токен только в `sessionStorage` (ключ `fr_admin_token`), никогда в `.env`/коде фронтенда.

## Архитектура

Поток данных: `sources/*` (SourceAdapter, только ACTIVE: osm_overpass/network_import/user_reports) → `source_station_records` → `stations/ingest.py` строит/обновляет мастер-каталог → `normalization/*` нормализует топливо/бренды → `dedup/*` сравнивает и авто-сливает/ставит в REVIEW → наблюдения (`fuel_observations`/`queue_observations`, всегда новая строка, история не перезаписывается) → `confidence/aggregate.py` взвешенно голосует (trust×свежесть×репутация×GPS) → `station_current_status` → `ranking/score.py` считает Score (7 компонент) → `api/stations.py` отдаёт наружу → `frontend` рендерит карту/список.

Сбор — только через `worker/` (P1–P4 по приоритету, интервалы/backoff из config); API никогда не дёргает источники синхронно (R83) — `POST /admin/sources/{id}/refresh` лишь создаёт `CollectionJob` через `schedule_priority_job`.

MapProvider-абстракция: `lib/map/types.ts::MapProviderProps` — единый интерфейс; `maplibre-provider.tsx` (дефолт, OSM-тайлы, без ключей) и `yandex-provider.tsx` (включается только при непустом `NEXT_PUBLIC_YANDEX_MAPS_API_KEY`) — обе реализации подставляются в `lib/map/index.ts`, вызывающий код (`MapView.tsx`) не знает, какая активна.

Auth: JWT в httpOnly-cookie (`backend/app/auth/service.py`), три способа входа — dev (без ключей), magic-link (активен только при `SMTP_URL`), Telegram (виджет, проверка подписи, активен при `TELEGRAM_BOT_TOKEN`/`NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`) — без соответствующей переменной канал явно отвечает «не настроено», не падает и не притворяется рабочим. Favorites/monitoring-zones/alerts требуют профиль (401 без cookie).

Admin: заголовок `X-Admin-Token` (`backend/app/api/deps.py::require_admin`, `secrets.compare_digest`), значение вводит человек на `/admin` и держится в `sessionStorage` (`frontend/lib/adminApi.ts`) — не переменная окружения фронтенда.

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
- `TELEGRAM_BOT_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `ADMIN_TOKEN`, `SMTP_URL` — секреты каналов/админки, пусто → канал «не настроено»
- `JWT_SECRET` (пусто → эфемерный на процесс, только dev), `COOKIE_SECURE`, `CORS_ORIGINS`, `RATE_LIMIT_PER_MINUTE` (0 — выключить), `API_CACHE_TTL_SECONDS`
- `SMTP_FROM`, `PUBLIC_APP_URL` — magic-link
- `WORKER_TICK_SECONDS`, `WORKER_BACKOFF_MAX_MINUTES` — воркер
- `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` — дублируется здесь для docker-compose, реально читается frontend из своего `.env.local`

`frontend/.env.example` (Next.js читает только отсюда, не из корня):
- `API_INTERNAL_URL` — куда `next.config.mjs` рёрайтит `/api/*`
- `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` — пусто → Яндекс-провайдер не используется, к сервису не обращается
- `NEXT_PUBLIC_MAP_PROVIDER` — явный выбор `yandex|maplibre`, переопределяет автоопределение по ключу
- `NEXT_PUBLIC_DEFAULT_MAP_LAT`, `NEXT_PUBLIC_DEFAULT_MAP_LON` — начальный вьюпорт карты
- `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — публичное имя бота для виджета входа; сам токен на фронт не попадает

## Тесты

- Backend: `backend/tests/test_<module>.py`, один файл на модуль/API-поверхность (`test_api.py`, `test_dedup.py`, `test_worker.py`, `test_alerts.py`, `test_reports.py`, `test_analytics.py`, `test_confidence.py`, `test_confidence_freshness.py`, `test_ranking.py`, `test_normalization.py`, `test_fuel_status.py`, `test_sources.py`, `test_ingest.py`, `test_seed_cli.py`, `test_migrations.py`, `test_schema.py`, `test_health.py`). Гонять один файл: `pytest tests/test_dedup.py`; по имени теста: `pytest -k merge`. 192 passed.
- Frontend: рядом с модулем как `*.test.ts(x)` (например `frontend/lib/geo.test.ts`, `frontend/components/station/ReportForm.test.tsx`). Один файл/маска: `npm test -- ReportForm`. 103 passed (29 файлов).
- E2E: `frontend/e2e/*.spec.ts` (Playwright, Chromium), общий раннер `npm run test:e2e`; моки/фикстуры — `frontend/e2e/mocks.ts` (setupBase — базовая установка: SW отключён + внешние заглушки + API-моки), ассерты консоли — `frontend/e2e/console.ts`.
- Офлайн-фикстуры для `seed`: `backend/tests/fixtures/`.

## Подводные камни

- `make dev` сам выставляет `DEBUG=true CORS_ORIGINS=http://localhost:3000` — без них при раздельном запуске (`uvicorn` напрямую) любой POST/PUT/PATCH/DELETE через прокси Next.js получает `403 Недопустимый источник запроса` (browser Origin ≠ адрес backend), а dev-вход отдельно требует `DEBUG=true` (`api/login.py`). В проде оба идут за одним Caddy — один origin, переменные не нужны. Отдельно: `Settings.model_config.env_file` (`core/config.py`) раньше был относительным (`".env"`) — pydantic-settings резолвит его от CWD процесса, а при `cd backend && uvicorn ...` CWD оказывается `backend/`, где `.env` нет, и корневой `.env` молча игнорировался целиком (не только DEBUG/CORS_ORIGINS). Исправлено на абсолютный путь до корня репозитория. Тесты при этом обязаны оставаться герметичными — `conftest.py` выставляет `FUELRADAR_NO_ENV_FILE=1`, чтобы реальный `.env` разработчика не тёк в прогон тестов.
- `setup.ps1` (корень репозитория) — разворачивает окружение на новой машине с нуля: venv, зависимости, `.env`/`frontend/.env.local` из примеров (с автосгенерированным локальным `ADMIN_TOKEN`), демо-данные офлайн, запуск обоих серверов. Идемпотентен, `git pull` внутри — годится и для обновления уже развёрнутого окружения. Двойной клик — `setup.cmd`.
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
- T05: Публичный API (`backend/app/api/` — `/api/v1`: stations/nearby/history/meta/favorites/monitoring-zones/alerts + admin с `X-Admin-Token`) и безопасность (`backend/app/auth/` — JWT в httpOnly-cookie, dev-вход, magic-link по SMTP_URL, Telegram-вход): CORS-белый список, rate limiting, Pydantic-валидация (422 на русском), кэш карты/списка (R82). `status_explanation`/`score_breakdown`/`eta` в карточке станции (R92). Frontend ходит к API через прокси Next.js (`API_INTERNAL_URL`), `Caddyfile` разводит `/api/*` → api. Тесты: 106 passed.
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
<!-- autopilot:end -->

<!-- IJFW-MEMORY-START -->
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.
<!-- IJFW-MEMORY-END -->

<!-- IJFW-AGENTS-START -->
No project agents yet. Run `ijfw team` to set them up.
<!-- IJFW-AGENTS-END -->
