# Контракты сборки (interfaces.md)

Единая точка сверки между тасками. Таск, который ломает контракт, — сломанный таск.

## Стек (фиксирован, T01)

- Backend: Python 3.12+, FastAPI, Pydantic v2, SQLAlchemy; dev-БД SQLite, prod — PostgreSQL+PostGIS (docker-compose). APScheduler (воркер). Тесты: pytest.
- Frontend: Next.js (App Router), React, TypeScript, Tailwind; карта — MapLibre GL через абстракцию `map-provider`; PWA (manifest + service worker).
- Конфигурация: `.env` (только секреты) + конфиг-файл; всё конфигурируемое — с дефолтом из спецификации.

## Модули backend (зоны владения)

| Модуль | Зона | Отвечает |
|---|---|---|
| db | `backend/app/db/` | схема, миграции, сиды словарей |
| core | `backend/app/core/` | конфиг, логирование, health |
| sources | `backend/app/sources/` | адаптеры, source_records, health источников |
| stations | `backend/app/stations/` | мастер-каталог, внешние ID |
| normalization | `backend/app/normalization/` | нормализация названий/брендов/топлива |
| dedup | `backend/app/dedup/` | слияние/разделение, dedup_decisions |
| fuel_status | `backend/app/fuel_status/` | агрегированный статус станции |
| confidence | `backend/app/confidence/` | confidence-агрегация, TTL/устаревание |
| ranking | `backend/app/ranking/` | FuelRadar Score, ETA |
| geo | `backend/app/geo/` | зоны, расстояния (haversine-dev / PostGIS-prod) |
| monitoring | `backend/app/monitoring/` | зоны пользователя, «следить вокруг меня» |
| alerts | `backend/app/alerts/` | события, правила, каналы |
| reports | `backend/app/reports/` | user_reports → наблюдения |
| analytics | `backend/app/analytics/` | покрытие, индекс, агрегаты дефицита |
| auth | `backend/app/auth/` | пользователи, JWT, админ-токен |
| api | `backend/app/api/` | роутеры /api/v1, rate limiting, кэш |
| worker | `backend/app/worker/` | планировщик P1–P4, backoff, метрики сбора |

## Инварианты (не нарушать; тесты защищают)

1. **UNKNOWN ≠ UNAVAILABLE.** Никакой код не конвертирует одно в другое (R15).
2. **Никакой вымышленный статус.** Статус — только из наблюдений; LLM/модель не решает (R42).
3. **API не вызывает внешние источники синхронно** (R83). Сбор — только воркер.
4. **Сбой источника не трогает данные** — только collection_logs/source_health (R84).
5. **История не перезаписывается** — новое наблюдение = новая строка (R17).
6. **Секреты — только .env.** Имена в `.env.example`; значения никогда в код/логи/отчёты.

## Публичный API /api/v1 (контракт — T05; дополняют T07/T08)

- `GET /stations` — фильтры: `lat, lon, radius, bbox, city, brand, fuel, status, confidence_min, queue_max`; пагинация; сортировки: `sort=distance|confidence|availability|queue|travel_time|score`.
- `GET /stations/{id}` — карточка: станция + топливо со статусами + `confidence` + `status_explanation` (источники: название, возраст) + `score_breakdown` + `eta` + `queue` (`level`, `vehicles`, `estimated_wait_minutes`).
- `GET /stations/{id}/history?fuel=AI95` — серия наблюдений (для графиков).
- `GET /stations/nearby` — точка+радиус (обёртка над /stations).
- `GET /meta` — справочники: топливо (base+commercial), сети, статусы с переводами (A02).
- `GET/POST/DELETE /favorites` (+ `{station_id}`) — только с профилем.
- `GET/POST/PUT/DELETE /monitoring-zones` — типы city|circle|polygon; только с профилем.
- `GET/POST/PUT/DELETE /alerts` — правила (fuel, distance_km, status, confidence_min, queue_max, scope: zone|favorites|network); только с профилем.
- `POST /reports` — `{station_id, fuel: {AI95: AVAILABLE|UNAVAILABLE|LOW_STOCK|UNKNOWN}, queue: NONE|LOW|MEDIUM|HIGH|VERY_HIGH, idempotency_key}` + координаты пользователя для GPS-веса (R40).
- `GET /notifications` + `POST /notifications/read` — лента + счётчик (A03).
- Admin (заголовок `X-Admin-Token`): `GET /admin/sources`, `GET /admin/sources/{id}/health`, `POST /admin/sources/{id}/refresh`, `POST /admin/stations/{id}/merge` / `/split`, `GET /admin/coverage`, `GET /admin/coverage-by-source`, `GET /admin/fuel-index`, `GET /admin/deficit-stats`, `POST /admin/users/{id}/block`, `GET/POST /admin/dedup-queue` (подтверждения слияний), `POST /admin/trust-weights`.

