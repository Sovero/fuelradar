"""Точка входа встроенного backend десктоп-сборки (frozen через PyInstaller).

Зачем: на машине пилота может не быть ни Python, ни venv, поэтому backend едет
внутри установщика замороженным бинарником (собирается
`desktop/scripts/prepare-backend.mjs`, в пакете лежит в `resources/backend`).
Этот модуль — его `main`: он поднимает ровно то же приложение
(`app.main:app`), но умеет то, чего требует десктоп:

    --data-dir <путь>          каталог данных приложения: SQLite-база и загрузки
                               CSV из админки. База создаётся здесь, а не в
                               Program Files: туда пользователю писать нельзя.
    --seed-offline [--region]  наполнить пустой каталог демо-данными из офлайн-
                               фикстур (без сети) и выйти (`cli.seed --offline`).
    --check-database-url URL  проверить, что драйвер БД есть в сборке
                               (диалект SQLAlchemy без подключения) и выйти —
                               самопроверка бандла, а не рабочая команда.
    --backup-db [PATH]         снять консистентную копию локальной базы и выйти
                               (без PATH — в <данные>/backups/fuelradar-<штамп>.db).
    --migrate-db               перенести данные локальной базы во внешнюю
                               (Postgres) и выйти; адрес — --to-database-url
                               или DATABASE_URL окружения.

Служебные команды (--backup-db/--migrate-db) печатают одну строку JSON с
ASCII-экранированием: её разбирает оболочка (`desktop/main.cjs`), а консольная
кодировка Windows у машины пилота своя. Пароль внешней базы наружу не попадает
(R68).

Сбор по расписанию этот процесс выполняет сам (фоновый тикер, настройка
COLLECT_IN_PROCESS): в установленном приложении отдельного воркера нет. Регион
сбора — тот же `--region` (оболочка даёт ключ газетира из backend.seedRegion).

Адрес прослушивания берётся аргументы → переменные окружения → дефолт;
оболочка выставляет переменные из своего `config.json`. `.env` рядом с
бинарником намеренно не читается: в собранном приложении единственный источник
правды — config.json оболочки (R97i, «не изображать работу»).

Разбор аргументов и окружения вынесен в чистые функции (`resolve_runtime`,
`frozen_support_env`) — их проверяют юнит-тесты без запуска сервера
(backend/tests/test_desktop_server.py).
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DB_FILENAME = "fuelradar.db"
IMPORT_DIRNAME = "import"
FIXTURES_RELATIVE = ("tests", "fixtures")


def is_frozen() -> bool:
    """Собран ли этот процесс PyInstaller'ом (а не запущен из репозитория)."""
    return bool(getattr(sys, "frozen", False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fuelradar-backend",
        description="Встроенный backend FuelRadar (frozen-сборка десктоп-приложения)",
    )
    parser.add_argument("--host", default=None, help=f"адрес прослушивания (по умолчанию {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=None, help=f"порт (по умолчанию {DEFAULT_PORT})")
    parser.add_argument(
        "--data-dir",
        default=None,
        help="каталог данных приложения: SQLite-база и загрузки CSV (по умолчанию — рабочий каталог)",
    )
    parser.add_argument("--seed-offline",
        action="store_true",
        help="наполнить каталог демо-данными из офлайн-фикстур (без сети) и выйти",
    )
    parser.add_argument("--region", default=None, help="регион для --seed-offline (ключ из cli/regions.py)")
    parser.add_argument(
        "--check-database-url",
        default=None,
        metavar="URL",
        help="проверить, что драйвер БД есть в этой сборке (диалект SQLAlchemy по адресу, без подключения) и выйти",
    )
    parser.add_argument(
        "--backup-db",
        nargs="?",
        const="",
        default=None,
        metavar="PATH",
        help="снять консистентную копию локальной базы и выйти (без PATH — в каталог данных, подкаталог backups)",
    )
    parser.add_argument(
        "--migrate-db",
        action="store_true",
        help="перенести данные локальной базы во внешнюю базу (Postgres/PostGIS) и выйти",
    )
    parser.add_argument(
        "--to-database-url",
        default=None,
        metavar="URL",
        help="адрес внешней базы для --migrate-db (по умолчанию — FUELRADAR_TARGET_DATABASE_URL или DATABASE_URL)",
    )
    return parser


def resolve_runtime(args: argparse.Namespace, environ: dict[str, str]) -> dict:
    """Что нужно знать до импорта приложения: адрес, каталог данных, переменные.

    Чистая функция (окружение не меняет): аргументы командной строки важнее
    переменных окружения, переменные — важнее дефолтов. Уже заданный
    `DATABASE_URL` не перезаписывается — сторонний (например, Postgres) режим
    уважается, а не молча подменяется локальной SQLite.
    """
    host = args.host or environ.get("FUELRADAR_HOST") or DEFAULT_HOST
    raw_port = args.port if args.port is not None else environ.get("FUELRADAR_PORT")
    try:
        port = int(raw_port) if raw_port not in (None, "") else DEFAULT_PORT
    except (TypeError, ValueError):
        port = DEFAULT_PORT

    raw_dir = (args.data_dir or environ.get("FUELRADAR_DATA_DIR") or "").strip()
    data_dir = Path(raw_dir).expanduser() if raw_dir else None

    updates: dict[str, str] = {}

    # Регион пилота: оболочка задаёт его ключом газетира (`--region` /
    # backend.seedRegion). У приложения ОДИН регион, и он же — регион сбора
    # по расписанию: без него встроенный backend честно отвечает, что сбор
    # не запущен (DEFAULT_REGION_CITY). Явное значение из окружения важнее.
    region = (args.region or environ.get("FUELRADAR_SEED_REGION") or "").strip()
    if region and not environ.get("DEFAULT_REGION_CITY"):
        updates["DEFAULT_REGION_CITY"] = region

    if data_dir is not None:
        updates["FUELRADAR_DATA_DIR"] = str(data_dir)
        # Импорт CSV из админки: дефолт — backend/data/import относительно CWD
        # процесса, а у установленного приложения CWD произвольный.
        updates["FUELRADAR_CSV_UPLOAD_DIR"] = str(data_dir / IMPORT_DIRNAME)
        if not environ.get("DATABASE_URL"):
            # sqlite:/// + POSIX-путь: SQLAlchemy понимает и «C:/…» (Windows), и
            # абсолютный путь на остальных платформах.
            updates["DATABASE_URL"] = f"sqlite:///{(data_dir / DB_FILENAME).as_posix()}"

    # Сбор по расписанию: у установленного приложения нет отдельного процесса
    # воркера, поэтому расписание ведёт фоновый тикер самого backend (под общим
    # worker_lock — рядом работающий воркер дублей не создаст). Явное значение
    # из окружения уважается: COLLECT_IN_PROCESS=0 выключает сбор (например,
    # на машине заведомо без сети).
    if not environ.get("COLLECT_IN_PROCESS"):
        updates["COLLECT_IN_PROCESS"] = "1"

    return {"host": host, "port": port, "data_dir": str(data_dir) if data_dir else None, "env": updates}


def frozen_support_env(bundle: str | None = None) -> dict[str, str]:
    """Переменные, которые нужны только замороженному бинарнику.

    `bundle` — `sys._MEIPASS` (у PyInstaller он есть только в собранном
    приложении); None/пусто — обычный запуск из репозитория, ничего не меняем.

    - `FUELRADAR_NO_ENV_FILE`: `.env` рядом с бинарником не читается — в собранном
      приложении настройки приходят из config.json оболочки (R97i);
    - `FUELRADAR_FIXTURES_DIR`: офлайн-фикстуры упакованы внутрь бандла
      (`--add-data` в prepare-backend.mjs), а `cli/seed.py` ищет их относительно
      своего файла, поэтому путь задаём явно.
    """
    if not bundle:
        return {}
    env = {"FUELRADAR_NO_ENV_FILE": "1"}
    fixtures = Path(bundle).joinpath(*FIXTURES_RELATIVE)
    if fixtures.is_dir():
        env["FUELRADAR_FIXTURES_DIR"] = str(fixtures)
    return env


def apply_env(updates: dict[str, str]) -> None:
    """Записать переменные в окружение процесса (до импорта `app.core.config`)."""
    for key, value in updates.items():
        os.environ[key] = value


def ensure_data_dir(runtime: dict) -> Path | None:
    """Создать каталог данных: SQLAlchemy создаёт файл базы, но не родительские каталоги."""
    if not runtime["data_dir"]:
        return None
    path = Path(runtime["data_dir"])
    path.mkdir(parents=True, exist_ok=True)
    return path


def check_database_url(url: str) -> int:
    """Загрузить диалект SQLAlchemy по адресу БД — без подключения к ней.

    Наличие драйвера (например, psycopg для Postgres) — свойство СБОРКИ, а не
    машины пилота, и проверять его попыткой соединения нельзя: недоступный адрес
    ведёт себя по-разному (отказ, таймаут, отсутствие DNS) и способен зависнуть.
    Создание диалекта импортирует модуль драйвера сразу — это и есть проверка.
    Код 0 — драйвер на месте, 3 — диалект/driver не загрузились.
    """
    from sqlalchemy import create_engine

    try:
        dialect = create_engine(url).dialect
    except Exception as exc:  # noqa: BLE001 — сборке нужен честный ответ, а не стектрейс
        print(f"диалект не загрузился: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3
    # Строка успеха — ASCII: этот же вывод читает сборочный скрипт
    # (desktop/scripts/prepare-backend.mjs), а консольная кодировка Windows
    # зависит от машины сборщика.
    print(f"[check] dialect {dialect.name}+{dialect.driver}", flush=True)
    return 0


def resolve_backup_destination(runtime: dict, destination: str | None) -> str | None:
    """Куда класть копию: явный путь оператора важнее каталога по умолчанию.

    `--backup-db` без значения означает «в каталог данных, подкаталог backups»:
    там копия лежит рядом с базой и её не найдёт только тот, кому не нужно.
    """
    explicit = (destination or "").strip()
    if explicit:
        return explicit
    if not runtime.get("data_dir"):
        return None
    from app.db.transfer import default_backup_path

    return str(default_backup_path(runtime["data_dir"]))


def run_db_backup(runtime: dict, destination: str | None) -> int:
    """Служебная команда: консистентный снимок локальной SQLite (JSON в stdout)."""
    from app.db.transfer import backup_sqlite, json_line, local_sqlite_path

    target = resolve_backup_destination(runtime, destination)
    source = local_sqlite_path(runtime.get("data_dir"))
    if target is None or source is None:
        print(json_line({"kind": "backup", "ok": False, "error": "не задан каталог данных (--data-dir)"}), flush=True)
        return 4
    summary = backup_sqlite(source, target)
    print(json_line({"kind": "backup", **summary}), flush=True)
    return 0 if summary.get("ok") else 4


def resolve_migration_target(args: argparse.Namespace, environ: dict[str, str]) -> str | None:
    """Адрес внешней базы для переноса: аргумент → явная переменная → DATABASE_URL.

    Чистая функция: приоритет виден и проверяется тестом. `DATABASE_URL` берём
    только когда он не sqlite — иначе «перенос в Postgres» тихо сделал бы копию
    локальной базы.
    """
    explicit = (args.to_database_url or "").strip()
    if explicit:
        return explicit
    named = (environ.get("FUELRADAR_TARGET_DATABASE_URL") or "").strip()
    if named:
        return named
    ambient = (environ.get("DATABASE_URL") or "").strip()
    if ambient and not ambient.startswith("sqlite"):
        return ambient
    return None


def run_db_migration(runtime: dict, target_url: str | None) -> int:
    """Служебная команда: перенос локальной SQLite во внешний Postgres (JSON в stdout).

    Работаем со снимком локальной базы (согласованный момент времени), схему
    цели создаём из тех же моделей, строки вставляем с пропуском конфликтов
    (повторный перенос безопасен), а после — накатываем идемпотентные миграции
    и сиды словарей штатным `init_db()`. Приложение при этом продолжает работать
    на своей локальной базе: перенос ничего не удаляет и не переключает.
    """
    from app.db.transfer import (
        copy_database,
        discard_snapshot,
        json_line,
        local_sqlite_path,
        mask_database_url,
        mask_secrets,
        preflight_migration,
        reset_postgres_sequences,
        snapshot_for_migration,
        sqlite_engine,
        table_rows,
    )

    source = local_sqlite_path(runtime.get("data_dir"))
    if source is None:
        print(json_line({"kind": "migrate", "ok": False, "error": "не задан каталог данных (--data-dir)"}), flush=True)
        return 4
    source_url = f"sqlite:///{source.as_posix()}"
    if not source.is_file():
        check = {"ok": False, "error": f"локальная база не найдена: {source}"}
    else:
        check = preflight_migration(source_url, target_url)
    if not check.get("ok"):
        print(json_line({"kind": "migrate", **check}), flush=True)
        return 4

    snapshot, snapshot_summary = snapshot_for_migration(source)
    if not snapshot_summary.get("ok"):
        print(json_line({"kind": "migrate", **snapshot_summary}), flush=True)
        return 5

    report: dict = {"kind": "migrate", "ok": False}
    try:
        # Внешняя база — единственная точка подключения приложения: адрес задаём
        # до импорта app.core.config, иначе он прочитает локальную SQLite.
        os.environ["DATABASE_URL"] = str(target_url).strip()
        import app.db.models  # noqa: F401 — регистрация в metadata
        from app.alerts.models import AlertStateSnapshot  # noqa: F401 — регистрация в metadata
        from app.analytics.models import AnalyticsSnapshot  # noqa: F401 — регистрация в metadata
        from app.db import session as app_session
        from app.db.base import Base

        target_engine = app_session.engine()
        Base.metadata.create_all(target_engine)
        source_engine = sqlite_engine(snapshot)
        copy_report = copy_database(source_engine, target_engine, Base.metadata)
        source_engine.dispose()
        sequences = reset_postgres_sequences(target_engine, Base.metadata)
        # Миграции и словари — после данных: сиды добавляют только недостающее и
        # не плодят дубликаты там, где строки уже привезены из локальной базы.
        app_session.init_db()
        report = {
            "ok": True,
            "source": str(source),
            "target": mask_database_url(target_url),
            "snapshot": {
                "bytes": snapshot_summary.get("bytes"),
                "created_at": snapshot_summary.get("created_at"),
                "rows": snapshot_summary.get("rows"),
            },
            "tables": copy_report["tables"],
            "inserted": copy_report["inserted"],
            "skipped": copy_report["skipped"],
            "sequences_reset": sequences,
            "target_rows": table_rows(target_engine, Base.metadata),
            "finished_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
    except Exception as exc:  # noqa: BLE001 — оператору нужна причина, а не стектрейс
        # `kind` не теряем: оболочка различает отчёты копии и переноса не только
        # по коду выхода, а обновляем словарь — сохранение порядка ключей в JSON.
        report.update(
            {
                "ok": False,
                "source": str(source),
                "target": mask_database_url(target_url),
                "error": f"{type(exc).__name__}: {mask_secrets(exc)}",
            }
        )
    finally:
        discard_snapshot(snapshot)
    print(json_line(report), flush=True)
    return 0 if report.get("ok") else 5


def run_offline_seed(region: str | None) -> int:
    """Наполнить каталог офлайн-фикстурами; код выхода `cli.seed` (2 — не задан регион)."""
    from cli.seed import main as seed_main

    argv = ["--offline"]
    if region:
        argv += ["--region", region]
    label = region or "регион по умолчанию (DEFAULT_REGION_CITY)"
    print(f"[seed] офлайн-наполнение демо-каталога: {label}", flush=True)
    return int(seed_main(argv) or 0)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    runtime = resolve_runtime(args, dict(os.environ))
    apply_env(runtime["env"])
    apply_env(frozen_support_env(getattr(sys, "_MEIPASS", None)))
    ensure_data_dir(runtime)

    if args.check_database_url:
        return check_database_url(args.check_database_url)

    if args.backup_db is not None:
        return run_db_backup(runtime, args.backup_db)

    if args.migrate_db:
        return run_db_migration(runtime, resolve_migration_target(args, dict(os.environ)))

    if args.seed_offline:
        return run_offline_seed(args.region)

    import uvicorn

    from app.main import app

    # Журнал доступа выключен: окно ходит только к своему прокси, а в статус-экране
    # оболочки (хвост вывода процесса) важнее строка о причине падения, чем поток
    # строк «GET /api/v1/stations 200».
    uvicorn.run(app, host=runtime["host"], port=runtime["port"], log_level="info", access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
