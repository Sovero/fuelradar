"use strict";

/**
 * Готовит ВСТРОЕННЫЙ backend для установщика: замораживает `backend/` в
 * самостоятельный бинарник (PyInstaller), чтобы приложение работало на машине,
 * где нет ни Python, ни venv.
 *
 * Почему frozen, а не `python -m uvicorn`: установщик ставится на машину пилота,
 * где Python может отсутствовать, а venv с зависимостями backend туда не доедет.
 * Замороженный бинарник несёт и сам интерпретатор, и все зависимости, а оболочка
 * запускает его как обычный процесс (desktop/main.cjs → backend.cjs).
 *
 * Что делает:
 *   1. находит Python с зависимостями backend (venv репозитория либо FUELRADAR_BUILD_PYTHON);
 *   2. если PyInstaller не установлен — ставит его (backend/requirements-desktop.txt);
 *   3. собирает one-dir сборку в desktop/backend-dist/fuelradar-backend;
 *   4. ЧЕСТНО проверяет результат: запускает бинарник на пустом каталоге данных
 *      (`--seed-offline` — база создалась?) и просит его загрузить диалект
 *      Postgres (`--check-database-url` — драйвер в бандле?). Проверка не
 *      прошла — шаг падает, а не отдаёт установщик, который на машине не
 *      запустится или не сможет работать с общей базой.
 *
 * Запуск: `cd desktop && npm run prepare:backend` (вызывается и из `npm run dist`).
 * Переменные: FUELRADAR_BUILD_PYTHON — интерпретатор сборки,
 *             FUELRADAR_BACKEND_SKIP_BUILD=1 — переиспользовать готовый артефакт.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, "..");
const ROOT = path.resolve(DESKTOP, "..");
const BACKEND = path.join(ROOT, "backend");
const FIXTURES = path.join(BACKEND, "tests", "fixtures");
const ENTRY = path.join(BACKEND, "desktop_server.py");
const REQUIREMENTS = path.join(BACKEND, "requirements-desktop.txt");
const DIST = path.join(DESKTOP, "backend-dist");
const WORK = path.join(DESKTOP, ".backend-build");

const NAME = "fuelradar-backend";
const OUT_DIR = path.join(DIST, NAME);
const EXE = path.join(OUT_DIR, process.platform === "win32" ? `${NAME}.exe` : NAME);

/**
 * Модули, которые PyInstaller не видит статически: uvicorn подгружает их сам
 * (`auto`-выбор loop/http/websockets), а backend импортирует часть кода внутри
 * функций (дайджест, лок воркера, метрики, модели-снэпшоты). Без них сборка
 * «успешна», но падает при старте — предупреждаем это явно.
 */
const HIDDEN_IMPORTS = [
  "app.main",
  "app.alerts.models",
  "app.analytics.models",
  "app.core.metrics",
  "app.digest.service",
  "app.worker.inprocess",
  "app.worker.locking",
  "cli.seed",
  "cli.regions",
  // Внешняя база (config.json → backend.databaseUrl): SQLAlchemy подгружает
  // диалект по имени динамически, а psycopg без явного импорта не попадал в бандл.
  "sqlalchemy.dialects.postgresql",
  "sqlalchemy.dialects.postgresql.psycopg",
  "psycopg",
  "psycopg_binary",
  "uvicorn.logging",
  "uvicorn.loops.auto",
  "uvicorn.loops.asyncio",
  "uvicorn.protocols.http.auto",
  "uvicorn.protocols.http.h11_impl",
  "uvicorn.protocols.http.httptools_impl",
  "uvicorn.protocols.websockets.auto",
  "uvicorn.protocols.websockets.websockets_impl",
  "uvicorn.lifespan.on",
  "uvicorn.lifespan.off",
];

/**
 * То, что десктоп-сборке не нужно: тестовые и линтерные зависимости, планировщик
 * воркера (в установленном приложении `python -m app.worker` не запускается —
 * сбор по расписанию ведёт встроенный тикер `app.worker.inprocess`).
 *
 * Драйвер Postgres, наоборот, В сборке: по умолчанию приложение пишет локальную
 * SQLite в каталог пользователя, но `backend.databaseUrl` может указать на общую
 * базу пилота — раньше такой адрес было некуда вписать, а драйвер не ехал с
 * установщиком (проверяется в verifyPostgresDriver ниже).
 */
const EXCLUDES = [
  "apscheduler",
  "pytest",
  "_pytest",
  "ruff",
  "yaml",
  "tkinter",
];

