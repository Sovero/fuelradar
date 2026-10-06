"use strict";

/**
 * Backend оболочки: адрес API, автозапуск локального сервера и честный экран,
 * если он не отвечает (R97i — «не настроено/не работает» говорится явно, а не
 * изображается успех).
 *
 * Зачем отдельный модуль: Electron-оболочка сама интерфейс несёт, а backend —
 * внешний процесс. Без него окно показывает сырое «Backend недоступен
 * (ECONNREFUSED)» посреди интерфейса. Здесь собирается всё, чтобы этого не было:
 *   - откуда взят адрес API (переменная окружения / config.json / дефолт);
 *   - можно ли поднять локальный backend и чем именно: встроенным бинарником из
 *     установщика (десктоп-сборка едет с frozen-backend — Python на машине не нужен),
 *     либо venv/PATH в dev-запуске, либо явными путями из config.json;
 *   - каталог данных приложения (SQLite-база и импорт CSV), внешняя база (databaseUrl)
 *     и сбор по расписанию (включённый/выключенный встроенный сборщик);
 *   - живая health-проба (`GET /health`) с честной технической подробностью;
 *   - текст и HTML статус-экрана с кнопками «Повторить» и «Открыть конфиг».
 *
 * Модуль не зависит от Electron: процессы и `fs` передаются снаружи
 * (`exists`, `fetchImpl`), поэтому и разбор плана, и проба покрыты юнит-тестами
 * без сети и без запуска процессов (desktop/tests/backend.test.cjs).
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_API_URL = "http://127.0.0.1:8000";
/** Каталог резервных копий рядом с локальной базой (совпадает с backend: db/transfer.py). */
const BACKUP_DIRNAME = "backups";
const DB_FILENAME = "fuelradar.db";
const DEFAULT_PORT = 8000;
const PROBE_TIMEOUT_MS = 1500;
const STARTUP_TIMEOUT_MS = 60_000;
const BACKEND_MARKER = path.join("app", "main.py");
/** Источник «Python из PATH»: единственный, который не проверяется на диске. */
const PYTHON_PATH_SOURCE = "Python из PATH";

/**
 * Состояния backend для лога, статус-экрана и IPC.
 *
 *   ok           — отвечает (неважно, чей процесс: наш или уже запущенный);
 *   remote       — адрес указывает не на эту машину: автозапуск неприменим;
 *   disabled     — автозапуск выключен настройкой;
 *   no-runtime   — адрес локальный, но каталог backend/Python не найдены;
 *   start-failed — локальный сервер пытались запустить, он не поднялся.
 */
const STATE = {
  OK: "ok",
  REMOTE: "remote",
  DISABLED: "disabled",
  NO_RUNTIME: "no-runtime",
  START_FAILED: "start-failed",
};

/**
 * Чем поднимается локальный backend.
 *
 *   bundled — встроенный в установщик бинарник (frozen PyInstaller): Python на
 *             машине не нужен вообще, это штатный режим собранного приложения;
 *   python  — интерпретатор + каталог backend из репозитория (dev-запуск оболочки).
 */
const RUNTIME_KIND = {
  BUNDLED: "bundled",
  PYTHON: "python",
};

// ---------- разбор адреса ----------

/** `127.0.0.1`, `localhost`, `[::1]` — «локальный» адрес (автозапуск имеет смысл). */
function isLoopbackUrl(raw) {
  try {
    const url = new URL(String(raw));
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** Порт из адреса API (для локального сервера); иначе дефолт. */
function parsePort(raw, fallback = DEFAULT_PORT) {
  try {
    const url = new URL(String(raw));
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return fallback;
  }
}

/** Нормализовать config.json: `{apiBaseUrl, backend: {autostart, dir, python, dataDir, seedRegion, collect, databaseUrl}}`. */
function normalizeConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const backend = config.backend && typeof config.backend === "object" ? config.backend : {};
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    apiBaseUrl: text(config.apiBaseUrl),
    backend: {
      autostart: typeof backend.autostart === "boolean" ? backend.autostart : true,
      dir: text(backend.dir),
      python: text(backend.python),
      dataDir: text(backend.dataDir),
      seedRegion: text(backend.seedRegion),
      collect: typeof backend.collect === "boolean" ? backend.collect : null,
      databaseUrl: text(backend.databaseUrl),
    },
  };
}

