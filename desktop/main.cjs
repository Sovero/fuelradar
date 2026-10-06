"use strict";

/**
 * FuelRadar Desktop (Electron-оболочка).
 *
 * Архитектура: приложение встраивает production-сборку Next.js
 * (frontend, `NEXT_OUTPUT=standalone`, собирается `desktop/scripts/prepare-server.mjs`)
 * и запускает её встроенным в Electron Node (`ELECTRON_RUN_AS_NODE=1`) на свободном
 * 127.0.0.1-порту. Окно грузит только этот локальный адрес; внешние переходы —
 * в системный браузер. Cookie-сессия (JWT httpOnly) персистит в профиле
 * пользователя — вход живёт между перезапусками.
 *
 * Telegram (R66/R97i): официальный Login Widget грузится с telegram.org и
 * открывает popup oauth.telegram.org — такие попапы разрешены как дочерние
 * окна (иначе вход ломается), остальные внешние ссылки — в системный браузер,
 * `tg://` — в Telegram-клиент пользователя.
 *
 * Автообновление: electron-updater (NSIS, github-провайдер → Releases
 * приватного репозитория). Каждый запрос фида подписывается токеном из
 * resources/update-feed-token (посылается сборщиком, см. desktop/README.md);
 * без токена автообновление в сборке честно отключено. В dev-режиме проверка
 * обновлений честно не выполняется.
 *
 * Backend (R97i): данные приходят с API. Если адрес локальный и backend не
 * отвечает, оболочка сама поднимает его и ждёт готовности. Штатный режим
 * собранного приложения — ВСТРОЕННЫЙ backend: установщик несёт замороженный
 * бинарник (scripts/prepare-backend.mjs → resources/backend), поэтому Python и
 * venv на машине пилота не нужны; база SQLite живёт в каталоге данных
 * пользователя, а не в Program Files. В dev-режиме тот же план откатывается на
 * `python -m uvicorn app.main:app` (интерпретатор и каталог — из config.json,
 * переменных окружения или venv рядом). Не поднялся/не найден — вместо
 * интерфейса показывается честный статус-экран с адресом, причиной,
 * технической подробностью и кнопками «Повторить»/«Открыть конфиг»
 * (desktop/backend.cjs).
 */

const { app, BrowserWindow, Menu, Notification, shell, dialog, ipcMain, session } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { parseFeedConfig, probeFeed } = require("./feed-status.cjs");
const {
  PROBE_TIMEOUT_MS,
  RUNTIME_KIND,
  STARTUP_TIMEOUT_MS,
  STATE: BACKEND_STATE,
  backendEnv,
  backendStatusHtml,
  backupDir,
  collectionSummary,
  configTemplate,
  databaseStatus,
  defaultBackupPath,
  describeState,
  localDatabaseFile,
  maintenanceCommand,
  parseMaintenanceReport,
  planBackend,
  probeHealth,
  runtimeCommand,
  runtimeSummary,
  storageSummary,
} = require("./backend.cjs");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const SMOKE = process.env.FUELRADAR_SMOKE === "1";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 часа
/** Путь статус-экрана backend (отдаёт прокси, пока backend не отвечает). */
const BACKEND_STATUS_PATH = "/__fuelradar/backend";
/** Имя бинарника встроенного backend (совпадает с `--name` в prepare-backend.mjs). */
const BUNDLED_BACKEND_NAME = process.platform === "win32" ? "fuelradar-backend.exe" : "fuelradar-backend";

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import("node:child_process").ChildProcess | null} */
let serverProcess = null;
/** @type {import("node:child_process").ChildProcess | null} */
let backendProcess = null;
/** @type {import("node:http").Server | null} */
let proxyServer = null;
let quitting = false;
/** Публичный адрес окна (локальный прокси) — нужен IPC «Повторить». */
let publicBase = null;
/** План работы с backend (адрес, автозапуск, пути) — считается при старте. */
let apiConfig = null;
/** Последнее известное состояние backend (статус-экран и IPC). */
let backendStatus = { state: "unknown", ok: false };
/** Последние строки вывода запущенного нами backend — для технической подробности. */
let backendLog = [];
let backendExit = null;
/** Одноразовая попытка наполнить каталог демо-данными (первый запуск). */
let seedAttempted = false;
/** Временный каталог данных smoke-прогона (удаляется при выходе). */
let smokeDataDir = null;

// ---------- API-адрес и backend (data, не код — R04/R81) ----------

function desktopConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

/**
 * Путь к встроенному backend: `resources/backend` в собранном приложении,
 * `desktop/backend-dist` в dev-запуске (там его оставляет `npm run prepare:backend`).
 * Существование проверяет `planBackend` — путь остаётся подсказкой для экрана.
 */
function bundledBackendPath() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "backend")
    : path.join(__dirname, "backend-dist", "fuelradar-backend");
  return path.join(base, BUNDLED_BACKEND_NAME);
}

/**
 * Smoke-прогон герметичен: данные пишутся в временный каталог, а не в профиль
 * пользователя — иначе прогон агента/CI портил бы счётчики и базу реального
 * оператора. Каталог удаляется при выходе (диагностика — первым делом).
 */
function prepareSmokeDataDir() {
  if (!SMOKE) return null;
  if (!smokeDataDir) {
    smokeDataDir = fs.mkdtempSync(path.join(app.getPath("temp"), "fuelradar-smoke-"));
  }
  return smokeDataDir;
}

/**
 * Дождаться завершения процесса backend (best effort).
 *
 * Нужно перед удалением временного каталога данных: пока процесс жив, Windows
 * держит и SQLite-файл, и сам каталог (он же его рабочий каталог) — удаление
 * падало бы с EBUSY.
 */
function waitForChildExit(child, timeoutMs = 5000) {
  if (!child) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Убрать временный каталог smoke-прогона (best effort: он всего лишь временный). */
function cleanupSmokeDataDir() {
  if (!smokeDataDir) return;
  const target = smokeDataDir;
  smokeDataDir = null;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    console.warn(`[smoke] временный каталог данных не удалён: ${target}`);
  }
}

/** config.json из каталога данных; ошибка разбора не скрывается (R97i). */
function readDesktopConfig() {
  const configPath = desktopConfigPath();
  try {
    return { raw: JSON.parse(fs.readFileSync(configPath, "utf8")), path: configPath, error: null };
  } catch (error) {
    const code = error?.code;
    return { raw: {}, path: configPath, error: code === "ENOENT" ? null : String(error?.message ?? error) };
  }
}

/**
 * Что smoke-прогон переопределяет у backend.
 *
 * Прогон герметичен: данные уходят во временный каталог, а сбор по расписанию
 * гасится — иначе проверка зависела бы от сети и доступности источников.
 * Одно место для обоих потребителей (план и окружение дочернего процесса),
 * иначе экран говорил бы «сбор включён», пока прогон его выключает.
 */