function runStep(name, command, args, cwd, extraEnv = {}) {
  console.log(`> ${name}`);
  // Без shell: Node ≥ 20 на Windows не запускает .cmd без shell (CVE-2024-27980).
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} завершился с кодом ${result.status}`);
}

/** Тихий запуск с захватом вывода: нужен для проверок «есть ли инструмент». */
function probe(command, args, cwd = BACKEND) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

/** Python с зависимостями backend: явный выбор → venv репозитория → PATH. */
function pickPython() {
  const explicit = String(process.env.FUELRADAR_BUILD_PYTHON ?? "").trim();
  if (explicit) return explicit;
  const relative = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  const candidates = [
    path.join(BACKEND, ".venv", ...relative),
    path.join(ROOT, ".venv", ...relative),
    path.join(BACKEND, "venv", ...relative),
    path.join(ROOT, "venv", ...relative),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? (process.platform === "win32" ? "python" : "python3");
}

function ensurePython(python) {
  const check = probe(python, ["-c", "import fastapi, uvicorn, sqlalchemy, pydantic; print('ok')"]);
  if (check.status !== 0) {
    const detail = (check.stderr || check.error?.message || "нет ответа").trim().split("\n").slice(-3).join(" ");
    throw new Error(
      `Python с зависимостями backend не найден (${python}): ${detail}\n` +
        `Установите окружение (make install / setup.ps1) или укажите FUELRADAR_BUILD_PYTHON.`,
    );
  }
}

function ensurePyInstaller(python) {
  let version = probe(python, ["-m", "PyInstaller", "--version"]);
  if (version.status !== 0) {
    runStep("python -m pip install -r backend/requirements-desktop.txt", python, ["-m", "pip", "install", "-r", REQUIREMENTS], BACKEND);
    version = probe(python, ["-m", "PyInstaller", "--version"]);
    if (version.status !== 0) {
      throw new Error(`PyInstaller не установился: ${(version.stderr || "").trim()}`);
    }
  }
  return version.stdout.trim();
}

function buildArgs() {
  const args = [
    "--noconfirm",
    "--clean",
    "--onedir",
    "--name",
    NAME,
    "--distpath",
    DIST,
    "--workpath",
    WORK,
    "--specpath",
    WORK,
    "--paths",
    BACKEND,
    // Офлайн-фикстуры: их читает `cli.seed --offline` при первом запуске
    // приложения (наполнение демо-каталога без сети).
    "--add-data",
    `${FIXTURES}${path.delimiter}tests/fixtures`,
    ...HIDDEN_IMPORTS.flatMap((module) => ["--hidden-import", module]),
    ...EXCLUDES.flatMap((module) => ["--exclude-module", module]),
    ENTRY,
  ];
  return args;
}

function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  }
  return total;
}

/**
 * Проверка «без Python»: запускаем собранный бинарник на пустом каталоге данных
 * как это сделает оболочка при первом старте. Успех = импортировались всё
 * приложение, источники и дедупликация, и появилась непустая SQLite-база.
 */
function verifyArtifact() {
  const dataDir = path.join(WORK, "verify-data");
  fs.rmSync(dataDir, { recursive: true, force: true });
  const result = probe(EXE, ["--data-dir", dataDir, "--seed-offline", "--region", "krasnodar"], WORK);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-8).join("\n");
    throw new Error(`Встроенный backend не прошёл проверку (код ${result.status}):\n${detail}`);
  }
  const db = path.join(dataDir, "fuelradar.db");
  const size = fs.existsSync(db) ? fs.statSync(db).size : 0;
  if (size <= 0) throw new Error(`Встроенный backend не создал базу данных: ${db}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  return size;
}

/**
 * Проверка «драйвер Postgres внутри сборки»: у замороженного бинарника просим
 * загрузить диалект SQLAlchemy по postgres-адресу (без подключения — попытка
 * соединения на машине сборки ничего не доказывает и может зависнуть). Если
 * psycopg не попал в бандл, диалект не соберётся — установщик не соберётся тоже.
 */
function verifyPostgresDriver() {
  const result = probe(EXE, ["--check-database-url", "postgresql+psycopg://fuelradar@db.invalid/fuelradar"], WORK);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0 || !/dialect postgresql\+psycopg/.test(output)) {
    const detail = output.trim().split("\n").slice(-6).join("\n") || `код ${result.status}`;
    throw new Error(`В сборке нет драйвера Postgres (psycopg):\n${detail}`);
  }
  return "драйвер Postgres на месте (диалект postgresql+psycopg грузится)";
}

function main() {
  if (!fs.existsSync(ENTRY)) throw new Error(`Не найдена точка входа встроенного backend: ${ENTRY}`);
  if (!fs.existsSync(FIXTURES)) throw new Error(`Не найдены офлайн-фикстуры: ${FIXTURES}`);

  if (process.env.FUELRADAR_BACKEND_SKIP_BUILD === "1" && fs.existsSync(EXE)) {
    console.log(`> сборка backend пропущена (FUELRADAR_BACKEND_SKIP_BUILD=1): ${EXE}`);
    return;
  }

  const python = pickPython();
  console.log(`> Python сборки: ${python}`);
  ensurePython(python);
  const pyinstaller = ensurePyInstaller(python);
  console.log(`> PyInstaller: ${pyinstaller}`);

  runStep("pyinstaller: freeze backend (onedir)", python, ["-m", "PyInstaller", ...buildArgs()], BACKEND);

  if (!fs.existsSync(EXE)) throw new Error(`PyInstaller не создал бинарник: ${EXE}`);
  const dbBytes = verifyArtifact();
  const postgres = verifyPostgresDriver();
  const megabytes = (dirSize(OUT_DIR) / 1024 / 1024).toFixed(1);
  console.log(
    `Готово: ${path.relative(ROOT, EXE)} (${megabytes} МБ), проверка без Python пройдена ` +
      `(база ${dbBytes} Б), ${postgres}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
