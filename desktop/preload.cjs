"use strict";

/**
 * Preload: минимальный мост (contextIsolation + sandbox включены).
 * Наружу отдаём только флаг «desktop-оболочка», версию и состояние автообновления
 * (статус фида + ручная проверка) — веб-код может отличить оболочку от браузера
 * (например, чтобы не регистрировать service worker — автообновление кода здесь
 * делает electron-updater) и честно показать, доступен ли фид (R97i).
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuelradarDesktop", {
  isDesktop: true,
  version: ipcRenderer.sendSync("fuelradar:version"),
  checkForUpdates: () => ipcRenderer.invoke("fuelradar:check-updates"),
  // Честный статус фида (R97i): доступен ли он именно упакованным токеном;
  // `{force: true}` переспрашивает GitHub, не дожидаясь кэша оболочки.
  feedStatus: (options) => ipcRenderer.invoke("fuelradar:feed-status", options ?? {}),
});