function smokeEnvOverrides() {
  return SMOKE ? { COLLECT_IN_PROCESS: "0" } : {};
}

/**
 * План: адрес API (env → config.json → дефолт), автозапуск и чем запускать
 * локальный backend. Решение принимает чистый `planBackend` (desktop/backend.cjs).
 */
function resolveApiConfig() {
  // Smoke-прогон не читает config.json оператора (иначе результат зависел бы от
  // того, что у него настроено) и уводит данные во временный каталог.
  const configFile = SMOKE
    ? { raw: {}, path: desktopConfigPath(), error: null }
    : readDesktopConfig();
  const repoRoot = app.isPackaged ? null : path.resolve(__dirname, "..");
  const env = SMOKE
    ? { ...process.env, FUELRADAR_DATA_DIR: prepareSmokeDataDir(), ...smokeEnvOverrides() }
    : process.env;
  return {
    ...planBackend({
      env,
      config: configFile.raw,
      repoRoot,
      userDataDir: app.getPath("userData"),
      platform: process.platform,
      bundledBackend: bundledBackendPath(),
    }),
    configPath: configFile.path,
    configError: configFile.error,
  };
}

function runtimeInfo() {
  if (!apiConfig) return null;
  return {
    kind: apiConfig.runtimeKind,
    exe: apiConfig.bundledExe,
    dir: apiConfig.backendDir,
    dirSource: apiConfig.backendDirSource,
    python: apiConfig.python,
    pythonSource: apiConfig.pythonSource,
  };
}

function buildBackendStatus(state, extra = {}) {
  return {
    state,
    ok: state === BACKEND_STATE.OK,
    url: apiConfig?.apiUrl ?? null,
    source: apiConfig?.apiSource ?? null,
    autostart: Boolean(apiConfig?.autostart),
    autostartSource: apiConfig?.autostartSource ?? null,
    runtime: runtimeInfo(),
    searched: apiConfig?.backendDirCandidates ?? [],
    bundledPath: apiConfig?.bundledPath ?? null,
    dataDir: apiConfig?.dataDir ?? null,
    // Внешняя база (без пароля) и режим сбора — то, что видит оператор на экране
    // и в логе: «почему данные не обновляются» — это состояние, а не догадка.
    storage: apiConfig ? storageSummary(apiConfig) : null,
    collection: apiConfig ? collectionSummary(apiConfig) : null,
    configPath: apiConfig?.configPath ?? null,
    attempt: extra.attempt ?? null,
    detail: extra.detail ?? apiConfig?.configError ?? null,
    processOutput: extra.processOutput ?? null,
    managed: Boolean(extra.managed),
    checkedAt: new Date().toISOString(),
  };
}

function logBackendStatus(status) {
  const text = describeState(status.state);
  const parts = [`[backend] ${status.state} — ${text.title}: ${status.url}`, `адрес: ${status.source}`];
  const runtime = runtimeSummary(status);
  if (runtime) parts.push(runtime);
  if (status.dataDir) parts.push(`данные: ${status.dataDir}`);
  if (status.storage) parts.push(`база: ${status.storage}`);
  if (status.collection) parts.push(`сбор: ${status.collection}`);
  if (status.attempt) parts.push(status.attempt);
  if (status.detail) parts.push(status.detail);
  console.log(parts.join(" | "));
}

/** Последние строки вывода backend (хвост, чтобы подробность не разрасталась). */
function backendOutput(maxLines = 12) {
  const tail = backendLog.slice(-maxLines).join("\n").trim();
  return tail || null;
}

function rememberBackendOutput(chunk) {
  const text = String(chunk ?? "").trimEnd();
  if (!text) return;
  backendLog = [...backendLog, ...text.split(/\r?\n/)].slice(-40);
}

/** Каталог данных (база SQLite, импорт CSV) — создаём до запуска сервера. */
function ensureDataDir() {
  if (!apiConfig?.dataDir) return null;
  try {
    fs.mkdirSync(apiConfig.dataDir, { recursive: true });
  } catch (error) {
    console.warn(`[backend] не удалось создать каталог данных ${apiConfig.dataDir}: ${error?.message ?? error}`);
    return null;
  }
  return apiConfig.dataDir;
}

/**
 * Первый запуск: наполнить каталог демо-данными из офлайн-фикстур (без сети).
 *
 * В собранном приложении каталог стартует пустым, и это честно, но пустая карта
 * мало о чём говорит. Поэтому если базы ещё нет и задан регион (`backend.seedRegion`
 * или `FUELRADAR_SEED_REGION`), один раз запускаем встроенный же бинарник в режиме
 * `--seed-offline` — он пишет в тот же файл, что потом поднимет сервер.
 *
 * Существующую базу не трогаем никогда (история наблюдений не перезаписывается,
 * R17 в миниатюре), ошибка наполнения — не повод не запускать приложение.
 * Во внешнюю базу (backend.databaseUrl) демо-фикстуры не пишем вообще: это может
 * быть общая база пилота, и подмешивать в неё демо-АЗС нельзя.
 */
