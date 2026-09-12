"use client";

/**
 * Признак запуска в desktop-оболочке (Electron, см. desktop/preload.cjs).
 * Веб-код использует это, чтобы не делать то, что в оболочке делает Electron:
 * service worker (офлайн-кэш) отключается — автообновление кода там electron-updater.
 */

declare global {
  interface Window {
    fuelradarDesktop?: { isDesktop: true; version: string; checkForUpdates: () => Promise<unknown> };
  }
}

export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.fuelradarDesktop?.isDesktop === true;
}
