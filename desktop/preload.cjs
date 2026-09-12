"use strict";

/**
 * Preload: минимальный мост (contextIsolation + sandbox включены).
 * Наружу отдаём только флаг «desktop-оболочка» и версию — веб-код может
 * отличить оболочку от браузера (например, чтобы не регистрировать
 * service worker — автообновление кода здесь делает electron-updater).
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuelradarDesktop", {
  isDesktop: true,
  version: ipcRenderer.sendSync("fuelradar:version"),
  checkForUpdates: () => ipcRenderer.invoke("fuelradar:check-updates"),
});