function maybeSeedDemoData() {
  if (seedAttempted) return;
  if (!apiConfig?.bundledExe) return; // dev-режим наполняется привычно: `make seed`
  if (apiConfig.databaseUrl) {
    console.log(`[backend] демо-данные: настроена внешняя база (${apiConfig.databaseSource}) — офлайн-наполнение пропущено`);
    return;
  }
  if (!apiConfig.seedRegion) {
    console.log("[backend] демо-данные: регион не задан (backend.seedRegion) — каталог остаётся пустым");
    return;
  }
  const dbFile = apiConfig.dataDir ? path.join(apiConfig.dataDir, "fuelradar.db") : null;
  if (dbFile && fs.existsSync(dbFile)) return; // данные уже есть
  seedAttempted = true;
  const args = ["--seed-offline", "--region", apiConfig.seedRegion];
  if (apiConfig.dataDir) args.push("--data-dir", apiConfig.dataDir);
  console.log(`[backend] первый запуск: наполняем каталог демо-данными (${apiConfig.seedRegion})`);
  const result = spawnSync(apiConfig.bundledExe, args, {
    cwd: apiConfig.dataDir ?? path.dirname(apiConfig.bundledExe),
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  rememberBackendOutput(output);
  if (result.error) {
    console.warn(`[backend] демо-данные: не удалось запустить наполнение — ${result.error.message}`);
  } else if (result.status !== 0) {
    console.warn(`[backend] демо-данные: наполнение завершилось кодом ${result.status} (каталог остаётся как есть)`);
  } else {
    const last = output.trim().split(/\r?\n/).slice(-3).join(" | ");
    console.log(`[backend] демо-данные: ${last || "готово"}`);
  }
}

/**
 * Запустить локальный backend тем способом, который выбрал план: встроенный
 * бинарник установщика либо `python -m uvicorn app.main:app` в dev-режиме
 * (`desktop/backend.cjs::runtimeCommand`).
 */
function startBackend() {
  backendLog = [];
  backendExit = null;
  const runtime = runtimeCommand(apiConfig);
  if (!runtime) throw new Error("нечего запускать: нет ни встроенного backend, ни интерпретатора Python");
  const isBundled = runtime.kind === RUNTIME_KIND.BUNDLED;
  if (isBundled) ensureDataDir();
  console.log(`[backend] команда: ${runtime.command} ${runtime.args.join(" ")}`);
  backendProcess = spawn(runtime.command, runtime.args, {
    // Встроенному бинарнику рабочий каталог не нужен (все пути он получает
    // аргументами), но каталог данных уместнее каталога установки.
    cwd: isBundled ? (apiConfig.dataDir ?? path.dirname(runtime.command)) : apiConfig.backendDir,
    // Встроенному backend оболочка передаёт ещё и режим сбора (smoke-прогон гасит
    // его, чтобы не ходить в сеть) и внешнюю базу, если она задана в config.json.
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      ...backendEnv(apiConfig, smokeEnvOverrides()),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  backendProcess.stdout?.on("data", (chunk) => {
    rememberBackendOutput(chunk);
    process.stdout.write(`[backend] ${chunk}`);
  });
  backendProcess.stderr?.on("data", (chunk) => {
    rememberBackendOutput(chunk);
    process.stderr.write(`[backend] ${chunk}`);
  });
  backendProcess.on("error", (error) => {
    rememberBackendOutput(`ошибка запуска: ${error?.message ?? error}`);
  });
  backendProcess.on("exit", (code) => {
    backendProcess = null;
    backendExit = code;
    if (quitting) return;
    console.warn(`[backend] процесс завершился с кодом ${code}`);
    // Backend, который мы подняли, умер — честно показываем экран вместо
    // интерфейса с ошибками запросов.
    if (mainWindow && !mainWindow.isDestroyed() && publicBase && backendStatus.ok) {
      backendStatus = buildBackendStatus(BACKEND_STATE.START_FAILED, {
        attempt: "оболочка запускала локальный backend",
        detail: `процесс завершился с кодом ${code}`,
        processOutput: backendOutput(),
      });
      logBackendStatus(backendStatus);
      mainWindow.loadURL(publicBase + BACKEND_STATUS_PATH);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Дождаться готовности запущенного backend (`GET /health`) или честно сказать, почему нет. */
async function waitForBackend(timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = null;
  while (Date.now() < deadline) {
    if (!backendProcess) {
      return { ok: false, detail: `процесс завершился с кодом ${backendExit ?? "?"}`, processOutput: backendOutput() };
    }
    const probe = await probeHealth({ url: apiConfig.apiUrl, timeoutMs: 2000 });
    if (probe.ok) return { ok: true };
    lastDetail = probe.detail;
    await sleep(400);
  }
  return {
    ok: false,
    detail: `не ответил за ${Math.round(timeoutMs / 1000)} с (последняя ошибка: ${lastDetail})`,
    processOutput: backendOutput(),
  };
}

/**
 * Привести backend в рабочее состояние: уже отвечает → ничего не делаем;
 * локальный адрес + автозапуск → поднимаем и ждём; иначе — честное состояние.
 */
async function ensureBackend() {
  const probe = await probeHealth({ url: apiConfig.apiUrl, timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.ok) {
    backendStatus = buildBackendStatus(BACKEND_STATE.OK);
    return backendStatus;
  }
  const failure = { detail: probe.detail };

  if (!apiConfig.autostart) {
    backendStatus = buildBackendStatus(BACKEND_STATE.DISABLED, failure);
    return backendStatus;
  }
  if (!apiConfig.isLoopback) {
    backendStatus = buildBackendStatus(BACKEND_STATE.REMOTE, failure);
    return backendStatus;
  }
  // Явная настройка указала в никуда — это и есть причина, а не «нечего запускать»:
  // молчаливый откат на другой каталог/интерпретатор только запутал бы (R97i).
  if (apiConfig.explicitDirMissing) {
    backendStatus = buildBackendStatus(BACKEND_STATE.NO_RUNTIME, {
      detail: `указанный каталог backend не найден или в нём нет app/main.py: ${apiConfig.explicitDirMissing.dir} (${apiConfig.explicitDirMissing.source})`,
    });
    return backendStatus;
  }
  if (apiConfig.explicitPythonMissing) {
    backendStatus = buildBackendStatus(BACKEND_STATE.NO_RUNTIME, {
      detail: `указанный интерпретатор Python не найден: ${apiConfig.explicitPythonMissing.python} (${apiConfig.explicitPythonMissing.source})`,
    });
    return backendStatus;
  }
  // Запускать нечего: ни встроенного бинарника, ни пары «каталог backend + Python».
  // (В собранном приложении `backendDir`/`python` пусты всегда — там работает
  // встроенный backend, и старая проверка «нет python → no-runtime» врала бы.)
  if (!runtimeCommand(apiConfig)) {
    backendStatus = buildBackendStatus(BACKEND_STATE.NO_RUNTIME, failure);
    return backendStatus;
  }
  if (backendProcess) {
    // Повторная проверка уже запущенного нами сервера: второй процесс не нужен.
    const ready = await waitForBackend(15_000);
    backendStatus = ready.ok
      ? buildBackendStatus(BACKEND_STATE.OK, { managed: true })
      : buildBackendStatus(BACKEND_STATE.START_FAILED, { attempt: "оболочка запускала локальный backend", ...ready });
    return backendStatus;
  }

  // Голое имя команды (`python`) на диске не проверяется — убеждаемся, что она
  // вообще запускается: иначе на Windows откроется заглушка Microsoft Store
  // вместо понятной ошибки. К встроенному backend это отношения не имеет.
  if (!apiConfig.bundledExe && apiConfig.pythonFromPath) {
    const check = spawnSync(apiConfig.python, ["--version"], { timeout: 10_000, windowsHide: true, encoding: "utf8" });
    const output = `${check.stdout ?? ""}${check.stderr ?? ""}`;
    if (check.status !== 0 || !/Python\s+\d/.test(output)) {
      const reason = check.error?.message ?? (output.trim() || `код ${check.status}`);
      backendStatus = buildBackendStatus(BACKEND_STATE.NO_RUNTIME, {
        ...failure,
        detail: `Python из PATH не запускается (${reason})`,
      });
      return backendStatus;
    }
  }

  const runtime = runtimeCommand(apiConfig);
  const attempt =
    runtime?.kind === RUNTIME_KIND.BUNDLED
      ? `запуск встроенного backend: ${runtime.command} (порт ${apiConfig.port})`
      : `запуск: ${apiConfig.python} —m uvicorn app.main:app --port ${apiConfig.port} (в ${apiConfig.backendDir})`;
  // Демо-данные наполняем до старта сервера: первый кадр интерфейса должен быть
  // уже с АЗС, а не пустой картой, которую через секунду сменит наполненная.
  maybeSeedDemoData();
  console.log(`[backend] запускаем локальный сервер: ${attempt}`);
  try {
    startBackend();
  } catch (error) {
    backendStatus = buildBackendStatus(BACKEND_STATE.START_FAILED, { attempt, detail: String(error?.message ?? error) });
    return backendStatus;
  }
  const ready = await waitForBackend();
  backendStatus = buildBackendStatus(ready.ok ? BACKEND_STATE.OK : BACKEND_STATE.START_FAILED, {
    managed: ready.ok,
    attempt,
    ...(ready.ok ? {} : ready),
  });
  return backendStatus;
}

// ---------- свободный порт ----------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---------- встроенный Next-сервер ----------

function serverEntryPath() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(__dirname, "server-dist");
  return path.join(base, "server.js");
}

async function startEmbeddedServer() {
  const entry = serverEntryPath();
  if (!fs.existsSync(entry)) {
    throw new Error(
      "Не найдена встроенная сборка интерфейса (server.js). Соберите её: cd desktop && npm run prepare:server",
    );
  }
  const port = await getFreePort();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  serverProcess = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  serverProcess.stdout?.on("data", (chunk) => process.stdout.write(`[web] ${chunk}`));
  serverProcess.stderr?.on("data", (chunk) => process.stderr.write(`[web] ${chunk}`));
  serverProcess.on("exit", (code) => {
    serverProcess = null;
    if (!quitting && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      // Честная диагностика вместо пустого окна.
      dialog.showErrorBox(
        "FuelRadar: интерфейс остановился",
        `Встроенный веб-сервер завершился с кодом ${code}. Перезапустите приложение; если проблема повторяется — переустановите приложение.`,
      );
      app.quit();
    }
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return { port, base };
    } catch {
      // сервер ещё поднимается
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Встроенный веб-сервер не ответил за 60 секунд");
}

// ---------- локальный reverse-proxy (аналог prod-овых deploy/Caddyfile) ----------

/**
 * Next standalone печёт rewrites в момент сборки (API_INTERNAL_URL не читается
 * в рантайме), поэтому /api/* терминирует этот прокси — как Caddy в проде:
 *   /api/*  → backend (FUELRADAR_API_URL / config.json), Origin переписывается
 *             на origin API (иначе backend отвечает 403 «Недопустимый источник»);
 *   /*      → встроенный Next-сервер.
 */
function startProxyServer(nextPort) {
  const apiOrigin = new URL(apiConfig.apiUrl).origin;
  const server = http.createServer((req, res) => {
    const isApi = req.url === "/api" || req.url?.startsWith("/api/");
    const requestPath = (req.url ?? "/").split("?")[0];
    // Пока backend не отвечает, интерфейс не отдаём: вместо него — честный
    // статус-экран с адресом, причиной и кнопками (R97i). Ассеты и /api сюда не
    // попадают: /api отвечает JSON-ошибкой, статика не запрашивается.
    const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
    if (req.method === "GET" && requestPath === BACKEND_STATUS_PATH && backendStatus.ok) {
      // Backend уже отвечает — статус-экран устарел, возвращаем интерфейс.
      res.writeHead(302, { location: "/", "cache-control": "no-store" });
      res.end();
      return;
    }
    if (req.method === "GET" && (requestPath === BACKEND_STATUS_PATH || (!isApi && wantsHtml && !backendStatus.ok))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(backendStatusHtml(backendStatus));
      return;
    }
    const target = isApi ? apiOrigin : `http://127.0.0.1:${nextPort}`;
    const upstream = new URL(target + (req.url ?? "/"));
    const headers = { ...req.headers };
    // hop-by-hop заголовки не пересылаются
    delete headers.connection;
    delete headers["keep-alive"];
    delete headers["transfer-encoding"];
    delete headers["content-length"]; // http.request посчитает сам по body
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    if (isApi) {
      headers.origin = apiOrigin; // backend проверяет Origin мутирующих запросов (R66)
      headers.host = upstream.host;
    }
    const proxyReq = http.request(
      upstream,
      { method: req.method, headers, timeout: 30_000 },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      },
    );
    proxyReq.on("timeout", () => proxyReq.destroy(new Error("upstream timeout")));
    proxyReq.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ detail: `Backend недоступен (${error.message})` }));
    });
    req.pipe(proxyReq, { end: true });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, server });
    });
  });
}

