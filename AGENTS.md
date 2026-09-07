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

Собственный git-репозиторий проекта — в этой папке (`fpetrol/`), remote
`origin` = https://github.com/Sovero/fuelradar.git (ветка `main`). Коммиты и
push — только здесь; родительский репозиторий `C:\Projects\Python` FuelRadar
больше не трогает.

## Что открыто в сборке (build log)

- T01: каркас FastAPI + схемы §83, сиды словарей, PWA-каркас. Команды: `make dev|test|lint|compose-up`.
- T02: источники через `SourceAdapter` (интерфейс в `backend/app/sources/base.py`); активны только osm_overpass/network_import/user_reports, остальные RESEARCH_REQUIRED и не выполняют сети. Наполнение каталога — `make seed ARGS="--region krasnodar [--offline]"` (offline — фикстуры `backend/tests/fixtures/`). Ошибки источника изолированы (collection_jobs/logs + source_health), данные не удаляются. Тесты: 27 passed.
- T03: из `source_station_records` строится мастер-каталог `stations` (`fr_station_*`): нормализация топлива/брендов (`backend/app/normalization/`), взвешенная дедупликация по §11 (`backend/app/dedup/` — `compare_records`, `DedupService`; автослияние/REVIEW-очередь, админ `admin_merge`/`admin_split` с журналом `dedup_decisions`). `seed` запускает дедупликацию и печатает сводку (`--no-dedup` — отключить). Пороги/веса — конфигурация (DEDUP_*). Тесты: 42 passed.
<!-- autopilot:end -->