Статусы: топливо `AVAILABLE|LIKELY_AVAILABLE|LOW_STOCK|UNCERTAIN|UNAVAILABLE|UNKNOWN`; очередь `NONE|LOW|MEDIUM|HIGH|VERY_HIGH|UNKNOWN`. Переводы — только в `/meta` (R98i).

## Конфигурация (дефолты из спецификации)

`DEFAULT_REGION` (Краснодар — данные, не код), TTL (топливо 2 ч, очередь 30 мин, адрес 30 дней, режим работы 7 дней, raw 7–30 дней), интервалы сбора (60/30/15–30/120 мин), пороги дедупа (auto_merge/needs_review), веса confidence и score, окно дедупликации уведомлений 5 мин, GPS-порог 300 м, лимит правил на пользователя.

## Швы для тестов (единственные точки)

1. Публичный API через TestClient — контракты, права, E2E §126–128.
2. Чистые функции: `confidence.aggregate`, `normalization.normalize_fuel`, `dedup.compare`, `ranking.score`.
3. Интерфейс `SourceAdapter` (фикстуры, без сети).
4. `worker.schedule_priority_job` — приоритеты, backoff, рестарт.

## Что уже построено

### Из таска 01 — каркас (коммиты ede643d, 54e63b9)

- `backend/app/main.py` — FastAPI: `/health`, `/ready`, `/metrics`; lifespan вызывает `init_db()`.
- `backend/app/db/` — `Base` (DeclarativeBase), все таблицы §83 в `models.py`, `init_db()` (создание + сиды словарей), `SessionLocal`, `get_db()` (FastAPI-зависимость). Владелец схемы — таск 01: новые миграции не создавать, таблицы менять через модели.
- `backend/app/core/config.py` — `settings` (pydantic-settings из .env): регион, TTL, интервалы, пороги/веса, имена секретов. Не дублировать дефолты в других модулях.
- `backend/app/core/metrics.py` — in-memory счётчики (`inc`, `set_gauge`, `snapshot`); воркер (T06) пишет сюда метрики сбора.
- Сиды: `fuel_types` (AI_92…CNG, UNKNOWN, OTHER), `fuel_brands` (ЭКТО, G-Drive, Pulsar), `source_providers` (ACTIVE: osm_overpass/network_import/user_reports; прочие RESEARCH_REQUIRED).
- Стек/команды: `make dev|test|lint|compose-up|compose-prod`; pytest из `backend/` (`python -m pytest`), ruff; фронт — Next.js 15 + TS + Tailwind v4, `npm run typecheck|build`.
- Ограничения: секреты только в .env; регион — данные из .env (`DEFAULT_REGION_CITY`), в коде «Краснодара» нет.

### Таск 08 — аналитика дефицита и покрытие

- **Что заработало:** Coverage по региону (обнаружено/с данными о топливе/частичные/нет данных, Coverage % — R51) и по bbox/городу — `summarize()`; покрытие по источникам до/после дедупликации, число уникальных станций не раздувается повторным сбором (R52); Fuel Availability Index 0–100 по видам топлива, станции с UNKNOWN/неоднозначным статусом исключены из знаменателя явно (`excluded_unknown`/`excluded_ambiguous`), а не тихо занулены — R48; агрегаты дефицита по истории (`deficit_statistics`) — частота переходов в UNAVAILABLE, средняя длительность отсутствия и восстановления по сети, окна без данных (TTL-разрыв) не выдумывают длительность и не тянут её ни в отсутствие, ни в «восстановление» — R47. Пересчёт фоновый по расписанию, `/admin/coverage|/coverage-by-source|/fuel-index|/deficit-stats` читают только кэш (`AnalyticsSnapshot`) — если пересчёта ещё не было, отвечают 503, а не считают на лету по истории; admin-роуты защищены `X-Admin-Token` (T05).
- **Модули:** `backend/app/analytics/` (`models.AnalyticsSnapshot`, `service.summarize`/`deficit_statistics`, `router` — смонтирован в `main.py` в рамках коммита T05 из-за смежного диапазона правок), `backend/tests/test_analytics.py`.
- **Тесты:** 9 новых — индекс/покрытие честны на границах (пустой город, bbox), источники не задваиваются, дефицит считает переходы (не сырые отчёты), UNKNOWN/неоднозначность цензурируют, а не чинят отсутствие, admin-роуты требуют токен и отвечают 503 без прогретого кэша. Полный прогон backend: 106 passed / 0 failed.
- **Отклонения:** нет.