// ---------- окно и навигация ----------

function isTelegramOrigin(url) {
  try {
    const host = new URL(url).hostname;
    return host === "telegram.org" || host.endsWith(".telegram.org");
  } catch {
    return false;
  }
}

function createMainWindow(base) {
  // Безрамочное окно: системную рамку заменяет шапка интерфейса (Header и
  // аналогичные топбары несут drag-регион и кнопки окна через мост
  // fuelradarDesktop.windowControls). Уведомления и попапы Telegram остаются
  // обычными окнами — им drag не нужен.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    titleBarStyle: "hidden",
    title: "FuelRadar",
    backgroundColor: "#0f172a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Главная страница — только локальный origin; внешние адреса — в браузер.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(base)) {
      event.preventDefault();
      handleExternalUrl(url);
    }
  });
  // Попапы: Telegram Login Widget требует oauth.telegram.org (R66) — открываем
  // дочерним окном, чтобы его onauth-колбэк вернулся в открыватель. Всё
  // остальное — в системный браузер / Telegram-клиент.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTelegramOrigin(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 480,
          height: 640,
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    handleExternalUrl(url);
    return { action: "deny" };
  });

  // Ошибки загрузки страницы без backend — не «пустое окно»: статус-экран.
  mainWindow.loadURL(backendStatus.ok ? base : base + BACKEND_STATUS_PATH);
}

/**
 * Открыть config.json, создав его шаблоном с уже найденными путями (если файла нет).
 */
async function openBackendConfig() {
  const configPath = apiConfig.configPath;
  try {
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, configTemplate(apiConfig, app.getVersion()), "utf8");
      console.log(`[backend] создан шаблон конфига: ${configPath}`);
    }
  } catch (error) {
    return { ok: false, path: configPath, error: String(error?.message ?? error) };
  }
  const error = await shell.openPath(configPath);
  return { ok: !error, path: configPath, error: error || null };
}

