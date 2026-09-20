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
 */

const { app, BrowserWindow, Menu, Notification, shell, dialog, ipcMain, session } = require("electron");
const { spawn } = require("node:child_process");
const { parseFeedConfig, probeFeed } = require("./feed-status.cjs");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const SMOKE = process.env.FUELRADAR_SMOKE === "1";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 часа

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import("node:child_process").ChildProcess | null} */
let serverProcess = null;
/** @type {import("node:http").Server | null} */
let proxyServer = null;
let quitting = false;

// ---------- API-адрес (data, не код — R04/R81) ----------

function resolveApiUrl() {
  if (process.env.FUELRADAR_API_URL) return process.env.FUELRADAR_API_URL;
  try {
    const configPath = path.join(app.getPath("userData"), "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof config.apiBaseUrl === "string" && config.apiBaseUrl.trim()) {
      return config.apiBaseUrl.trim();
    }
  } catch {
    // нет конфига — используем дефолт ниже
  }
  // Пилот: локальный dev-backend (`make dev`). Для «установил и работает»
  // задайте FUELRADAR_API_URL или config.json → apiBaseUrl (см. desktop/README.md).
  return "http://127.0.0.1:8000";
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
  const apiOrigin = new URL(resolveApiUrl()).origin;
  const server = http.createServer((req, res) => {
    const isApi = req.url === "/api" || req.url?.startsWith("/api/");
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

  mainWindow.loadURL(base);
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

app.on("before-quit", () => {
  quitting = true;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
});

app.whenReady().then(async () => {
  try {
    // Самопроверка фида без окна и сервера: удобно на машине пилота («к этой сборке
    // привязан тот токен и он принят?»). Код выхода: 0 — фид доступен, 3 — нет.
    if (process.env.FUELRADAR_FEED_STATUS === "1") {
      // allowDev: самопроверка — явная просьба проверить фид, а не обычный старт,
      // поэтому и в dev-запуске идём в сеть (взяв токен из UPDATE_FEED_TOKEN).
      const result = await refreshFeedStatus({ force: true, allowDev: true });
      console.log(`FUELRADAR_FEED_STATUS ${result.state} ${result.message}`);
      if (result.fingerprint) console.log(`[updates] отпечаток токена: ${result.fingerprint}`);
      app.exit(result.state === "ok" ? 0 : 3);
      return;
    }
    const { port: nextPort, base: nextBase } = await startEmbeddedServer();
    const { port: proxyPort, server: proxy } = await startProxyServer(nextPort);
    proxyServer = proxy;
    const base = `http://127.0.0.1:${proxyPort}`;
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
      const ui = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (!ui.ok) throw new Error(`ui → ${ui.status}`);
      const meta = await fetch(`${base}/api/v1/meta`, { signal: AbortSignal.timeout(5000) });
      if (!meta.ok) throw new Error(`proxy /api/v1/meta → ${meta.status}`);
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
      console.log("FUELRADAR_SMOKE_OK", base);
      setTimeout(() => app.exit(0), 1500);
    }
  } catch (error) {
    if (SMOKE) {
      console.error("FUELRADAR_SMOKE_FAIL", error?.message ?? error);
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