### Таск 05 — публичный API и безопасность

- **Что заработало:** `/api/v1` смонтирован в `main.py` (`api_router` из `backend/app/api/`): `GET /stations` (фильтры lat/lon/radius, bbox, city, brand, fuel, status, confidence_min, queue_max; пагинация; сортировки distance/confidence/availability/queue/travel_time/score — R32), `GET /stations/{id}` (карточка + `status_explanation` с источниками и возрастом — R92 + `score_breakdown` + `eta`/`queue`), `GET /stations/{id}/history|/fuel|/queue-history`, `GET /stations/nearby`, `GET /meta` (справочники+переводы, A02); избранное и monitoring-zones и alerts CRUD в `api/personal.py` — все три требуют профиль, иначе 401 (R65); admin (`X-Admin-Token`, `require_admin` — сравнение `secrets.compare_digest`, R95i): `/admin/sources`, `/admin/sources/{id}/health`, `POST /admin/sources/{id}/refresh` (создаёт `CollectionJob` через `schedule_priority_job` из T06 — не собирает синхронно, R83), `/admin/stations/{id}/merge|split` (T03), `/admin/dedup-queue` (+ новый `DedupService.admin_assign_new_station` — отклонение слияния оставляет запись собственной станцией). Аутентификация (`backend/app/auth/`): JWT в httpOnly-cookie (`create_access_token`/`decode_access_token`, секрет из `JWT_SECRET` или эфемерный на процесс в dev), dev-вход без ключей, magic-link по email (активируется `SMTP_URL`, иначе явный ответ «не настроено»), Telegram-вход (`verify_telegram_login`, проверка подписи — секрет не логируется). Безопасность: CORS — белый список `CORS_ORIGINS` (пусто → без CORS-заголовков, same-origin), rate limiting per-IP (`rate_limit`, `RATE_LIMIT_PER_MINUTE`, 0 — выключить), Pydantic-валидация с ответом 422 на русском (R67), кэш `/stations`+`/stations/nearby` (`api/cache.py`, `API_CACHE_TTL_SECONDS`, R82). Frontend получает доступ к API через прокси Next.js (`rewrites()` → `API_INTERNAL_URL`) — избегает CORS/cookie-проблем в проде; `deploy/Caddyfile` разводит `/api/*` → `api`, остальное → `frontend`.
- **Модули:** `backend/app/api/` (`stations`, `meta`, `personal`, `admin`, `login`, `deps`, `cache`, `schemas`), `backend/app/auth/service.py`, `backend/app/main.py` (CORS, обработчик валидации, монтирование роутеров — включая `analytics_router` из T08, так как правки в одном файле неразделимы), `backend/app/dedup/service.py` (`admin_assign_new_station`), `backend/app/core/config.py` (jwt_secret/cookie_secure/cors_origins/rate_limit_per_minute/api_cache_ttl_seconds/smtp_from/public_app_url — commit T06 из-за смежного диапазона правок), `.env.example`/`docker-compose*.yml`/`Caddyfile`/`frontend/Dockerfile`+`next.config.mjs` (тоже часть смежного диапазона — задокументированы в T06).
- **Тесты:** `test_api.py` (новые: контракты /stations и фильтры, 401/403 на профиль и admin, /admin/sources/refresh создаёт job, merge/split/dedup-queue, /meta). Полный прогон backend: 106 passed / 0 failed.
- **Отклонения:** нет от спецификации ticket'а. При интеграции обнаружено и исправлено: `test_admin_refresh_creates_job` создавал PENDING-задание на общем провайдере `osm_overpass` и не закрывал его — на общей тестовой БД (`db_session`, session-scope) это блокировало реальный сбор в `test_ingest.py` через партиционный `uq_collection_active` (T06); тест доведён до `DONE` после проверки.

### Таск 06 — планировщик и воркер сбора