function handleExternalUrl(url) {
  if (url.startsWith("tg://")) {
    shell.openExternal(url).catch(() => {}); // Telegram-клиент пользователя
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      shell.openExternal(url).catch(() => {});
    }
  } catch {
    // мусорная ссылка — молча игнорируем
  }
}

// ---------- разрешения Chromium ----------

function sameOrigin(candidate, expectedOrigin) {
  try {
    return new URL(candidate).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/**
 * Electron не показывает браузерный prompt для геолокации без permission
 * handlers. Разрешаем её только встроенному локальному окну; Telegram popup и
 * любые внешние страницы не получают доступ к координатам. Notifications
 * оставлены в том же allowlist, потому что Web Push использует это разрешение.
 */
function configurePermissionHandlers(localOrigin) {
  const allowedPermissions = new Set(["geolocation", "notifications"]);
  const isAllowed = (permission, requestingUrl) =>
    allowedPermissions.has(permission) && sameOrigin(requestingUrl, localOrigin);

  const defaultSession = session.defaultSession;
  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    isAllowed(permission, requestingOrigin),
  );

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl ?? webContents.getURL();
    callback(isAllowed(permission, requestingUrl));
  });
}

// ---------- автообновление (electron-updater, NSIS, приватный GitHub-фид) ----------

/**
 * Токен доступа к приватному фиду: `resources/update-feed-token` в собранном
 * приложении (упаковывает сборщик — см. desktop/README.md). `UPDATE_FEED_TOKEN`
 * читается только вне пакета: это отладочный путь, чтобы проверять фид без
 * пересборки; в собранном приложении переменные окружения не смотрятся.
 */
function readFeedToken() {
  if (!app.isPackaged) {
    const fromEnv = String(process.env.UPDATE_FEED_TOKEN ?? "").trim();
    if (fromEnv) return fromEnv;
  }
  try {
    const token = fs.readFileSync(path.join(process.resourcesPath, "update-feed-token"), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Где лежит app-update.yml. В собранном приложении — в resources пакета. В dev его
 * нет, поэтому для самопроверки (FUELRADAR_FEED_STATUS=1) берём конфиг последней
 * локальной сборки — иначе проверить фид до сборки было бы нечем.
 */
function feedConfigPaths() {
  const packaged = path.join(process.resourcesPath, "app-update.yml");
  if (app.isPackaged) return [packaged];
  return [packaged, path.join(__dirname, "dist", "win-unpacked", "resources", "app-update.yml")];
}

/** Конфиг фида (app-update.yml) → {owner, repo} или null. */
function readFeedConfig() {
  for (const candidate of feedConfigPaths()) {
    try {
      const config = parseFeedConfig(fs.readFileSync(candidate, "utf8"));
      if (config) return config;
    } catch {
      // нет файла/не читается — пробуем следующий
    }
  }
  return null;
}

/**
 * Честный статус фида (R97i) для лога и вкладки «Обновления».
 *
 * electron-updater сообщает одно и то же «обновлений нет» и когда токен не принят,
 * и когда релизов ещё нет. Здесь причины разделены (см. feed-status.cjs) и результат
 * кэшируется на 5 минут, чтобы открытие вкладки не било по API каждый раз.
 */
const FEED_STATUS_TTL_MS = 5 * 60 * 1000;
let feedStatusCache = { result: null, checkedAt: 0 };

async function refreshFeedStatus({ force = false, allowDev = false } = {}) {
  const now = Date.now();
  if (!force && feedStatusCache.result && now - feedStatusCache.checkedAt < FEED_STATUS_TTL_MS) {
    return feedStatusCache.result;
  }
  if (!app.isPackaged && !allowDev) {
    // В dev-запуске обновляться не с чего — и это не «фид недоступен» (R97i).
    feedStatusCache = {
      result: {
        state: "dev-run",
        message: "Dev-запуск оболочки: проверять фид нечего.",
        release: null,
        updateAvailable: false,
        detail: null,
        fingerprint: null,
      },
      checkedAt: now,
    };
    // Без строки в логе непонятно, почему состояния фида нет (R97i) — пишем и в dev.
    console.log(`[updates] фид: ${feedStatusCache.result.state} — ${feedStatusCache.result.message}`);
    return feedStatusCache.result;
  }

  const token = readFeedToken();
  const result = await probeFeed({ token, config: readFeedConfig(), currentVersion: app.getVersion() });
  feedStatusCache = { result, checkedAt: now };
  console.log(`[updates] фид: ${result.state} — ${result.message}`);
  return result;
}

/**
 * Настроенный autoUpdater или null (dev / нет токена / конфиг не github).
 *
 * Релизы лежат в Releases ПРИВАТНОГО репозитория: обычный GitHubProvider ходит
 * на github.com (atom-фид, /releases/latest, download-ссылки), и эти endpoинты
 * не принимают API-токены — приватный репозиторий для него всегда 404. Поэтому
 * при наличии токена переключаем фид на PrivateGitHubProvider через setFeedURL
 * ({provider: "github", private: true, token}): он работает через api.github.com
 * (releases/latest + asset API, Accept: application/octet-stream) — там
 * fine-grained PAT с правом Contents: read авторизует и чтение фида, и загрузку.
 */
let configuredUpdater = null;

function getUpdater() {
  if (configuredUpdater) return configuredUpdater;
  if (!app.isPackaged) return null;
  const token = readFeedToken();
  if (!token) return null;
  try {
    // eslint-disable-next-line global-require
    const { autoUpdater } = require("electron-updater");
    // js-yaml — prod-зависимость electron-updater, доступна в asar пакета.
    // eslint-disable-next-line global-require
    const yaml = require("js-yaml");
    const cfg = yaml.load(fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8"));
    if (!cfg || cfg.provider !== "github" || !cfg.owner || !cfg.repo) return null;
    autoUpdater.setFeedURL({ provider: "github", owner: cfg.owner, repo: cfg.repo, private: true, token });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", () => {
      if (Notification.isSupported()) {
        new Notification({
          title: "FuelRadar",
          body: "Обновление загружено — установится при следующем запуске",
        }).show();
      }
    });
    autoUpdater.on("error", (error) => {
      // Нет сети / истёк токен — обновление не критичная функция (как офлайн-кэш R05).
      console.warn("[updates]", error?.message ?? error);
    });
    configuredUpdater = autoUpdater;
    return configuredUpdater;
  } catch (error) {
    console.warn("[updates] недоступно:", error?.message ?? error);
    return null;
  }
}

function initAutoUpdate() {
  if (!app.isPackaged || SMOKE) return; // в dev обновляться не с чего — честно не проверяем
  // Статус фида проверяем до первого обращения апдейтера: он же отвечает на вопрос
  // «токен приняли?», который по молчанию electron-updater не отличить от «релизов нет».
  void refreshFeedStatus({ force: true });
  const updater = getUpdater();
  if (!updater) {
    console.warn("[updates] токен фида не упакован — автообновление отключено (R97i)");
    return;
  }
  const check = () => updater.checkForUpdatesAndNotify().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "FuelRadar",
      submenu: [
        { role: "about", label: "О программе" },
        {
          label: "Проверить обновления",
          click: () => {
            const updater = getUpdater();
            if (!updater) return; // dev или сборка без токена — честно ничего не делаем
            updater.checkForUpdatesAndNotify().catch(() => {});
          },
        },
        { type: "separator" },
        { role: "quit", label: "Выход" },
      ],
    },
    { role: "editMenu", label: "Правка" },
    { role: "viewMenu", label: "Вид" },
    { role: "windowMenu", label: "Окно" },
  ]);
  Menu.setApplicationMenu(menu);
}