const BACKEND_MARKER_FILE = BACKEND_MARKER;

function venvCandidates(baseDir, platform) {
  const relative = platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  return [
    { python: path.join(baseDir, ".venv", ...relative), source: `виртуальное окружение ${path.join(baseDir, ".venv")}` },
    { python: path.join(baseDir, "venv", ...relative), source: `виртуальное окружение ${path.join(baseDir, "venv")}` },
  ];
}

/**
 * План работы с backend: адрес, откуда он взят, нужен ли автозапуск и чем его
 * выполнять. Ничего не делает с процессами — только решает (проверяется тестами).
 *
 * @param {object} options
 * @param {Record<string, string|undefined>} [options.env] переменные окружения
 * @param {unknown} [options.config] разобранный config.json
 * @param {string|null} [options.repoRoot] корень репозитория (dev-запуск)
 * @param {string|null} [options.userDataDir] `app.getPath("userData")`
 * @param {string|null} [options.bundledBackend] путь к встроенному бинарнику backend
 * @param {string} [options.platform]
 * @param {(path: string) => boolean} [options.exists]
 */
function planBackend(options = {}) {
  const {
    env = {},
    config = {},
    repoRoot = null,
    userDataDir = null,
    bundledBackend = null,
    platform = process.platform,
    exists = fs.existsSync,
  } = options;
  const normalized = normalizeConfig(config);

  const envApi = typeof env.FUELRADAR_API_URL === "string" ? env.FUELRADAR_API_URL.trim() : "";
  const apiUrl = envApi || normalized.apiBaseUrl || DEFAULT_API_URL;
  const apiSource = envApi
    ? "переменная окружения FUELRADAR_API_URL"
    : normalized.apiBaseUrl
      ? "config.json (apiBaseUrl)"
      : `значение по умолчанию (${DEFAULT_API_URL})`;

  const autostartEnv = typeof env.FUELRADAR_BACKEND_AUTOSTART === "string" ? env.FUELRADAR_BACKEND_AUTOSTART.trim() : "";
  const autostart =
    autostartEnv !== "" ? !["0", "false", "off", "no"].includes(autostartEnv.toLowerCase()) : normalized.backend.autostart;
  const autostartSource = autostartEnv ? "переменная окружения FUELRADAR_BACKEND_AUTOSTART" : "config.json (backend.autostart)";

  // Каталог данных: SQLite-база, история наблюдений, импорт CSV. В собранном
  // приложении это каталог пользователя, а не Program Files (писать туда нельзя).
  const envDataDir = typeof env.FUELRADAR_DATA_DIR === "string" ? env.FUELRADAR_DATA_DIR.trim() : "";
  const rawDataDir = envDataDir || normalized.backend.dataDir || "";
  const dataDir = rawDataDir
    ? userDataDir && !path.isAbsolute(rawDataDir)
      ? path.resolve(userDataDir, rawDataDir)
      : rawDataDir
    : userDataDir
      ? path.join(userDataDir, "data")
      : null;
  const dataDirSource = envDataDir
    ? "переменная окружения FUELRADAR_DATA_DIR"
    : normalized.backend.dataDir
      ? "config.json (backend.dataDir)"
      : userDataDir
        ? "каталог данных приложения"
        : null;

  // Регион для первого наполнения каталога офлайн-фикстурами (без сети).
  const envSeedRegion = typeof env.FUELRADAR_SEED_REGION === "string" ? env.FUELRADAR_SEED_REGION.trim() : "";
  const seedRegion = envSeedRegion || normalized.backend.seedRegion || null;

  // Внешняя база вместо локальной SQLite. Значение из окружения важнее config.json
  // (и доезжает до процесса backend само), своё значение подставляем только тогда,
  // когда окружение молчит. Пароль наружу (лог, статус-экран) не показываем.
  const envDatabaseUrl = typeof env.DATABASE_URL === "string" ? env.DATABASE_URL.trim() : "";
  const configuredDatabaseUrl = normalized.backend.databaseUrl;
  const databaseUrl = envDatabaseUrl || configuredDatabaseUrl || null;
  const databaseSource = envDatabaseUrl
    ? "переменная окружения DATABASE_URL"
    : configuredDatabaseUrl
      ? "config.json (backend.databaseUrl)"
      : null;
  const databaseUrlEnv = !envDatabaseUrl && configuredDatabaseUrl ? configuredDatabaseUrl : null;

  // Сбор по расписанию. В установленном приложении отдельного воркера нет —
  // расписание ведёт встроенный backend (`COLLECT_IN_PROCESS`), поэтому по
  // умолчанию он включён; config.json (backend.collect) и переменная окружения
  // его выключают. В dev-запуске (python) расписание остаётся за воркером.
  const envCollect = typeof env.COLLECT_IN_PROCESS === "string" ? env.COLLECT_IN_PROCESS.trim() : "";
  const configuredCollect = normalized.backend.collect !== false;
  const collectFromEnv = envCollect ? !["0", "false", "off", "no"].includes(envCollect.toLowerCase()) : null;

  // Каталоги backend — в порядке приоритета: явные настройки, затем «рядом с
  // оболочкой» (dev) и каталог данных приложения.
  const dirCandidates = [];
  const envDir = typeof env.FUELRADAR_BACKEND_DIR === "string" ? env.FUELRADAR_BACKEND_DIR.trim() : "";
  if (envDir) dirCandidates.push({ dir: envDir, source: "переменная окружения FUELRADAR_BACKEND_DIR", explicit: true });
  if (normalized.backend.dir)
    dirCandidates.push({ dir: normalized.backend.dir, source: "config.json (backend.dir)", explicit: true });
  if (repoRoot)
    dirCandidates.push({ dir: path.join(repoRoot, "backend"), source: "каталог репозитория рядом с оболочкой", explicit: false });
  if (userDataDir)
    dirCandidates.push({ dir: path.join(userDataDir, "backend"), source: "каталог данных приложения", explicit: false });

  // Явная настройка — это пин: если она указывает не туда, честно сообщаем, а не
  // подставляем молча другой каталог (R97i — не изображать работу).
  const explicitDir = dirCandidates.find((candidate) => candidate.explicit) ?? null;
  const explicitDirValid = Boolean(explicitDir && exists(path.join(explicitDir.dir, BACKEND_MARKER)));
  const implicitDir = dirCandidates.find((candidate) => exists(path.join(candidate.dir, BACKEND_MARKER))) ?? null;
  const resolvedDir = explicitDir ? (explicitDirValid ? explicitDir : null) : implicitDir;
  const explicitDirMissing = explicitDir && !explicitDirValid ? explicitDir : null;

  const pythonCandidates = [];
  const envPython = typeof env.FUELRADAR_PYTHON === "string" ? env.FUELRADAR_PYTHON.trim() : "";
  if (envPython) pythonCandidates.push({ python: envPython, source: "переменная окружения FUELRADAR_PYTHON", explicit: true });
  if (normalized.backend.python)
    pythonCandidates.push({ python: normalized.backend.python, source: "config.json (backend.python)", explicit: true });
  if (resolvedDir) {
    pythonCandidates.push(...venvCandidates(resolvedDir.dir, platform));
    // venv может лежать в корне репозитория, а не в backend/ (например, `.venv`).
    pythonCandidates.push(...venvCandidates(path.dirname(resolvedDir.dir), platform));
  }
  pythonCandidates.push({ python: platform === "win32" ? "python" : "python3", source: PYTHON_PATH_SOURCE, explicit: false });

  // Явный Python: путь проверяем на диске, голое имя команды — доверяем PATH
  // (но main.cjs всё равно убедится, что она запускается).
  const explicitPython = pythonCandidates.find((candidate) => candidate.explicit) ?? null;
  const explicitPythonIsPath = Boolean(explicitPython && /[\\/]/.test(explicitPython.python));
  const explicitPythonUsable = Boolean(explicitPython && (!explicitPythonIsPath || exists(explicitPython.python)));
  const explicitPythonMissing = explicitPython && !explicitPythonUsable ? explicitPython : null;
  const foundPython = explicitPython
    ? explicitPythonUsable
      ? explicitPython
      : null
    : (pythonCandidates.find((candidate) => candidate.source === PYTHON_PATH_SOURCE || exists(candidate.python)) ?? null);
  const python = foundPython?.python ?? null;

  // Встроенный backend из установщика: он предпочтительнее venv/PATH, потому что
  // в собранном приложении Python на машине может не быть вообще. Явные пути из
  // config.json (backend.dir/backend.python) — это пин для отладки: если он задан,
  // уважаем его, а не молча подменяем встроенным (R97i).
  const bundledPath = bundledBackend ? String(bundledBackend) : null;
  const useBundled = Boolean(bundledPath && exists(bundledPath) && !explicitDir && !explicitPython);
  const collect = useBundled ? (collectFromEnv ?? configuredCollect) : null;
  const collectSource = !useBundled
    ? null
    : envCollect
      ? "переменная окружения COLLECT_IN_PROCESS"
      : configuredCollect
        ? normalized.backend.collect === true
          ? "config.json (backend.collect)"
          : "по умолчанию"
        : "config.json (backend.collect = false)";
  // Что добавить в окружение дочернего процесса: своё значение — только если
  // окружение молчит (иначе перетёрли бы явную настройку оператора).
  const collectEnv = useBundled && !envCollect ? (configuredCollect ? "1" : "0") : null;

  return {
    apiUrl,
    apiSource,
    port: parsePort(apiUrl, DEFAULT_PORT),
    isLoopback: isLoopbackUrl(apiUrl),
    autostart,
    autostartSource,
    runtimeKind: useBundled ? RUNTIME_KIND.BUNDLED : python ? RUNTIME_KIND.PYTHON : null,
    bundledExe: useBundled ? bundledPath : null,
    bundledPath,
    dataDir,
    dataDirSource,
    seedRegion,
    collect,
    collectSource,
    collectEnv,
    databaseUrl,
    databaseUrlEnv,
    databaseSource,
    backendDir: resolvedDir?.dir ?? null,
    backendDirSource: resolvedDir?.source ?? null,
    backendDirCandidates: dirCandidates.map((candidate) => candidate.dir),
    explicitDirMissing,
    python,
    pythonSource: foundPython?.source ?? null,
    pythonFromPath: Boolean(python && !/[\\/]/.test(python)),
    explicitPythonMissing,
  };
}

