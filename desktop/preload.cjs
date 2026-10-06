"use strict";

/**
 * Preload: минимальный мост (contextIsolation + sandbox включены).
 * Наружу отдаём только флаг «desktop-оболочка», версию и состояние автообновления
 * (статус фида + ручная проверка) — веб-код может отличить оболочку от браузера
 * (например, чтобы не регистрировать service worker — автообновление кода здесь
 * делает electron-updater) и честно показать, доступен ли фид (R97i).
 *
 * Плюс мост backend для статус-экрана (desktop/backend.cjs): состояние сервера,
 * повторная проверка с попыткой автозапуска и открытие config.json — чтобы
 * «backend не отвечает» было действием, а не тупиком.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuelradarDesktop", {
  isDesktop: true,
  version: ipcRenderer.sendSync("fuelradar:version"),
  checkForUpdates: () => ipcRenderer.invoke("fuelradar:check-updates"),
  // Честный статус фида (R97i): доступен ли он именно упакованным токеном;
  // `{force: true}` переспрашивает GitHub, не дожидаясь кэша оболочки.
  feedStatus: (options) => ipcRenderer.invoke("fuelradar:feed-status", options ?? {}),
  // Backend (R97i): статус, повторная проверка (с автозапуском) и конфиг.
  backend: {
    status: () => ipcRenderer.invoke("fuelradar:backend-status"),
    retry: () => ipcRenderer.invoke("fuelradar:backend-retry"),
    openConfig: () => ipcRenderer.invoke("fuelradar:backend-open-config"),
  },
  // Данные (панель «Данные» в настройках): копия/экспорт локальной базы и
  // перенос накопленного во внешний Postgres. Выполняет тот же backend —
  // отдельной реализации бэкапа в оболочке нет, чтобы не разъехались.
  database: {
    status: () => ipcRenderer.invoke("fuelradar:db-status"),
    backup: () => ipcRenderer.invoke("fuelradar:db-backup"),
    exportCopy: () => ipcRenderer.invoke("fuelradar:db-export"),
    migrate: () => ipcRenderer.invoke("fuelradar:db-migrate"),
    reveal: (target) => ipcRenderer.invoke("fuelradar:db-reveal", { path: target }),
  },
  // Управление безрамочным окном: системной рамки нет, свернуть/развернуть/
  // закрыть и drag-регион обеспечивает шапка интерфейса. В браузере моста нет,
  // и весь этот блок там просто не вызывается.
  windowControls: {
    minimize: () => ipcRenderer.sendSync("fuelradar:window-minimize"),
    toggleMaximize: () => ipcRenderer.sendSync("fuelradar:window-toggle-maximize"),
    close: () => ipcRenderer.sendSync("fuelradar:window-close"),
    /** Текущее состояние: существует ли окно и развернуто ли оно. */
    state: () => ipcRenderer.invoke("fuelradar:window-state"),
  },
});