// ---------- жизненный цикл ----------

// ---------- IPC-мост (handlers для preload.cjs) ----------

ipcMain.on("fuelradar:version", (event) => {
  event.returnValue = app.getVersion();
});

// ---------- IPC backend (статус-экран, «Повторить», конфиг) ----------

ipcMain.handle("fuelradar:backend-status", () => backendStatus);

ipcMain.handle("fuelradar:backend-retry", async () => {
  backendStatus = await ensureBackend();
  logBackendStatus(backendStatus);
  if (backendStatus.ok && mainWindow && !mainWindow.isDestroyed() && publicBase) {
    await mainWindow.loadURL(publicBase);
  }
  return backendStatus;
});

ipcMain.handle("fuelradar:backend-open-config", () => openBackendConfig());

// ---------- данные: экспорт/бэкап локальной базы и перенос во внешнюю ----------

/** Сколько ждать служебную команду базы (перенос больших баз — не мгновенный). */
const MAINTENANCE_TIMEOUT_MS = 5 * 60 * 1000;

/** Информация о файле локальной базы (размер/время) — без секретов. */
function localDatabaseInfo() {
  const file = localDatabaseFile(apiConfig);
  if (!file) return { exists: false, bytes: null, modifiedAt: null };
  try {
    const stat = fs.statSync(file);
    return { exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch {
    // Базы ещё нет (первый запуск без наполнения) — это состояние, а не ошибка.
    return { exists: false, bytes: null, modifiedAt: null };
  }
}

/** Последняя резервная копия в каталоге данных — строка панели «Данные».
 * Каталог может не существовать до первой копии: тогда null, а не выдуманный путь. */
function newestBackup() {
  const dir = backupDir(apiConfig);
  if (!dir) return null;
  try {
    let newest = null;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".db")) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { path: full, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
        }
      } catch {
        // Файл исчез между чтением каталога и stat — просто пропускаем.
      }
    }
    if (!newest) return null;
    return { path: newest.path, bytes: newest.bytes, modifiedAt: newest.modifiedAt };
  } catch {
    return null;
  }
}

/** Честная причина, почему копию/перенос сделать нечем (R97i). */
function maintenanceUnavailableReason() {
  return databaseStatus(apiConfig, null).reason ?? "служебные команды backend недоступны";
}

/**
 * Выполнить служебную команду backend (`--backup-db` / `--migrate-db`) и вернуть
 * её отчёт.
 *
 * Команда печатает одну строку JSON (см. backend/db/transfer.py::json_line) —
 * её и разбираем; сырой вывод оставляем как техническую подробность (хвост, не
 * весь лог). Секретов в нём нет: адрес базы печатает сам backend и маскирует
 * пароль (R68). Таймаут — не «зависло навсегда»: процесс гасим и говорим прямо.
 */
function runMaintenanceCommand(command, timeoutMs = MAINTENANCE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, output: `${stdout}${stderr}`.trim().slice(-2000) || null });
    };
    let child;
    try {
      child = spawn(command.command, command.args, {
        cwd: command.cwd ?? undefined,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", ...backendEnv(apiConfig, smokeEnvOverrides()) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error), output: null });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Процесс уже завершился сам.
      }
      finish({ ok: false, error: `служебная команда не завершилась за ${Math.round(timeoutMs / 1000)} с` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const report = parseMaintenanceReport(stdout);
      if (report) return finish({ ...report, exitCode: code });
      finish({ ok: false, exitCode: code, error: stderr.trim() || `backend завершился с кодом ${code} и не вернул отчёт` });
    });
  });
}

/** Консистентный снимок локальной базы; без пути — в <данные>/backups. */
async function backupDatabase(destination) {
  const command = maintenanceCommand(apiConfig, "backup", { destination: destination ?? null });
  if (!command) return { supported: false, ok: false, reason: maintenanceUnavailableReason() };
  const report = await runMaintenanceCommand(command);
  return { supported: true, ...report, path: report.path ?? destination ?? null };
}

/** Перенос данных локальной базы во внешнюю (Postgres) — только если она настроена. */
async function migrateDatabase() {
  if (!apiConfig?.databaseUrl) {
    return {
      supported: true,
      ok: false,
      error: "внешняя база не настроена: укажите backend.databaseUrl в config.json (postgresql+psycopg://…)",
    };
  }
  const command = maintenanceCommand(apiConfig, "migrate", { target: apiConfig.databaseUrl });
  if (!command) return { supported: false, ok: false, reason: maintenanceUnavailableReason() };
  return { supported: true, ...(await runMaintenanceCommand(command)) };
}

ipcMain.handle("fuelradar:db-status", () => {
  return { ...databaseStatus(apiConfig, localDatabaseInfo()), newestBackup: newestBackup() };
});

ipcMain.handle("fuelradar:db-backup", async () => backupDatabase(null));

/** Экспорт копии в выбранное оператором место (системный диалог сохранения). */
ipcMain.handle("fuelradar:db-export", async () => {
  const options = {
    title: "Экспорт локальной базы FuelRadar",
    defaultPath: defaultBackupPath(apiConfig) ?? "fuelradar.db",
    filters: [
      { name: "База SQLite", extensions: ["db"] },
      { name: "Все файлы", extensions: ["*"] },
    ],
  };
  const win = controllableWindow();
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true };
  return { canceled: false, ...(await backupDatabase(result.filePath)) };
});

ipcMain.handle("fuelradar:db-migrate", async () => migrateDatabase());