// ---------- проба и запуск ----------

/** Локальный файл базы: если настроена внешняя база, локальная остаётся лишь
 * источником переноса — она может быть устаревшей, и панель говорит об этом прямо. */
function localDatabaseFile(plan) {
  return plan?.dataDir ? path.join(plan.dataDir, DB_FILENAME) : null;
}

/** Каталог резервных копий (null — нет каталога данных). */
function backupDir(plan) {
  return plan?.dataDir ? path.join(plan.dataDir, BACKUP_DIRNAME) : null;
}

/** Имя копии по UTC-штампу: fuelradar-YYYYMMDD-HHMMSS.db — как в backend. */
function backupFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `fuelradar-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.db`
  );
}

/** Путь копии по умолчанию — в каталог данных, подкаталог backups (null без него). */
function defaultBackupPath(plan, date = new Date()) {
  const dir = backupDir(plan);
  return dir ? path.join(dir, backupFileName(date)) : null;
}

/**
 * Служебная команда обслуживания базы — тот же backend, но в режиме «сделал и вышел»:
 *
 *   backup  — `--backup-db [PATH]`: консистентный снимок локальной SQLite;
 *   migrate — `--migrate-db --to-database-url URL`: перенос локальных данных
 *             во внешнюю (Postgres) базу — адрес берётся из config.json
 *             (backend.databaseUrl) и передаётся аргументом, чтобы не зависеть
 *             от переменных окружения.
 *
 * Встроенный бинарник — штатный режим собранного приложения; в dev-запуске тот же
 * модуль есть в каталоге backend (`backend/desktop_server.py`), поэтому панель
 * проверяется и без установщика. Нет ни того, ни другого — честное «нечем».
 *
 * @returns {{kind: string, command: string, args: string[], cwd: string|null}|null}
 */
