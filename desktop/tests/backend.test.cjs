"use strict";

/**
 * Тесты работы с backend в оболочке (desktop/backend.cjs).
 *
 * Главное, что проверяется: адрес API и автозапуск разбираются по приоритетам
 * (переменные окружения → config.json → дефолт), локальный backend ищется по
 * маркеру app/main.py, health-проба честно различает причины (HTTP-код,
 * ECONNREFUSED, таймаут), а статус-экран показывает адрес, источник, подробность
 * и кнопки, экранируя вывод процесса.
 *
 * Отдельно проверяются два свойства встроенного backend: что он собирает данные
 * по расписанию сам (COLLECT_IN_PROCESS) и что во внешнюю базу (databaseUrl)
 * пароль не протекает ни в лог, ни на статус-экран.
 */

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

const {
  BACKUP_DIRNAME,
  DB_FILENAME,
  DEFAULT_API_URL,
  PYTHON_PATH_SOURCE,
  RUNTIME_KIND,
  STATE,
  backendEnv,
  backendStatusHtml,
  backupDir,
  backupFileName,
  collectionSummary,
  configTemplate,
  databaseStatus,
  defaultBackupPath,
  describeState,
  isLoopbackUrl,
  localDatabaseFile,
  maintenanceCommand,
  maskDatabaseUrl,
  normalizeConfig,
  parseMaintenanceReport,
  parsePort,
  planBackend,
  probeHealth,
  runtimeCommand,
  runtimeSummary,
  startArgs,
  storageSummary,
} = require("../backend.cjs");

const REPO_ROOT = path.join("C:", "Projects", "Python", "fuelradar");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const DESKTOP_DIR = path.resolve(__dirname, "..");
const VENV_PYTHON = path.join(BACKEND_DIR, ".venv", "Scripts", "python.exe");
const MARKER = path.join(BACKEND_DIR, "app", "main.py");
// Встроенный backend так же, как его собирает desktop/scripts/prepare-backend.mjs.
const BUNDLED = path.join(DESKTOP_DIR, "backend-dist", "fuelradar-backend", "fuelradar-backend.exe");
const USER_DATA = path.join("C:", "Users", "x", "AppData", "Roaming", "FuelRadar");

function existsIn(...paths) {
  const set = new Set(paths);
  return (candidate) => set.has(candidate);
}

function response(status, body, ok = status >= 200 && status < 300) {
  return {
    status,
    ok,
    json: async () => body,
  };
}