ipcMain.handle("fuelradar:db-reveal", (_event, payload) => {
  const target = typeof payload?.path === "string" ? payload.path.trim() : "";
  if (!target) return { ok: false, error: "путь не задан" };
  if (!path.isAbsolute(target)) return { ok: false, error: "нужен абсолютный путь" };
  shell.showItemInFolder(target);
  return { ok: true };
});

// ---------- IPC управления окном (безрамочный режим) ----------

/** Главное окно или null (попапы Telegram и самопроверки управлению не подлежат). */
function controllableWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

ipcMain.on("fuelradar:window-minimize", (event) => {
  controllableWindow()?.minimize();
  event.returnValue = true;
});

ipcMain.on("fuelradar:window-toggle-maximize", (event) => {
  const win = controllableWindow();
  if (!win) {
    event.returnValue = false;
    return;
  }
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  event.returnValue = win.isMaximized();
});

ipcMain.on("fuelradar:window-close", (event) => {
  controllableWindow()?.close();
  event.returnValue = true;
});

ipcMain.handle("fuelradar:window-state", () => {
  const win = controllableWindow();
  return { exists: Boolean(win), isMaximized: Boolean(win?.isMaximized()) };
});

ipcMain.handle("fuelradar:feed-status", async (_event, options) => {
  const result = await refreshFeedStatus({ force: Boolean(options?.force) });
  return {
    ...result,
    current: app.getVersion(),
    checkedAt: new Date(feedStatusCache.checkedAt).toISOString(),
    tokenPacked: Boolean(readFeedToken()),
  };
});

ipcMain.handle("fuelradar:check-updates", async () => {
  if (!app.isPackaged) return { supported: false, reason: "dev-run: обновляться не с чего (R97i)" };
  const updater = getUpdater();
  if (!updater) {
    return { supported: false, current: app.getVersion(), reason: "Токен фида обновлений не упакован в эту сборку — обновление отключено (см. desktop/README.md)" };
  }
  try {
    const result = await updater.checkForUpdates();
    const info = result?.updateInfo;
    return {
      supported: true,
      current: app.getVersion(),
      available: Boolean(info && info.version && info.version !== app.getVersion()),
      latest: info?.version ?? null,
    };
  } catch (error) {
    // Нет сети / истёк токен — обновление не критичная функция (R97i).
    return { supported: true, current: app.getVersion(), available: false, error: String(error?.message ?? error) };
  }
});

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  quitting = true;
  app.quit();
});

/**
 * Погасить backend, который подняла оболочка (чужой процесс не трогаем).
 *
 * Гасим только на выходе приложения, поэтому `quitting` выставляем здесь: без
 * этого обработчик `exit` успел бы пожаловаться на «процесс завершился с кодом
 * null» — как будто сервер упал сам, а не был остановлен нами.
 */
function stopManagedBackend() {
  quitting = true;
  const child = backendProcess;
  backendProcess = null;
  if (child) child.kill();
  return child;
}

/**
 * Напечатать строки и выйти, дождавшись сброса stdout: `app.exit()` завершает
 * процесс сразу и хвост лога (самое важное — итоговое состояние) иначе теряется.
 */
function writeAndExit(lines, code) {
  const payload = `${lines.filter(Boolean).join("\n")}\n`;
  process.stdout.write(payload, async () => {
    // app.exit() минует before-quit — детей гасим и дожидаемся сами, иначе
    // временный каталог данных останется залоченным их дескрипторами.
    const child = stopManagedBackend();
    await waitForChildExit(child);
    cleanupSmokeDataDir();
    app.exit(code);
  });
}

app.on("before-quit", () => {
  quitting = true;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  stopManagedBackend();
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
  cleanupSmokeDataDir();
});