- **Что заработало:** отдельный процесс `python -m app.worker` (APScheduler, compose-сервис `worker`) — регулярный сбор каталога/наблюдений по приоритетам P1–P4 (активное правило пользователя → избранная АЗС → зона пользователя → остальной каталог, R55) через `Worker.run_once()`; интервалы по конфигу (обычный 60, избранное 30, дефицит 15–30, стабильное 120 мин), приоритет не опрашивается чаще `min_interval_minutes` источника (R54); сбой источника — backoff по приоритету + запись в collection_logs/source_health, данные не удаляются (R56/R84); `schedule_priority_job(session, provider_id, priority=, job_type=, trigger=, now=)` — публичная точка постановки задания, объединяет дубли (coalesce), валидирует priority∈{P1..P4} и job_type; `POST /admin/sources/{id}/refresh` (T05) зовёт её напрямую — сбор никогда не идёт синхронно из API (R83); рестарт безопасен — `worker_lock(engine)` (advisory-лок Postgres / файловый лок SQLite) не даёт двум процессам работать параллельно, пропущенный цикл догоняется одним проходом без дублей; метрики (`source.<code>.requests/errors/duration_ms`) — R70. Инвариант **один активный job на (провайдер, job_type, station)** — партиционный уникальный индекс `uq_collection_active` (миграция `db/migrations.py::upgrade_worker_jobs`, идемпотентна, старые дубли переводятся в FAILED, не удаляются); `upgrade_spatial_index` — geography-колонка + GIST-индекс для prod PostGIS (no-op на SQLite).
- **Модули:** `backend/app/worker/` (`Worker`, `schedule_priority_job`, `locking.worker_lock`), `backend/app/db/migrations.py`, `backend/app/db/models.py` (CollectionJob: `station_id`, `next_run_at`, `locked_until`, `lock_token`, `uq_collection_active`), `backend/app/db/session.py` (вызывает миграции в `init_db()`), `backend/app/confidence/aggregate.py` + `confidence/service.py` (регрессии, найденные при интеграции планировщика — см. `test_confidence_freshness.py`), `backend/app/core/config.py` (`worker_tick_seconds`, `worker_backoff_max_minutes`), `backend/requirements.txt` (APScheduler, psycopg[binary] — prod Postgres), `docker-compose.yml`/`docker-compose.prod.yml`/`backend/Dockerfile` (сервис `worker`, `COPY cli`), `.env.example`.
- **Тесты:** `test_worker.py` (13 новых, изолированная SQLite на тест — приоритеты/backoff/рестарт-без-дублей/лок), `test_confidence_freshness.py` (2 регрессионных — TTL не продлевается повторной агрегацией, второй голос источника не задваивается), `test_migrations.py`. Полный прогон backend: 106 passed / 0 failed.
- **Отклонения:** нет от спецификации ticket'а. При интеграции обнаружено и исправлено: партиционный индекс `uq_collection_active` конфликтовал с тестовым job'ом из T05 (`test_admin_refresh_creates_job`), оставленным в PENDING на общей тестовой БД — тест доведён до DONE после проверки (не код воркера); две ACTIVE-провайдер-фикстуры в `test_confidence_freshness.py` переведены в статус TEST, чтобы не подмешиваться в реальный список активных источников CLI seed (см. `test_ingest.py::_add_provider`, тот же паттерн).

## Возврат таска (contract block)

По завершении каждого таска возвращать: что заработало (1 строка), затронутые модули, число тестов (passed/failed), отклонения от этого файла (если есть — с причиной).

### Таск 04 — статусы, Confidence Engine, Score, устаревание