test("файлы оболочки синтаксически валидны (Electron грузит их целиком, без сборки)", () => {
  for (const file of ["main.cjs", "preload.cjs", "backend.cjs"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(DESKTOP_DIR, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

// ---------- панель «Данные»: копия/экспорт локальной базы и перенос в Postgres ----------

test("копия базы: имя по UTC-штампу и путь в backups рядом с данными", () => {
  const moment = new Date(Date.UTC(2026, 9, 6, 7, 5, 9));
  assert.equal(backupFileName(moment), "fuelradar-20261006-070509.db");
  assert.equal(backupDir({ dataDir: "D:\\fr" }), path.join("D:\\fr", BACKUP_DIRNAME));
  assert.equal(backupDir({}), null);
  assert.equal(defaultBackupPath({ dataDir: "D:\\fr" }, moment), path.join("D:\\fr", BACKUP_DIRNAME, "fuelradar-20261006-070509.db"));
  assert.equal(defaultBackupPath({}), null);
  assert.equal(localDatabaseFile({ dataDir: "D:\\fr" }), path.join("D:\\fr", DB_FILENAME));
  assert.equal(localDatabaseFile({}), null);
});

test("служебная команда базы: встроенный backend, dev-запуск и честное «нечем»", () => {
  const bundled = { bundledExe: "C:\\app\\resources\\backend\\fuelradar-backend.exe", dataDir: "C:\\data" };
  const backup = maintenanceCommand(bundled, "backup");
  assert.equal(backup.kind, RUNTIME_KIND.BUNDLED);
  assert.deepEqual(backup.args, ["--data-dir", "C:\\data", "--backup-db"]);
  assert.equal(backup.cwd, "C:\\data");

  const exported = maintenanceCommand(bundled, "backup", { destination: "D:\\копии\\fr.db" });
  assert.deepEqual(exported.args.slice(-1), ["D:\\копии\\fr.db"]);

  const migrate = maintenanceCommand(bundled, "migrate", { target: "postgresql+psycopg://u:p@h/db" });
  assert.deepEqual(migrate.args, ["--data-dir", "C:\\data", "--migrate-db", "--to-database-url", "postgresql+psycopg://u:p@h/db"]);

  // Dev-запуск оболочки: тот же модуль есть в каталоге backend.
  const dev = maintenanceCommand({ python: "C:\\py\\python.exe", backendDir: BACKEND_DIR, dataDir: "C:\\data" }, "backup");
  assert.equal(dev.kind, RUNTIME_KIND.PYTHON);
  assert.equal(dev.command, "C:\\py\\python.exe");
  assert.equal(dev.args[0], path.join(BACKEND_DIR, "desktop_server.py"));
  assert.equal(dev.cwd, BACKEND_DIR);

  // Ни бинарника, ни каталога с Python — запускать нечего (R97i).
  assert.equal(maintenanceCommand({ dataDir: "C:\\data" }, "backup"), null);
  assert.equal(maintenanceCommand(bundled, "что-то ещё"), null);
});

test("отчёт служебной команды: берётся последняя JSON-строка, мусор — null", () => {
  const text = ['[seed] наполнение', '{"kind":"backup","ok":true,"rows":3}', 'готово'].join("\n");
  assert.deepEqual(parseMaintenanceReport(text), { kind: "backup", ok: true, rows: 3 });
  assert.deepEqual(parseMaintenanceReport('{"ok":false,"error":"нет"}\n{"ok":true,"kind":"backup"}'), {
    ok: true,
    kind: "backup",
  });
  assert.equal(parseMaintenanceReport("просто текст"), null);
  assert.equal(parseMaintenanceReport('{"не наш":true}'), null);
  assert.equal(parseMaintenanceReport("{"), null);
  assert.equal(parseMaintenanceReport(null), null);
});

test("статус данных: локальный файл, внешняя база и доступность переноса", () => {
  const plan = { bundledExe: "C:\\b\\fuelradar-backend.exe", dataDir: "C:\\data" };
  const local = databaseStatus(plan, { exists: true, bytes: 2048, modifiedAt: "2026-10-06T07:00:00.000Z" });
  assert.equal(local.supported, true);
  assert.equal(local.external, false);
  assert.equal(local.externalUrl, null);
  assert.equal(local.migrationSupported, false);
  assert.equal(local.localFile, path.join("C:\\data", DB_FILENAME));
  assert.equal(local.localExists, true);
  assert.equal(local.localBytes, 2048);
  assert.equal(local.backupDir, path.join("C:\\data", BACKUP_DIRNAME));

  // Внешняя база настроена: адрес виден без пароля, перенос доступен.
  const external = databaseStatus(
    { ...plan, databaseUrl: "postgresql+psycopg://u:secret@h:5432/db", databaseSource: "config.json (backend.databaseUrl)" },
    { exists: false },
  );
  assert.equal(external.external, true);
  assert.equal(external.externalUrl, "postgresql+psycopg://u:***@h:5432/db");
  assert.equal(external.migrationSupported, true);
  assert.ok(!JSON.stringify(external).includes("secret"));

  // Нечем делать копию — честная причина, а не пустая кнопка.
  const unsupported = databaseStatus({ dataDir: "C:\\data" }, null);
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /нечем снимать копию/);
});

test("isLoopbackUrl: локальные адреса — 127.0.0.1/localhost/[::1], прочие нет", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8000"), true);
  assert.equal(isLoopbackUrl("http://localhost:8000"), true);
  assert.equal(isLoopbackUrl("http://[::1]:8000"), true);
  assert.equal(isLoopbackUrl("https://api.example.com"), false);
  assert.equal(isLoopbackUrl("http://192.168.1.10:8000"), false);
  assert.equal(isLoopbackUrl("не адрес"), false);
});

test("parsePort: порт из адреса, иначе дефолт по схеме", () => {
  assert.equal(parsePort("http://127.0.0.1:8123"), 8123);
  assert.equal(parsePort("http://127.0.0.1"), 80);
  assert.equal(parsePort("https://api.example.com"), 443);
  assert.equal(parsePort("мусор"), 8000);
});

test("normalizeConfig: строки обрезаются, автозапуск по умолчанию включён", () => {
  assert.deepEqual(normalizeConfig(null), {
    apiBaseUrl: null,
    backend: { autostart: true, dir: null, python: null, dataDir: null, seedRegion: null, collect: null, databaseUrl: null },
  });
  assert.deepEqual(
    normalizeConfig({
      apiBaseUrl: "  http://127.0.0.1:9000 ",
      backend: {
        autostart: false,
        dir: " C:\\b ",
        python: " C:\\py.exe ",
        dataDir: " D:\\d ",
        seedRegion: " sochi ",
        collect: false,
        databaseUrl: " postgresql+psycopg://u:p@h/db ",
      },
    }),
    {
      apiBaseUrl: "http://127.0.0.1:9000",
      backend: {
        autostart: false,
        dir: "C:\\b",
        python: "C:\\py.exe",
        dataDir: "D:\\d",
        seedRegion: "sochi",
        collect: false,
        databaseUrl: "postgresql+psycopg://u:p@h/db",
      },
    },
  );
  // Собирать данные по расписанию / ходить во внешнюю базу — только если сказано
  // явно: строка/булево другого типа не превращается в настройку.
  assert.equal(normalizeConfig({ backend: { collect: "нет", databaseUrl: 42 } }).backend.collect, null);
  assert.equal(normalizeConfig({ backend: { collect: "нет", databaseUrl: 42 } }).backend.databaseUrl, null);
});

test("planBackend: без настроек — дефолтный локальный адрес и автозапуск", () => {
  const plan = planBackend({ env: {}, config: {}, exists: () => false, platform: "win32" });
  assert.equal(plan.apiUrl, DEFAULT_API_URL);
  assert.match(plan.apiSource, /по умолчанию/);
  assert.equal(plan.isLoopback, true);
  assert.equal(plan.port, 8000);
  assert.equal(plan.autostart, true);
  assert.equal(plan.backendDir, null);
  assert.equal(plan.python, "python");
  assert.equal(plan.pythonSource, PYTHON_PATH_SOURCE);
  assert.deepEqual(plan.backendDirCandidates, []);
});

test("planBackend: переменная окружения важнее config.json, удалённый адрес распознан", () => {
  const plan = planBackend({
    env: { FUELRADAR_API_URL: "https://api.example.com" },
    config: { apiBaseUrl: "http://127.0.0.1:9000" },
    exists: () => false,
  });
  assert.equal(plan.apiUrl, "https://api.example.com");
  assert.equal(plan.apiSource, "переменная окружения FUELRADAR_API_URL");
  assert.equal(plan.isLoopback, false);
  assert.equal(plan.port, 443);
});

test("planBackend: автозапуск выключается настройкой и переменной окружения", () => {
  assert.equal(planBackend({ env: {}, config: { backend: { autostart: false } }, exists: () => false }).autostart, false);
  const fromEnv = planBackend({ env: { FUELRADAR_BACKEND_AUTOSTART: "0" }, config: { backend: { autostart: true } }, exists: () => false });
  assert.equal(fromEnv.autostart, false);
  assert.equal(fromEnv.autostartSource, "переменная окружения FUELRADAR_BACKEND_AUTOSTART");
});

test("planBackend: каталог ищется по маркеру app/main.py, приоритет — явные настройки", () => {
  const configDir = path.join("D:", "fuelradar-backend");
  const plan = planBackend({
    env: {},
    config: { backend: { dir: configDir } },
    repoRoot: REPO_ROOT,
    exists: existsIn(path.join(configDir, "app", "main.py")),
  });
  assert.equal(plan.backendDir, configDir);
  assert.equal(plan.backendDirSource, "config.json (backend.dir)");

  // Без маркера каталог не считается backend — честно «не найден».
  const notABackend = planBackend({ env: {}, config: { backend: { dir: configDir } }, exists: () => false });
  assert.equal(notABackend.backendDir, null);
  assert.equal(notABackend.pythonSource, PYTHON_PATH_SOURCE);
});

test("planBackend: явный каталог/интерпретатор проверяются и репортятся, а не подменяются молча", () => {
  // Каталог из переменной окружения без маркера app/main.py: подмена каталогом
  // репозитория запрещена — иначе ошибка настройки была бы не видна.
  const brokenDir = planBackend({
    env: { FUELRADAR_BACKEND_DIR: path.join("D:", "нет-такого") },
    config: {},
    repoRoot: REPO_ROOT,
    exists: existsIn(MARKER, VENV_PYTHON),
    platform: "win32",
  });
  assert.equal(brokenDir.backendDir, null);
  assert.equal(brokenDir.explicitDirMissing.source, "переменная окружения FUELRADAR_BACKEND_DIR");

  // Явный путь к интерпретатору, которого нет: тоже честная ошибка.
  const brokenPython = planBackend({
    env: { FUELRADAR_PYTHON: "C:\\nope\\python.exe" },
    config: {},
    repoRoot: REPO_ROOT,
    exists: existsIn(MARKER, VENV_PYTHON),
    platform: "win32",
  });
  assert.equal(brokenPython.python, null);
  assert.equal(brokenPython.explicitPythonMissing.python, "C:\\nope\\python.exe");

  // Голое имя команды (python3) — доверяем PATH, но помечаем для проверки запуска.
  const fromPath = planBackend({ env: { FUELRADAR_PYTHON: "python3" }, config: {}, exists: () => false, platform: "linux" });
  assert.equal(fromPath.python, "python3");
  assert.equal(fromPath.pythonFromPath, true);
  assert.equal(fromPath.explicitPythonMissing, null);
});

test("planBackend: Python берётся из venv рядом с backend, PATH — последний вариант", () => {
  const plan = planBackend({
    env: {},
    config: {},
    repoRoot: REPO_ROOT,
    exists: existsIn(MARKER, VENV_PYTHON),
    platform: "win32",
  });
  assert.equal(plan.backendDir, BACKEND_DIR);
  assert.equal(plan.python, VENV_PYTHON);
  assert.match(plan.pythonSource, /виртуальное окружение/);

  const explicit = planBackend({
    env: { FUELRADAR_PYTHON: "C:\\Python\\python.exe" },
    config: {},
    exists: existsIn("C:\\Python\\python.exe"),
  });
  assert.equal(explicit.python, "C:\\Python\\python.exe");
  assert.equal(explicit.pythonSource, "переменная окружения FUELRADAR_PYTHON");
});

test("probeHealth: ok на 200 со status=ok и без тела; подробности на ошибках", async () => {
  const ok = await probeHealth({ url: "http://127.0.0.1:8000", fetchImpl: async () => response(200, { status: "ok" }) });
  assert.deepEqual(ok, { ok: true, detail: null });

  const noBody = await probeHealth({
    url: "http://127.0.0.1:8000/",
    fetchImpl: async () => ({ ...response(200, null), json: async () => { throw new Error("no json"); } }),
  });
  assert.equal(noBody.ok, true);

  const httpError = await probeHealth({ url: "http://127.0.0.1:8000", fetchImpl: async () => response(500, {}) });
  assert.equal(httpError.ok, false);
  assert.match(httpError.detail, /HTTP 500/);

  const notReady = await probeHealth({ url: "http://127.0.0.1:8000", fetchImpl: async () => response(200, { status: "not_ready" }) });
  assert.equal(notReady.ok, false);
  assert.match(notReady.detail, /not_ready/);
});

test("probeHealth: причина без стектрейса — ECONNREFUSED и таймаут", async () => {
  const refused = await probeHealth({
    url: "http://127.0.0.1:8000",
    fetchImpl: async () => {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8000" };
      throw error;
    },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.detail, "ECONNREFUSED");

  const timeout = await probeHealth({
    url: "http://127.0.0.1:8000",
    fetchImpl: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
    timeoutMs: 1234,
  });
  assert.equal(timeout.detail, "таймаут 1234 мс");
});

test("startArgs: тот же запуск, что make dev", () => {
  assert.deepEqual(startArgs(8000), ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"]);
});

// ---------- сбор по расписанию и внешняя база ----------

function bundledPlan(overrides = {}) {
  return planBackend({
    env: overrides.env ?? {},
    config: overrides.config ?? {},
    repoRoot: REPO_ROOT,
    userDataDir: USER_DATA,
    bundledBackend: BUNDLED,
    exists: existsIn(MARKER, VENV_PYTHON, BUNDLED),
    platform: "win32",
  });
}

test("planBackend: встроенный backend собирает данные по расписанию, пока это не выключено", () => {
  const byDefault = bundledPlan();
  assert.equal(byDefault.runtimeKind, RUNTIME_KIND.BUNDLED);
  assert.equal(byDefault.collect, true);
  assert.equal(byDefault.collectEnv, "1");
  assert.match(collectionSummary(byDefault), /включён: встроенный backend/);

  const off = bundledPlan({ config: { backend: { collect: false } } });
  assert.equal(off.collect, false);
  assert.equal(off.collectEnv, "0");
  assert.match(collectionSummary(off), /выключен/);

  // Явная переменная окружения важнее config.json и сама доезжает до процесса:
  // подставлять своё значение поверх неё оболочка не имеет права.
  const byEnv = bundledPlan({ env: { COLLECT_IN_PROCESS: "0" } });
  assert.equal(byEnv.collect, false);
  assert.equal(byEnv.collectEnv, null);
  assert.equal(byEnv.collectSource, "переменная окружения COLLECT_IN_PROCESS");
});

test("planBackend: dev-запуск оставляет сбор отдельному воркеру", () => {
  const plan = planBackend({ env: {}, config: {}, repoRoot: REPO_ROOT, bundledBackend: BUNDLED, exists: existsIn(MARKER, VENV_PYTHON), platform: "win32" });
  assert.equal(plan.runtimeKind, RUNTIME_KIND.PYTHON);
  assert.equal(plan.collect, null);
  assert.equal(plan.collectEnv, null);
  assert.match(collectionSummary(plan), /ведёт отдельный воркер/);
});

test("planBackend: внешняя база — окружение важнее config.json, значение доезжает до процесса", () => {
  const sqliteByDefault = bundledPlan();
  assert.equal(sqliteByDefault.databaseUrl, null);
  assert.equal(sqliteByDefault.databaseUrlEnv, null);
  assert.equal(storageSummary(sqliteByDefault), "локальная SQLite в каталоге данных");

  const fromConfig = bundledPlan({ config: { backend: { databaseUrl: "postgresql+psycopg://u:p@host:5432/fuelradar" } } });
  assert.equal(fromConfig.databaseUrlEnv, "postgresql+psycopg://u:p@host:5432/fuelradar");
  assert.equal(fromConfig.databaseSource, "config.json (backend.databaseUrl)");

  const fromEnv = bundledPlan({
    env: { DATABASE_URL: "postgresql+psycopg://env:env@host/db" },
    config: { backend: { databaseUrl: "postgresql+psycopg://u:p@host/fuelradar" } },
  });
  assert.equal(fromEnv.databaseUrl, "postgresql+psycopg://env:env@host/db");
  assert.equal(fromEnv.databaseSource, "переменная окружения DATABASE_URL");
  assert.equal(fromEnv.databaseUrlEnv, null);
});

test("backendEnv: в дочерний процесс уходит только то, что задала оболочка", () => {
  assert.deepEqual(backendEnv(bundledPlan()), { COLLECT_IN_PROCESS: "1" });
  assert.deepEqual(backendEnv(bundledPlan({ config: { backend: { collect: false } } })), { COLLECT_IN_PROCESS: "0" });
  assert.deepEqual(backendEnv(bundledPlan({ config: { backend: { databaseUrl: "postgresql+psycopg://u:p@h/db" } } })), {
    COLLECT_IN_PROCESS: "1",
    DATABASE_URL: "postgresql+psycopg://u:p@h/db",
  });
  // Dev-запуск (python) ничего не навязывает: расписание ведёт воркер.
  assert.deepEqual(backendEnv(planBackend({ env: {}, config: {}, exists: () => false })), {});
  // Smoke-прогон гасит сбор явно — прогон не ходит в сеть.
  assert.deepEqual(backendEnv(bundledPlan(), { COLLECT_IN_PROCESS: "0" }), { COLLECT_IN_PROCESS: "0" });
});

test("maskDatabaseUrl: пароль не утекает в лог и на экран", () => {
  assert.equal(
    maskDatabaseUrl("postgresql+psycopg://fuelradar:s3cret@db.local:5432/fuelradar"),
    "postgresql+psycopg://fuelradar:***@db.local:5432/fuelradar",
  );
  // Без пароля строка не переписывается — маскировать нечего.
  assert.equal(maskDatabaseUrl("postgresql+psycopg://db.local/fuelradar"), "postgresql+psycopg://db.local/fuelradar");
  assert.equal(maskDatabaseUrl(""), null);
  assert.equal(maskDatabaseUrl(null), null);
});

test("storageSummary: внешняя база названа и без пароля", () => {
  const summary = storageSummary({ databaseUrl: "postgresql+psycopg://u:p@h/db", databaseSource: "config.json (backend.databaseUrl)" });
  assert.match(summary, /внешняя база: postgresql\+psycopg:\/\/u:\*\*\*@h\/db/);
  assert.doesNotMatch(summary, /:p@/);
});

// ---------- встроенный backend (Python на машине пилота нет) ----------

test("planBackend: встроенный backend из установщика важнее venv и PATH", () => {
  const plan = planBackend({
    env: {},
    config: {},
    repoRoot: REPO_ROOT,
    userDataDir: USER_DATA,
    bundledBackend: BUNDLED,
    exists: existsIn(MARKER, VENV_PYTHON, BUNDLED),
    platform: "win32",
  });
  assert.equal(plan.runtimeKind, RUNTIME_KIND.BUNDLED);
  assert.equal(plan.bundledExe, BUNDLED);
  // Найденный Python всё равно остаётся в плане: экран показывает, что рядом.
  assert.equal(plan.python, VENV_PYTHON);
});

test("planBackend: без встроенного — откат на Python, а явный путь его не подменяет", () => {
  const fallback = planBackend({
    env: {},
    config: {},
    repoRoot: REPO_ROOT,
    bundledBackend: BUNDLED,
    exists: existsIn(MARKER, VENV_PYTHON),
    platform: "win32",
  });
  assert.equal(fallback.runtimeKind, RUNTIME_KIND.PYTHON);
  assert.equal(fallback.bundledExe, null);
  // Путь к встроенному всё равно показан — иначе «где искали» было бы неполным.
  assert.equal(fallback.bundledPath, BUNDLED);
  assert.equal(fallback.python, VENV_PYTHON);

  const pinned = planBackend({
    env: { FUELRADAR_PYTHON: "C:\\Python\\python.exe" },
    config: {},
    bundledBackend: BUNDLED,
    exists: existsIn("C:\\Python\\python.exe", BUNDLED),
    platform: "win32",
  });
  assert.equal(pinned.runtimeKind, RUNTIME_KIND.PYTHON);
  assert.equal(pinned.bundledExe, null);
  assert.equal(pinned.python, "C:\\Python\\python.exe");
});

test("planBackend: каталог данных — переменная → config.json → каталог приложения", () => {
  const byDefault = planBackend({ env: {}, config: {}, userDataDir: USER_DATA, exists: () => false });
  assert.equal(byDefault.dataDir, path.join(USER_DATA, "data"));
  assert.equal(byDefault.dataDirSource, "каталог данных приложения");

  const fromConfig = planBackend({ env: {}, config: { backend: { dataDir: "D:\\fr-data" } }, userDataDir: USER_DATA, exists: () => false });
  assert.equal(fromConfig.dataDir, "D:\\fr-data");
  assert.equal(fromConfig.dataDirSource, "config.json (backend.dataDir)");

  const fromEnv = planBackend({
    env: { FUELRADAR_DATA_DIR: "E:\\data" },
    config: { backend: { dataDir: "D:\\fr-data" } },
    userDataDir: USER_DATA,
    exists: () => false,
  });
  assert.equal(fromEnv.dataDir, "E:\\data");
  assert.equal(fromEnv.dataDirSource, "переменная окружения FUELRADAR_DATA_DIR");

  // Относительный путь считается от каталога данных приложения, а не от CWD процесса:
  // у установленного приложения CWD произвольный.
  const relative = planBackend({ env: {}, config: { backend: { dataDir: "fr-data" } }, userDataDir: USER_DATA, exists: () => false });
  assert.equal(relative.dataDir, path.resolve(USER_DATA, "fr-data"));
});

test("planBackend: регион первого наполнения — переменная важнее config.json", () => {
  assert.equal(planBackend({ env: {}, config: {}, exists: () => false }).seedRegion, null);
  assert.equal(planBackend({ env: {}, config: { backend: { seedRegion: "sochi" } }, exists: () => false }).seedRegion, "sochi");
  assert.equal(
    planBackend({ env: { FUELRADAR_SEED_REGION: "krasnodar" }, config: { backend: { seedRegion: "sochi" } }, exists: () => false }).seedRegion,
    "krasnodar",
  );
});

test("runtimeCommand: встроенный бинарник получает адрес, порт и каталог данных", () => {
  assert.deepEqual(runtimeCommand({ bundledExe: BUNDLED, port: 8123, dataDir: "E:\\data" }), {
    kind: RUNTIME_KIND.BUNDLED,
    command: BUNDLED,
    args: ["--host", "127.0.0.1", "--port", "8123", "--data-dir", "E:\\data"],
  });
  // Без каталога данных аргумент не выдумывается: бинарник возьмёт свой дефолт.
  assert.deepEqual(runtimeCommand({ bundledExe: BUNDLED, port: 8000, dataDir: null }), {
    kind: RUNTIME_KIND.BUNDLED,
    command: BUNDLED,
    args: ["--host", "127.0.0.1", "--port", "8000"],
  });
  // Регион пилота доезжает до самого процесса: по нему идёт сбор по расписанию
  // (без региона встроенный backend честно отвечает, что сбор не запущен).
  assert.deepEqual(runtimeCommand({ bundledExe: BUNDLED, port: 8000, dataDir: "E:\\data", seedRegion: "krasnodar" }), {
    kind: RUNTIME_KIND.BUNDLED,
    command: BUNDLED,
    args: ["--host", "127.0.0.1", "--port", "8000", "--data-dir", "E:\\data", "--region", "krasnodar"],
  });
  assert.deepEqual(runtimeCommand({ python: "C:\\py.exe", port: 8000 }), {
    kind: RUNTIME_KIND.PYTHON,
    command: "C:\\py.exe",
    args: startArgs(8000),
  });
  assert.equal(runtimeCommand({ port: 8000 }), null);
});

test("runtimeSummary: встроенный backend назван явно, иначе каталог и Python", () => {
  assert.equal(runtimeSummary({ runtime: { kind: RUNTIME_KIND.BUNDLED, exe: BUNDLED } }), `встроенный backend: ${BUNDLED}`);
  const asPython = runtimeSummary({
    runtime: { kind: RUNTIME_KIND.PYTHON, dir: BACKEND_DIR, dirSource: "каталог репозитория", python: VENV_PYTHON, pythonSource: "виртуальное окружение" },
  });
  assert.match(asPython, /каталог: .*виртуальное окружение/);
  assert.equal(runtimeSummary({ runtime: null }), null);
});

test("describeState: у каждого состояния есть заголовок и подсказка, неизвестное не падает", () => {
  for (const state of Object.values(STATE)) {
    const text = describeState(state);
    assert.ok(text.title.length > 0);
    assert.ok(text.message.length > 0);
  }
  assert.equal(describeState("нет-такого").title, describeState(STATE.START_FAILED).title);
});

test("backendStatusHtml: адрес, источник, подробность и кнопки; вывод экранирован", () => {
  const html = backendStatusHtml({
    state: STATE.START_FAILED,
    url: "http://127.0.0.1:8000",
    source: "config.json (apiBaseUrl)",
    runtime: { dir: BACKEND_DIR, dirSource: "config.json (backend.dir)", python: VENV_PYTHON, pythonSource: "виртуальное окружение" },
    searched: [BACKEND_DIR],
    attempt: "запуск: python —m uvicorn app.main:app --port 8000",
    detail: "HTTP 500",
    processOutput: "ModuleNotFoundError: <script>alert(1)</script>",
    checkedAt: "2026-10-06T10:00:00.000Z",
    configPath: path.join("C:", "Users", "x", "AppData", "Roaming", "FuelRadar", "config.json"),
  });

  assert.match(html, /http:\/\/127\.0\.0\.1:8000/);
  assert.match(html, /config\.json \(apiBaseUrl\)/);
  assert.match(html, /HTTP 500/);
  assert.match(html, /Повторить/);
  assert.match(html, /Открыть конфиг/);
  assert.match(html, /fuelradarDesktop\.backend/);
  assert.ok(!html.includes("<script>alert(1)</script>"), "вывод процесса должен быть экранирован");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /class="hint"/);
});

test("backendStatusHtml: перезагрузка сама перепроверяет backend, пустые пути подписаны", () => {
  const html = backendStatusHtml({
    state: STATE.NO_RUNTIME,
    url: DEFAULT_API_URL,
    source: "значение по умолчанию (http://127.0.0.1:8000)",
    runtime: { dir: null, dirSource: null, python: null, pythonSource: null },
    searched: [],
    attempt: null,
    detail: null,
    checkedAt: "2026-10-06T10:00:00.000Z",
  });
  assert.match(html, /runRetry\(true\)/); // автопроверка при загрузке страницы
  assert.match(html, /каталог: не найден/);
  assert.match(html, /Python: не найден/);
  assert.ok(!html.includes("null"), "в экране не должно быть null вместо подписи");
});

test("backendStatusHtml: рабочее состояние — без подсказки «что делать»", () => {
  const html = backendStatusHtml({ state: STATE.OK, url: DEFAULT_API_URL, source: "значение по умолчанию", checkedAt: "2026-10-06T10:00:00.000Z" });
  assert.match(html, /Backend отвечает/);
  assert.ok(!html.includes('class="hint"'));
});

test("backendStatusHtml: встроенный backend и каталог данных видны на экране", () => {
  const html = backendStatusHtml({
    state: STATE.START_FAILED,
    url: DEFAULT_API_URL,
    source: "значение по умолчанию",
    runtime: { kind: RUNTIME_KIND.BUNDLED, exe: BUNDLED },
    bundledPath: BUNDLED,
    dataDir: "E:\\data",
    searched: [],
    checkedAt: "2026-10-06T10:00:00.000Z",
  });
  assert.match(html, /встроенный backend/);
  assert.match(html, /Каталог данных/);
  assert.match(html, /E:\\data/);
  assert.ok(!html.includes("null"), "в экране не должно быть null вместо подписи");
});

test("backendStatusHtml: база без пароля и режим сбора видны на экране", () => {
  const plan = bundledPlan({ config: { backend: { databaseUrl: "postgresql+psycopg://fuelradar:s3cret@db.local:5432/fuelradar" } } });
  const html = backendStatusHtml({
    state: STATE.START_FAILED,
    url: plan.apiUrl,
    source: plan.apiSource,
    runtime: { kind: RUNTIME_KIND.BUNDLED, exe: BUNDLED },
    storage: storageSummary(plan),
    collection: collectionSummary(plan),
    checkedAt: "2026-10-06T10:00:00.000Z",
  });
  assert.match(html, /База данных/);
  assert.match(html, /Сбор данных/);
  assert.match(html, /postgresql\+psycopg:\/\/fuelradar:\*\*\*@db\.local:5432\/fuelradar/);
  assert.ok(!html.includes("s3cret"), "пароль внешней базы не должен попадать на экран");
});

test("configTemplate: валидный JSON с найденными путями и подсказками", () => {
  const raw = configTemplate(
    {
      apiUrl: "http://127.0.0.1:8000",
      autostart: true,
      backendDir: BACKEND_DIR,
      python: VENV_PYTHON,
      pythonSource: "виртуальное окружение",
    },
    "0.1.7",
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.apiBaseUrl, "http://127.0.0.1:8000");
  assert.equal(parsed.backend.autostart, true);
  assert.equal(parsed.backend.dir, BACKEND_DIR);
  assert.equal(parsed.backend.python, VENV_PYTHON);
  assert.equal(parsed._appVersion, "0.1.7");
  // Регион наполнения и каталог данных в шаблон не подставляются за человека.
  assert.equal(parsed.backend.seedRegion, "");
  assert.equal(parsed.backend.dataDir, "");

  // Python из PATH в шаблон не пишем: это не найденный путь, а догадка.
  const fallback = JSON.parse(configTemplate({ apiUrl: DEFAULT_API_URL, autostart: true, python: "python", pythonSource: PYTHON_PATH_SOURCE }));
  assert.equal(fallback.backend.python, "");

  // А каталог данных, который человек задал сам, в шаблоне сохраняется.
  const withDataDir = JSON.parse(
    configTemplate({ apiUrl: DEFAULT_API_URL, autostart: true, dataDir: "E:\\data", dataDirSource: "config.json (backend.dataDir)" }),
  );
  assert.equal(withDataDir.backend.dataDir, "E:\\data");

  // Сбор по расписанию и внешняя база: видно, что включено, и есть подсказка,
  // как это поменять; база из окружения в файл не переписывается.
  assert.equal(parsed.backend.collect, true);
  assert.match(parsed.backend.collect_hint, /собирает данные по расписанию/);
  assert.equal(parsed.backend.databaseUrl, "");
  assert.match(parsed.backend.databaseUrl_hint, /postgresql\+psycopg/);

  const withDatabaseUrl = JSON.parse(
    configTemplate({
      apiUrl: DEFAULT_API_URL,
      autostart: true,
      collect: false,
      databaseUrl: "postgresql+psycopg://u:p@h/db",
      databaseSource: "config.json (backend.databaseUrl)",
    }),
  );
  assert.equal(withDatabaseUrl.backend.collect, false);
  assert.equal(withDatabaseUrl.backend.databaseUrl, "postgresql+psycopg://u:p@h/db");
});
