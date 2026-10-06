"""Тесты точки входа встроенного backend (desktop_server.py, десктоп-сборка).

Проверяются чистые функции: разбор аргументов и окружения (что попадёт в
переменные до импорта приложения) и переменные замороженного бандла. Сам сервер
здесь не поднимается — это делают smoke-прогоны оболочки.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from desktop_server import (
    DB_FILENAME,
    DEFAULT_HOST,
    DEFAULT_PORT,
    IMPORT_DIRNAME,
    apply_env,
    build_parser,
    check_database_url,
    ensure_data_dir,
    frozen_support_env,
    resolve_backup_destination,
    resolve_migration_target,
    resolve_runtime,
    run_db_backup,
    run_db_migration,
)


def runtime(argv: list[str], environ: dict[str, str] | None = None) -> dict:
    return resolve_runtime(build_parser().parse_args(argv), environ if environ is not None else {})


def test_defaults_when_nothing_is_set() -> None:
    result = runtime([])
    assert result["host"] == DEFAULT_HOST
    assert result["port"] == DEFAULT_PORT
    assert result["data_dir"] is None
    # Без каталога данных база остаётся там, где её ищет конфигурация приложения
    # (запуск из репозитория) — DATABASE_URL не подменяем.
    assert "DATABASE_URL" not in result["env"]
    # Сбор по расписанию встроенный backend ведёт сам: отдельного воркера в
    # установленном приложении нет.
    assert result["env"]["COLLECT_IN_PROCESS"] == "1"


def test_collect_in_process_can_be_disabled_from_environment() -> None:
    # Явное значение из окружения не перетирается: COLLECT_IN_PROCESS=0 выключает
    # сбор (машина заведомо без сети), и процесс уже видит эту переменную —
    # дописывать её в окружение не нужно.
    assert "COLLECT_IN_PROCESS" not in runtime([], {"COLLECT_IN_PROCESS": "0"})["env"]
    assert "COLLECT_IN_PROCESS" not in runtime([], {"COLLECT_IN_PROCESS": "1"})["env"]


def test_arguments_win_over_environment() -> None:
    result = runtime(
        ["--host", "0.0.0.0", "--port", "8123"],
        {"FUELRADAR_HOST": "10.0.0.1", "FUELRADAR_PORT": "9999"},
    )
    assert result["host"] == "0.0.0.0"
    assert result["port"] == 8123


def test_environment_used_when_arguments_are_absent() -> None:
    result = runtime([], {"FUELRADAR_HOST": "127.0.0.2", "FUELRADAR_PORT": "9001"})
    assert result["host"] == "127.0.0.2"
    assert result["port"] == 9001


def test_broken_port_falls_back_to_default_instead_of_crashing() -> None:
    assert runtime([], {"FUELRADAR_PORT": "не число"})["port"] == DEFAULT_PORT
    assert runtime([], {"FUELRADAR_PORT": ""})["port"] == DEFAULT_PORT


def test_data_dir_sets_sqlite_url_and_csv_import_dir(tmp_path: Path) -> None:
    data_dir = tmp_path / "fr-data"
    result = runtime(["--data-dir", str(data_dir)])
    assert result["data_dir"] == str(data_dir)
    assert result["env"]["FUELRADAR_DATA_DIR"] == str(data_dir)
    assert result["env"]["FUELRADAR_CSV_UPLOAD_DIR"] == str(data_dir / IMPORT_DIRNAME)
    # POSIX-путь в sqlite-URL: SQLAlchemy одинаково понимает «C:/…» и «/…».
    assert result["env"]["DATABASE_URL"] == f"sqlite:///{(data_dir / DB_FILENAME).as_posix()}"


def test_data_dir_from_env_and_existing_database_url_is_respected(tmp_path: Path) -> None:
    from_env = runtime([], {"FUELRADAR_DATA_DIR": str(tmp_path)})
    assert from_env["data_dir"] == str(tmp_path)
    assert from_env["env"]["DATABASE_URL"].startswith("sqlite:///")

    # Сторонний (например, Postgres) режим не подменяется локальной SQLite.
    kept = runtime(["--data-dir", str(tmp_path)], {"DATABASE_URL": "postgresql+psycopg://db/fuelradar"})
    assert "DATABASE_URL" not in kept["env"]
    assert kept["env"]["FUELRADAR_DATA_DIR"] == str(tmp_path)


def test_region_becomes_the_default_region_of_the_app() -> None:
    # У приложения один регион: он же — регион сбора по расписанию и наполнения
    # каталога, поэтому --region (оболочка даёт ключ газетира) становится
    # DEFAULT_REGION_CITY; без него встроенный backend честно говорит, что сбор
    # не запущен, а не угадывает регион.
    assert runtime(["--region", "krasnodar"])["env"]["DEFAULT_REGION_CITY"] == "krasnodar"
    assert runtime([], {"FUELRADAR_SEED_REGION": "sochi"})["env"]["DEFAULT_REGION_CITY"] == "sochi"
    assert "DEFAULT_REGION_CITY" not in runtime([])["env"]
    # Явная настройка оператора важнее ключа из аргументов.
    kept = runtime(["--region", "krasnodar"], {"DEFAULT_REGION_CITY": "Краснодар"})
    assert "DEFAULT_REGION_CITY" not in kept["env"]


def test_ensure_data_dir_creates_missing_parents(tmp_path: Path) -> None:
    target = tmp_path / "a" / "b"
    created = ensure_data_dir({"data_dir": str(target)})
    assert created == target
    assert target.is_dir()
    # Нет каталога данных — нечего создавать (запуск из репозитория).
    assert ensure_data_dir({"data_dir": None}) is None


def test_frozen_support_env_only_for_packaged_bundle(tmp_path: Path) -> None:
    assert frozen_support_env(None) == {}
    assert frozen_support_env("") == {}

    bundle = tmp_path / "bundle"
    (bundle / "tests" / "fixtures").mkdir(parents=True)
    env = frozen_support_env(str(bundle))
    # В собранном приложении .env рядом с бинарником не читается: единственный
    # источник правды — config.json оболочки.
    assert env["FUELRADAR_NO_ENV_FILE"] == "1"
    assert env["FUELRADAR_FIXTURES_DIR"] == str(bundle / "tests" / "fixtures")


def test_frozen_support_env_without_fixtures_keeps_default_lookup(tmp_path: Path) -> None:
    env = frozen_support_env(str(tmp_path))
    assert env == {"FUELRADAR_NO_ENV_FILE": "1"}


def test_check_database_url_confirms_driver_is_available(capsys) -> None:
    # Проверка сборки: диалект собирается без подключения к базе (соединение на
    # машине сборки ничего не доказывает и может зависнуть).
    assert check_database_url("postgresql+psycopg://fuelradar@db.invalid/fuelradar") == 0
    assert "postgresql+psycopg" in capsys.readouterr().out


def test_check_database_url_reports_missing_driver(capsys) -> None:
    assert check_database_url("postgresql+нет-такого-драйвера://db/fuelradar") == 3
    assert "диалект не загрузился" in capsys.readouterr().err


def test_check_database_url_flag_is_parsed() -> None:
    args = build_parser().parse_args(["--check-database-url", "sqlite:///x.db"])
    assert args.check_database_url == "sqlite:///x.db"


def _make_local_db(data_dir: Path, rows: int = 2) -> Path:
    """Локальная база десктоп-приложения: `<данные>/fuelradar.db` с одной таблицей."""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / DB_FILENAME
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE demo (id INTEGER PRIMARY KEY)")
    connection.executemany("INSERT INTO demo DEFAULT VALUES", [() for _ in range(rows)])
    connection.commit()
    connection.close()
    return path


def _json_output(capsys) -> dict:
    line = capsys.readouterr().out.strip().splitlines()[-1]
    assert line.isascii()
    return json.loads(line)


# ---------- бэкап/перенос: релиз 0.1.8 (настройки десктопа) ----------


def test_backup_and_migrate_flags_are_parsed() -> None:
    parser = build_parser()
    assert parser.parse_args(["--backup-db"]).backup_db == ""
    assert parser.parse_args(["--backup-db", "D:/копии/fr.db"]).backup_db == "D:/копии/fr.db"
    assert parser.parse_args([]).backup_db is None
    assert parser.parse_args(["--migrate-db"]).migrate_db is True
    args = parser.parse_args(["--migrate-db", "--to-database-url", "postgresql+psycopg://db/fr"])
    assert args.to_database_url == "postgresql+psycopg://db/fr"


def test_migration_target_priority_is_argument_then_named_env_then_ambient(tmp_path: Path) -> None:
    parser = build_parser()
    explicit = parser.parse_args(["--migrate-db", "--to-database-url", "postgresql+psycopg://arg/db"])
    assert resolve_migration_target(explicit, {}) == "postgresql+psycopg://arg/db"
    # Аргумент важнее переменных — оператор ввёл адрес прямо сейчас.
    assert resolve_migration_target(explicit, {"FUELRADAR_TARGET_DATABASE_URL": "postgresql+psycopg://env/db"}) == (
        "postgresql+psycopg://arg/db"
    )
    bare = parser.parse_args(["--migrate-db"])
    assert resolve_migration_target(bare, {"FUELRADAR_TARGET_DATABASE_URL": "postgresql+psycopg://env/db"}) == (
        "postgresql+psycopg://env/db"
    )
    assert resolve_migration_target(bare, {"DATABASE_URL": "postgresql+psycopg://ambient/db"}) == (
        "postgresql+psycopg://ambient/db"
    )
    # Локальная SQLite в окружении — это не цель переноса: иначе «перенос в
    # Postgres» молча сделал бы копию локальной базы.
    assert resolve_migration_target(bare, {"DATABASE_URL": f"sqlite:///{tmp_path}/fr.db"}) is None
    assert resolve_migration_target(bare, {}) is None


def test_backup_destination_defaults_to_data_dir_backups(tmp_path: Path) -> None:
    assert resolve_backup_destination({"data_dir": str(tmp_path)}, None) is not None
    default = resolve_backup_destination({"data_dir": str(tmp_path)}, None)
    assert default.startswith(str(tmp_path / "backups"))
    assert default.endswith(".db")
    assert resolve_backup_destination({"data_dir": str(tmp_path)}, "D:/копии/x.db") == "D:/копии/x.db"
    # Нет каталога данных — нет и умолчания: путь должен прийти явно.
    assert resolve_backup_destination({"data_dir": None}, "") is None


def test_run_db_backup_reports_json_and_creates_the_copy(tmp_path: Path, capsys) -> None:
    data_dir = tmp_path / "data"
    _make_local_db(data_dir, rows=3)
    assert run_db_backup({"data_dir": str(data_dir)}, None) == 0
    report = _json_output(capsys)
    assert report["ok"] is True
    assert report["kind"] == "backup"
    assert report["tables"] == {"demo": 3}
    assert Path(report["path"]).is_file()
    assert Path(report["path"]).parent.name == "backups"


def test_run_db_backup_uses_the_explicit_destination(tmp_path: Path, capsys) -> None:
    data_dir = tmp_path / "data"
    _make_local_db(data_dir)
    destination = tmp_path / "выгрузка" / "fr-копия.db"
    assert run_db_backup({"data_dir": str(data_dir)}, str(destination)) == 0
    report = _json_output(capsys)
    assert report["path"] == str(destination)
    assert destination.is_file()


def test_run_db_backup_without_data_dir_is_an_honest_failure(capsys) -> None:
    assert run_db_backup({"data_dir": None}, None) == 4
    report = _json_output(capsys)
    assert report["ok"] is False
    assert "каталог данных" in report["error"]


def test_run_db_backup_missing_local_database_is_an_honest_failure(tmp_path: Path, capsys) -> None:
    data_dir = tmp_path / "пусто"
    data_dir.mkdir()
    assert run_db_backup({"data_dir": str(data_dir)}, str(tmp_path / "copy.db")) == 4
    report = _json_output(capsys)
    assert report["ok"] is False
    assert "не найдена" in report["error"]


def test_run_db_migration_without_target_says_what_is_missing(tmp_path: Path, capsys) -> None:
    data_dir = tmp_path / "data"
    _make_local_db(data_dir)
    assert run_db_migration({"data_dir": str(data_dir)}, None) == 4
    report = _json_output(capsys)
    assert report == {
        "kind": "migrate",
        "ok": False,
        "error": "не задан адрес внешней базы (backend.databaseUrl в config.json или DATABASE_URL)",
    }


def test_run_db_migration_refuses_a_local_target_and_keeps_the_password_hidden(tmp_path: Path, capsys) -> None:
    data_dir = tmp_path / "data"
    _make_local_db(data_dir)
    assert run_db_migration({"data_dir": str(data_dir)}, "sqlite:///other.db") == 4
    assert "должна быть Postgres" in _json_output(capsys)["error"]
    assert run_db_migration({"data_dir": str(data_dir)}, "mysql://user:secret@db/fr") == 4
    report = _json_output(capsys)
    assert report["ok"] is False
    assert "secret" not in json.dumps(report)


def test_run_db_migration_missing_local_database_is_an_honest_failure(tmp_path: Path, capsys) -> None:
    assert run_db_migration({"data_dir": str(tmp_path / "нет")}, "postgresql+psycopg://db/fr") == 4
    report = _json_output(capsys)
    assert report["ok"] is False
    assert "локальная база не найдена" in report["error"]


def test_apply_env_writes_variables(monkeypatch) -> None:
    monkeypatch.setattr(os, "environ", {})
    apply_env({"DATABASE_URL": "sqlite:///x.db", "FUELRADAR_DATA_DIR": "/tmp/x"})
    assert os.environ["DATABASE_URL"] == "sqlite:///x.db"
    assert os.environ["FUELRADAR_DATA_DIR"] == "/tmp/x"