function maintenanceCommand(plan, action, options = {}) {
  const args = [];
  if (plan?.dataDir) args.push("--data-dir", plan.dataDir);
  if (action === "backup") {
    args.push("--backup-db");
    if (options.destination) args.push(options.destination);
  } else if (action === "migrate") {
    args.push("--migrate-db");
    if (options.target) args.push("--to-database-url", options.target);
  } else {
    return null;
  }
  if (plan?.bundledExe) {
    return {
      kind: RUNTIME_KIND.BUNDLED,
      command: plan.bundledExe,
      args,
      cwd: plan.dataDir ?? path.dirname(plan.bundledExe),
    };
  }
  if (plan?.python && plan?.backendDir) {
    return {
      kind: RUNTIME_KIND.PYTHON,
      command: plan.python,
      args: [path.join(plan.backendDir, "desktop_server.py"), ...args],
      cwd: plan.backendDir,
    };
  }
  return null;
}

/**
 * Разобрать ответ служебной команды: backend печатает одну строку JSON в stdout
 * (ASCII-экранирование, см. db/transfer.py::json_line), но рядом могут быть и
 * обычные строки логов — берём последнюю разобранную.
 */
function parseMaintenanceReport(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object" && ("ok" in parsed || "kind" in parsed)) return parsed;
    } catch {
      // Не наш вывод — ищем дальше вверх по строке (или честно вернём null).
    }
  }
  return null;
}