app.whenReady().then(async () => {
  try {
    // Самопроверка backend без окна: удобно на машине пилота и в поддержке
    // («почему окно говорит, что backend не отвечает?»). Логика та же, что у
    // кнопки «Повторить» (включая попытку автозапуска). Код выхода: 0 — отвечает, 3 — нет.
    if (process.env.FUELRADAR_BACKEND_STATUS === "1") {
      apiConfig = resolveApiConfig();
      backendStatus = await ensureBackend();
      const text = describeState(backendStatus.state);
      writeAndExit(
        [
          `FUELRADAR_BACKEND_STATUS ${backendStatus.state} ${backendStatus.url} — ${backendStatus.detail ?? text.title}`,
          `[backend] runtime: ${backendStatus.runtime?.kind ?? "нет"}`,
          backendStatus.runtime?.kind === RUNTIME_KIND.BUNDLED
            ? `[backend] встроенный backend: ${backendStatus.runtime.exe}`
            : null,
          backendStatus.runtime?.kind === RUNTIME_KIND.PYTHON
            ? `[backend] Python: ${backendStatus.runtime.python} (${backendStatus.runtime.pythonSource})\n[backend] каталог: ${backendStatus.runtime.dir}`
            : null,
          backendStatus.dataDir ? `[backend] каталог данных: ${backendStatus.dataDir}` : null,
        ],
        backendStatus.ok ? 0 : 3,
      );
      return;
    }
    // Самопроверка фида без окна и сервера: удобно на машине пилота («к этой сборке
    // привязан тот токен и он принят?»). Код выхода: 0 — фид доступен, 3 — нет.
    if (process.env.FUELRADAR_FEED_STATUS === "1") {
      // allowDev: самопроверка — явная просьба проверить фид, а не обычный старт,
      // поэтому и в dev-запуске идём в сеть (взяв токен из UPDATE_FEED_TOKEN).
      const result = await refreshFeedStatus({ force: true, allowDev: true });
      writeAndExit(
        [
          `FUELRADAR_FEED_STATUS ${result.state} ${result.message}`,
          result.fingerprint ? `[updates] отпечаток токена: ${result.fingerprint}` : null,
        ],
        result.state === "ok" ? 0 : 3,
      );
      return;
    }
    // План (адрес API, автозапуск, интерпретатор/каталог) считается до окон:
    // окно должно открываться уже со знанием, отвечает ли backend (R97i).
    apiConfig = resolveApiConfig();
    const { port: nextPort, base: nextBase } = await startEmbeddedServer();
    backendStatus = await ensureBackend();
    logBackendStatus(backendStatus);
    const { port: proxyPort, server: proxy } = await startProxyServer(nextPort);
    proxyServer = proxy;
    const base = `http://127.0.0.1:${proxyPort}`;
    publicBase = base;
    console.log(`[desktop] ui: ${nextBase} → public: ${base}`);
    configurePermissionHandlers(base);
    createMainWindow(base);
    buildMenu();
    initAutoUpdate();
    // Лог при старте: видно в логе приложения и в вкладке «Обновления».
    // В dev-запуске проверка не ходит в сеть (состояние dev-run), поэтому её можно
    // печатать и в smoke; в собранном приложении smoke пропускает сетевую проверку,
    // чтобы прогон оставался детерминированным.
    if (!SMOKE || !app.isPackaged) {
      void refreshFeedStatus().catch((error) => console.warn("[updates] фид: ошибка проверки", error?.message ?? error));
    }
    if (SMOKE) {
      // Smoke-проверка CI/агента: окно поднялось, сервер и backend-прокси отвечают — выходим.
      // Backend оболочка поднимает сама (автозапуск), поэтому ручной `make dev` не нужен.
      console.log(`FUELRADAR_SMOKE_BACKEND ${backendStatus.state}`);
      const ui = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (!ui.ok) throw new Error(`ui → ${ui.status}`);
      const meta = await fetch(`${base}/api/v1/meta`, { signal: AbortSignal.timeout(5000) });
      if (!meta.ok) throw new Error(`proxy /api/v1/meta → ${meta.status} (backend: ${backendStatus.state})`);
      // Каталог через прокси: 0 — рабочий backend без данных (у первого запуска
      // без региона так и есть), 7 — первый запуск с наполнением демо-данными.
      const stations = await fetch(`${base}/api/v1/stations`, { signal: AbortSignal.timeout(10000) });
      if (!stations.ok) throw new Error(`proxy /api/v1/stations → ${stations.status} (backend: ${backendStatus.state})`);
      const listed = await stations.json();
      console.log(`FUELRADAR_SMOKE_STATIONS ${Array.isArray(listed) ? listed.length : 0}`);
      // R58: сигнал о сборе доезжает до интерфейса через тот же прокси, каким
      // ходит главный экран, и согласован сам с собой. Состояние зависит от
      // прогона: `smoke` (пустой каталог) — предупреждение, `smoke:first-run`
      // (офлайн-наполнение = настоящие успешные сборы) — `ok`; выдумывать
      // ожидаемое состояние нельзя, проверяем контракт и согласованность.
      // (/ready в этот прокси не входит: его читает мониторинг API-процесса
      // напрямую — контракт /ready проверяют backend-тесты.)
      const collection = await fetch(`${base}/api/v1/collection/health`, { signal: AbortSignal.timeout(5000) });
      if (!collection.ok) throw new Error(`proxy /api/v1/collection/health → ${collection.status}`);
      const collectionSignal = await collection.json();
      const states = ["ok", "disabled", "overdue", "stalled", "unplanned"];
      if (!states.includes(collectionSignal.state) || collectionSignal.warning !== (collectionSignal.state !== "ok")) {
        throw new Error(`collection signal is inconsistent: ${JSON.stringify(collectionSignal)}`);
      }
      console.log(`FUELRADAR_SMOKE_COLLECTION ${collectionSignal.state}`);
      // Безрамочный режим: окно реально создано без рамки (границы окна = границам
      // содержимого — у окна с рамкой и заголовком они различаются), а мост управления
      // окном доступен из рендерера (тем же IPC, которым пользуются кнопки шапки).
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error("main window missing");
      const bounds = mainWindow.getBounds();
      const content = mainWindow.getContentBounds();
      if (bounds.width !== content.width || bounds.height !== content.height) {
        throw new Error(`window has a frame: bounds ${bounds.width}x${bounds.height} != content ${content.width}x${content.height}`);
      }
      let winState = null;
      for (let attempt = 0; attempt < 25 && !winState; attempt += 1) {
        // Рендерер мог ещё грузиться — ждём мост с ретраями (максимум ~5 с).
        winState = await mainWindow.webContents.executeJavaScript(
          "window.fuelradarDesktop?.windowControls ? window.fuelradarDesktop.windowControls.state() : null",
          true,
        ).catch(() => null);
        if (!winState) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!winState?.exists || typeof winState.isMaximized !== "boolean") {
        throw new Error("windowControls bridge unreachable in renderer");
      }
      // Мост backend доступен из рендерера и отдаёт то же состояние, что видит
      // оболочка (по нему работает статус-экран и кнопка «Повторить»).
      const backendBridge = await mainWindow.webContents
        .executeJavaScript("window.fuelradarDesktop?.backend ? window.fuelradarDesktop.backend.status() : null", true)
        .catch(() => null);
      if (!backendBridge || backendBridge.ok !== true) {
        throw new Error(`backend bridge unreachable in renderer: ${JSON.stringify(backendBridge)}`);
      }
      // Мост данных (панель «Данные»): тем же путём, каким ходит интерфейс,
      // снимаем копию локальной базы и убеждаемся, что перенос без внешней базы
      // честно отказывает, а не изображает успех (R97i).
      const dbBridge = await mainWindow.webContents
        .executeJavaScript("window.fuelradarDesktop?.database ? window.fuelradarDesktop.database.status() : null", true)
        .catch(() => null);
      if (!dbBridge || dbBridge.supported !== true) {
        throw new Error(`database bridge unreachable in renderer: ${JSON.stringify(dbBridge)}`);
      }
      const dbBackup = await mainWindow.webContents
        .executeJavaScript("window.fuelradarDesktop.database.backup()", true)
        .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      if (!dbBackup?.ok || !dbBackup.path) {
        throw new Error(`database backup failed: ${JSON.stringify(dbBackup)}`);
      }
      console.log(`FUELRADAR_SMOKE_DB_BACKUP ok rows=${dbBackup.rows ?? 0}`);
      if (!dbBridge.external) {
        const dbMigrate = await mainWindow.webContents
          .executeJavaScript("window.fuelradarDesktop.database.migrate()", true)
          .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
        if (dbMigrate?.ok !== false) {
          throw new Error(`migration without an external database must not pretend success: ${JSON.stringify(dbMigrate)}`);
        }
        console.log("FUELRADAR_SMOKE_DB_MIGRATE unconfigured");
      }
      console.log("FUELRADAR_SMOKE_OK", base);
      setTimeout(async () => {
        const child = stopManagedBackend();
        await waitForChildExit(child);
        cleanupSmokeDataDir();
        app.exit(0);
      }, 1500);
    }
  } catch (error) {
    if (SMOKE) {
      console.error("FUELRADAR_SMOKE_FAIL", error?.message ?? error);
      // Сначала дождаться выхода backend: пока он жив, Windows держит временный
      // каталог данных, и уборка после УПАВШЕГО прогона оставляла бы мусор в temp.
      const child = stopManagedBackend();
      await waitForChildExit(child);
      cleanupSmokeDataDir();
      app.exit(1);
      return;
    }
    dialog.showErrorBox(
      "FuelRadar не запустился",
      String(error?.message ?? error),
    );
    app.exit(1);
  }
});