- **Что заработало:** агрегация наблюдений (station, fuel) → статус из набора AVAILABLE…UNKNOWN + confidence 0–100 + разбор вкладов (R14/R16/R18): взвешенное голосование (trust × свежесть × репутация × GPS), не «последнее сообщение» (R19); конфликт 2:1 → LIKELY_AVAILABLE 67% (пример брифа §23), единогласие свежих → ~94–97% (§22); инвариант UNKNOWN ≠ UNAVAILABLE — валидатор переходов + тесты (R15); TTL (топливо 120 мин, очередь 30 мин) — наблюдения старше TTL не голосуют, expire_stale() переводит статусы в UNKNOWN с confidence 0 (R56); очередь: уровень + оригинальное число машин + estimated_wait (~80 с/машина, без данных null, R20/R45); FuelRadar Score с разбором по 7 компонентам (fuel_available/confidence/freshness/distance/travel_time/queue/user_preferences — R43), приоритет сети R77 — только компонент сортировки; ETA = travel + ожидание (R45); запись наблюдения — всегда новая строка истории (R17) + пересчёт station_current_status (R16); reliability_score — базовый счёт из GPS-подтверждённых отчётов (R41).
- **Модули:** `backend/app/fuel_status/` (statuses), `backend/app/confidence/` (aggregate, service), `backend/app/ranking/` (score), `backend/app/core/config.py` (пороги confidence, GPS-множители, очередь/ETA), `backend/tests/` (test_fuel_status, test_confidence, test_ranking), `.env.example` (CONFIDENCE_*/GPS_*/QUEUE_*/AVG_SPEED/SCORE_WEIGHTS).
- **Тесты:** 21 новый (итого 63 passed / 0 failed); ruff чисто. Live-прогон на dev-БД: сеть + 2 пользователя с места → AVAILABLE 97%, score 80.2, очередь 3 машины → 4 мин, 3 строки истории.
- **Отклонения:** нет. Замечания: expire_stale() пока вызывается вручную — в расписание воркера ставится в T06; ETA с дистанцией пользователя считается в API (T05) — в БД score нейтрален по дистанции; связка вкладов с названиями источников — T07.

### Таск 03 — нормализация и дедупликация мастер-каталога

- **Что заработало:** из source_station_records строится мастер-каталог `stations` с ID `fr_station_*` (R07): нормализация топлива (`95 Экто` → AI_95 + ЭКТО, неизвестное → UNKNOWN — не ошибка; R13) и брендов/названий (`Лукойл`/`ЛУКОЙЛ`/`АЗС Лукойл №47`/`Lukoil` → один канон; R10); взвешенное сравнение по §11 (координаты 50/бренд 20/адрес 15/название 10/телефон 5) с разбором по весам в `dedup_decisions`; автослияние ≥ auto_merge, очередь админу ≥ needs_review (пороги — конфигурация §18), иначе новая станция (R02 — одного источника достаточно); идемпотентность: повторный проход обрабатывает только PENDING (R09); админ-действия `admin_merge`/`admin_split` (split восстанавливает обе станции с прежними внешними ID); CLI `seed` по умолчанию запускает дедупликацию и печатает сводку (`--no-dedup` — отключить).
- **Модули:** `backend/app/normalization/` (fuel, names), `backend/app/dedup/` (compare, service), `backend/cli/seed.py` (флаг `--no-dedup` + сводка), `backend/tests/` (test_normalization, test_dedup), `.env.example` (DEDUP_*).
- **Тесты:** 15 новых (итого 42 passed / 0 failed); ruff чисто. Live-прогон: дубль «ЛУКОЙЛ» из CSV слился со станцией OSM (score 1.0, AUTO_MERGE, оба внешних ID на одной станции); повторный прогон — 0/0/0.
- **Отклонения:** нет. Замечания: связка координат `fr_station_*` — последовательный счётчик (однопроцессно); кандидаты REVIEW видны через `DedupService.review_candidates()` — API-обёртка в таске 05; `station_brands` пополняется каноническими именами при первом использовании (сид не нужен).

### Таск 02 — адаптеры источников и сбор каталога (см. git log fpetrol)

- **Что заработало:** конвейер «источник → source_station_records» через интерфейс `SourceAdapter`; OSM/Overpass (discovery-only, атрибуция «© OpenStreetMap contributors»), импорт CSV/JSON списков сетей, `user_reports` (структура); RESEARCH_REQUIRED-заглушки (Яндекс/2ГИС/сети/Т-Банк/Telegram) без единого сетевого вызова; CLI `seed --region … [--offline]` (A01) со счётчиками и офлайн-фикстурами; изоляция сбоев R84 (job FAILED + collection_logs + source_health, старые данные не тронуты).
- **Модули:** `backend/app/sources/` (base, overpass, network_import, user_reports, research, registry), `backend/app/stations/ingest.py`, `backend/cli/` (seed, regions), `backend/tests/` (fixtures/, test_sources, test_ingest, test_seed_cli), `backend/app/core/config.py` (overpass_endpoint, network_import_path), `.env.example`, Makefile (`make seed`).
- **Тесты:** 21 новых (итого 27 passed / 0 failed); ruff чисто.
- **Отклонения:** нет. Замечания: DEGRADED пока только от health_check импорта (нет файла); приоритетный планировщик P1–P4 и расписание — таск 06; привязка записей к stations и дедупликация — таск 03.