/**
 * Сводка для панели «Данные»: где лежит локальная база, есть ли внешняя и
 * доступны ли действия. `fileInfo` приходит из main.cjs (fs.statSync) — модуль
 * остаётся без зависимости от Electron и проверяется юнит-тестами.
 */
function databaseStatus(plan, fileInfo = null) {
  const support = {
    supported: Boolean(plan?.bundledExe || (plan?.python && plan?.backendDir)),
    reason: null,
  };
  if (!support.supported) {
    support.reason = "нет ни встроенного backend (resources/backend), ни каталога backend с интерпретатором Python — нечем снимать копию";
  }
  return {
    ...support,
    external: Boolean(plan?.databaseUrl),
    externalUrl: plan?.databaseUrl ? maskDatabaseUrl(plan.databaseUrl) : null,
    externalSource: plan?.databaseSource ?? null,
    dataDir: plan?.dataDir ?? null,
    localFile: localDatabaseFile(plan),
    localExists: Boolean(fileInfo?.exists),
    localBytes: fileInfo?.bytes ?? null,
    localModifiedAt: fileInfo?.modifiedAt ?? null,
    backupDir: backupDir(plan),
    // Перенос во внешнюю базу возможен, только когда эта база настроена
    // (backend.databaseUrl) — иначе честное «не настроено» с подсказкой.
    migrationSupported: Boolean(plan?.databaseUrl),
  };
}

/**
 * Строка подключения к внешней базе без пароля — для лога и статус-экрана (R68:
 * секреты не показываем). Разбор — регуляркой: URL-парсер не обязан понимать
 * диалект SQLAlchemy (`postgresql+psycopg://`), а пароль прятать нужно всегда.
 */
function maskDatabaseUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  return text.replace(/(:\/\/[^:@/]+):[^@/]*@/, "$1:***@");
}

/** Локальная SQLite или внешняя база — одной строкой для лога и статус-экрана. */
function storageSummary(plan) {
  if (plan?.databaseUrl) {
    return `внешняя база: ${maskDatabaseUrl(plan.databaseUrl)} (${plan.databaseSource ?? "настройка"})`;
  }
  return "локальная SQLite в каталоге данных";
}

/** Чем идёт сбор данных: встроенный тикер сбора или отдельный воркер. */
function collectionSummary(plan) {
  if (plan?.collect === true) {
    return `включён: встроенный backend собирает сам (${plan.collectSource ?? "по умолчанию"})`;
  }
  if (plan?.collect === false) {
    return `выключен (${plan.collectSource ?? "настройка"})`;
  }
  return "ведёт отдельный воркер (python -m app.worker)";
}

/**
 * Переменные для дочернего процесса backend: каталог данных, внешняя база, режим
 * сбора. Возвращает только то, что оболочка добавляет сама (`extra` — приоритетнее:
 * им, например, smoke-прогон гасит сбор, чтобы не ходить в сеть).
 */
function backendEnv(plan, extra = {}) {
  const env = { ...extra };
  if (plan?.collectEnv && env.COLLECT_IN_PROCESS === undefined) env.COLLECT_IN_PROCESS = plan.collectEnv;
  if (plan?.databaseUrlEnv && env.DATABASE_URL === undefined) env.DATABASE_URL = plan.databaseUrlEnv;
  return env;
}

/** Человекочитаемая причина сетевой ошибки (без стектрейсов). */
function describeFetchError(error, timeoutMs) {
  const name = String(error?.name ?? "");
  if (name === "TimeoutError" || name === "AbortError") return `таймаут ${timeoutMs} мс`;
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  if (code) return String(code);
  return String(cause?.message ?? error?.message ?? error);
}

/**
 * `GET {apiUrl}/health`: отвечает ли backend.
 *
 * @returns {Promise<{ok: boolean, detail: string|null}>}
 */
async function probeHealth(options = {}) {
  const { url, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = options;
  const target = `${String(url).replace(/\/+$/, "")}/health`;
  try {
    const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} на /health` };
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (body && typeof body.status === "string" && body.status !== "ok") {
      return { ok: false, detail: `/health ответил status: ${body.status}` };
    }
    return { ok: true, detail: null };
  } catch (error) {
    return { ok: false, detail: describeFetchError(error, timeoutMs) };
  }
}

/** Команда запуска локального backend из репозитория (тот же процесс, что `make dev`). */
function startArgs(port) {
  return ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)];
}

/**
 * Чем и как запускать локальный backend (что именно выбрал `planBackend`).
 *
 * Встроенный бинарник — самостоятельный процесс со своим `main`
 * (backend/desktop_server.py): адрес, порт и каталог данных он принимает
 * аргументами, Python и venv ему не нужны.
 *
 * @returns {{kind: string, command: string, args: string[]}|null}
 */
function runtimeCommand(plan) {
  if (plan?.bundledExe) {
    const args = ["--host", "127.0.0.1", "--port", String(plan.port)];
    if (plan.dataDir) args.push("--data-dir", plan.dataDir);
    // Регион пилота: из него наполняется каталог и по нему идёт сбор по
    // расписанию (встроенный backend выставляет DEFAULT_REGION_CITY).
    if (plan.seedRegion) args.push("--region", plan.seedRegion);
    return { kind: RUNTIME_KIND.BUNDLED, command: plan.bundledExe, args };
  }
  if (plan?.python) {
    return { kind: RUNTIME_KIND.PYTHON, command: plan.python, args: startArgs(plan.port) };
  }
  return null;
}

// ---------- тексты и статус-экран ----------

const TEXTS = {
  [STATE.OK]: {
    title: "Backend отвечает",
    message: "Соединение с сервером есть.",
    hint: "",
  },
  [STATE.REMOTE]: {
    title: "Backend не отвечает",
    message: "Адрес API указывает не на эту машину — запускать локальный сервер здесь нечего.",
    hint: "Проверьте адрес и доступность сервера, либо укажите http://127.0.0.1:8000 в config.json.",
  },
  [STATE.DISABLED]: {
    title: "Backend не отвечает",
    message: "Автозапуск локального backend выключен настройкой.",
    hint: "Верните backend.autostart = true в config.json (или уберите FUELRADAR_BACKEND_AUTOSTART), либо запустите сервер вручную.",
  },
  [STATE.NO_RUNTIME]: {
    title: "Backend не отвечает — и поднять его нечем",
    message: "Адрес локальный, но оболочка не нашла ни встроенный backend (resources/backend), ни рабочий каталог backend (с app/main.py) с интерпретатором Python.",
    hint: "Переустановите приложение (встроенный backend мог не распаковаться), либо укажите пути в config.json (backend.dir и backend.python) или переменными FUELRADAR_BACKEND_DIR и FUELRADAR_PYTHON — либо запустите backend вручную.",
  },
  [STATE.START_FAILED]: {
    title: "Backend не удалось запустить",
    message: "Оболочка сама подняла локальный сервер, но он не ответил за отведённое время.",
    hint: "Смотрите вывод процесса ниже: обычно это неустановленные зависимости (pip install -r requirements.txt в каталоге backend) или занятый порт.",
  },
};

/** Заголовок, пояснение и подсказка для состояния (единый источник для лога и экрана). */
function describeState(state) {
  return TEXTS[state] ?? TEXTS[STATE.START_FAILED];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function row(label, value, extraClass = "") {
  const text = value === null || value === undefined || value === "" ? "—" : value;
  return `<dt>${escapeHtml(label)}</dt><dd class="${extraClass}">${escapeHtml(text)}</dd>`;
}

/**
 * Чем поднимается локальный backend — одной строкой для лога и статус-экрана.
 * Встроенный бинарник называется явно: это и есть ответ на «почему работает без Python».
 */
function runtimeSummary(status) {
  const runtime = status?.runtime ?? null;
  if (!runtime) return null;
  if (runtime.kind === RUNTIME_KIND.BUNDLED && runtime.exe) return `встроенный backend: ${runtime.exe}`;
  return [
    runtime.dir ? `каталог: ${runtime.dir}${runtime.dirSource ? ` (${runtime.dirSource})` : ""}` : "каталог: не найден",
    runtime.python ? `Python: ${runtime.python}${runtime.pythonSource ? ` (${runtime.pythonSource})` : ""}` : "Python: не найден",
  ].join("; ");
}

/**
 * HTML статус-экрана: окно показывает его вместо интерфейса, пока backend не
 * отвечает. Кнопки работают через IPC-мост оболочки (`fuelradarDesktop.backend`),
 * поэтому в браузере кнопка «Повторить» просто перезагружает страницу.
 */
function backendStatusHtml(status) {
  const text = describeState(status?.state);
  const runtimeText = runtimeSummary(status) ?? "не найден";
  const searched = Array.isArray(status?.searched) && status.searched.length ? status.searched.join(" · ") : null;
  const errors = [status?.detail, status?.processOutput].filter(Boolean).join("\n");
  const resultLabel = status?.ok ? "Проверка связи" : "Что делать";
  const hint = status?.ok ? "" : text.hint;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>FuelRadar — backend не отвечает</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 32px 20px;
    display: flex; align-items: center; justify-content: center;
    background: #0f172a; color: #e2e8f0;
    font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  main { width: 100%; max-width: 720px; }
  h1 { margin: 0 0 20px; font-size: 18px; letter-spacing: .08em; text-transform: uppercase; color: #34d399; }
  .state { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
  .message { margin: 0 0 20px; color: #94a3b8; }
  dl {
    display: grid; grid-template-columns: 190px 1fr; gap: 8px 16px;
    margin: 0 0 20px; padding: 16px; border: 1px solid #1e293b; border-radius: 12px; background: #111c33;
  }
  dt { color: #64748b; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .mono { font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px; white-space: pre-wrap; }
  .hint { margin: 0 0 20px; padding: 12px 16px; border-left: 3px solid #f59e0b; background: #1c1917; color: #fcd34d; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; }
  button {
    padding: 10px 18px; border: 0; border-radius: 8px; background: #059669; color: #fff;
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button.secondary { background: #1e293b; color: #cbd5e1; }
  button:disabled { opacity: .55; cursor: default; }
  .result { min-height: 1.5em; margin: 14px 0 0; color: #94a3b8; }
  .footer { margin: 18px 0 0; color: #475569; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>FuelRadar</h1>
  <p class="state">${escapeHtml(text.title)}</p>
  <p class="message">${escapeHtml(text.message)}</p>
  <dl>
    ${row("Адрес API", status?.url)}
    ${row("Откуда взят адрес", status?.source)}
    ${row("Локальный backend", runtimeText)}
    ${row("Встроенный backend", status?.bundledPath)}
    ${row("Где искали", searched)}
    ${row("Каталог данных", status?.dataDir)}
    ${row("База данных", status?.storage)}
    ${row("Сбор данных", status?.collection)}
    ${row("Попытка запуска", status?.attempt)}
    ${row("Техническая подробность", errors, "mono")}
    ${row("Проверено", status?.checkedAt)}
  </dl>
  ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}
  <div class="actions">
    <button id="retry" type="button">Повторить</button>
    <button id="open-config" class="secondary" type="button">Открыть конфиг</button>
  </div>
  <p class="result" id="result">${escapeHtml(resultLabel)}</p>
  <p class="footer">Адрес API и автозапуск backend задаются в config.json (${escapeHtml(status?.configPath ?? "")}) или переменными окружения FUELRADAR_API_URL / FUELRADAR_DATA_DIR / FUELRADAR_BACKEND_DIR / FUELRADAR_PYTHON.</p>
</main>
<script>
  const bridge = window.fuelradarDesktop && window.fuelradarDesktop.backend;
  const retry = document.getElementById("retry");
  const openConfig = document.getElementById("open-config");
  const result = document.getElementById("result");
  if (!bridge) openConfig.hidden = true;

  function busy(flag) {
    retry.disabled = flag;
    openConfig.disabled = flag;
  }

  async function runRetry(auto) {
    if (!bridge) { if (!auto) location.reload(); return; }
    busy(true);
    result.textContent = "Проверяем backend…";
    try {
      const status = await bridge.retry();
      if (status && status.ok) { result.textContent = "Backend отвечает — открываем интерфейс…"; return; }
      const reason = (status && (status.detail || status.state)) || "нет ответа";
      result.textContent = auto ? \`Проверка: не получилось — \${reason}\` : \`Не получилось: \${reason}. Обновляем состояние…\`;
    } catch (error) {
      result.textContent = \`Не получилось: \${error && error.message ? error.message : error}\`;
    }
    busy(false);
    // Ручная проверка перерисовывает экран сервером — с уже новым состоянием и
    // подробностью; автоматическая (после перезагрузки) только сообщает результат,
    // иначе получился бы цикл перезагрузок.
    if (!auto) setTimeout(() => location.reload(), 900);
  }

  retry.addEventListener("click", () => runRetry(false));
  // Перезагрузка страницы после того, как backend подняли вручную, тоже должна
  // вылечивать окно, а не показывать вчерашнее состояние.
  if (bridge) runRetry(true);

  openConfig.addEventListener("click", async () => {
    if (!bridge) return;
    busy(true);
    try {
      const opened = await bridge.openConfig();
      result.textContent = opened && opened.ok
        ? \`Открыт конфиг: \${opened.path}\`
        : \`Не удалось открыть конфиг: \${(opened && opened.error) || "неизвестная ошибка"}\`;
    } catch (error) {
      result.textContent = \`Не удалось открыть конфиг: \${error && error.message ? error.message : error}\`;
    }
    busy(false);
  });
</script>
</body>
</html>`;
}

/** Шаблон config.json (создаётся кнопкой «Открыть конфиг», если файла ещё нет). */
function configTemplate(plan, currentVersion = null) {
  const payload = {
    apiBaseUrl: plan?.apiUrl ?? DEFAULT_API_URL,
    apiBaseUrl_hint: "Адрес backend-сервера: локальный (http://127.0.0.1:8000) или удалённый (https://api.example.com).",
    backend: {
      autostart: plan?.autostart ?? true,
      autostart_hint: "true — оболочка сама поднимает локальный backend, если он не отвечает.",
      dir: plan?.backendDir ?? "",
      dir_hint: "Каталог backend (в нём лежит app/main.py). Только для отладки: по умолчанию используется встроенный backend.",
      python: plan?.python && plan?.pythonSource !== PYTHON_PATH_SOURCE ? plan.python : "",
      python_hint: "Интерпретатор Python с зависимостями backend. Только для отладки (встроенному не нужен).",
      dataDir: plan?.dataDir && plan?.dataDirSource === "config.json (backend.dataDir)" ? plan.dataDir : "",
      dataDir_hint: "Каталог данных (база SQLite, история, импорт CSV). Пусто — каталог данных приложения.",
      seedRegion: plan?.seedRegion ?? "",
      seedRegion_hint:
        "Регион пилота (ключ из cli/regions.py, например krasnodar): им наполняется каталог демо-данными на первом запуске и по нему же идёт сбор по расписанию. Пусто — каталог не наполняется, сбор не запускается.",
      collect: plan?.collect ?? true,
      collect_hint:
        "Действует для встроенного backend: true — он сам собирает данные по расписанию (фоновый цикл под тем же локом, что и воркер), false — сбор не идёт.",
      databaseUrl: plan?.databaseSource === "config.json (backend.databaseUrl)" ? plan.databaseUrl : "",
      databaseUrl_hint:
        "Внешняя база вместо локальной SQLite, например postgresql+psycopg://user:пароль@host:5432/fuelradar. Пусто — локальная база в каталоге данных.",
    },
  };
  if (currentVersion) payload._appVersion = currentVersion;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

module.exports = {
  BACKEND_MARKER,
  BACKUP_DIRNAME,
  DB_FILENAME,
  DEFAULT_API_URL,
  PROBE_TIMEOUT_MS,
  PYTHON_PATH_SOURCE,
  RUNTIME_KIND,
  STARTUP_TIMEOUT_MS,
  STATE,
  backendEnv,
  backendStatusHtml,
  backupDir,
  backupFileName,
  collectionSummary,
  configTemplate,
  databaseStatus,
  defaultBackupPath,
  describeFetchError,
  describeState,
  escapeHtml,
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
};
