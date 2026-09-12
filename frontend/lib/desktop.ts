"use client";

/**
 * Признак запуска в desktop-оболочке (Electron, см. desktop/preload.cjs).
 * Веб-код использует это, чтобы не делать то, что в оболочке делает Electron:
 * service worker (офлайн-кэш) отключается — автообновление кода там electron-updater.
 */

/** Результат IPC fuelradar:check-updates (desktop/main.cjs). */
export interface DesktopUpdateResult {
  supported: boolean;
  current?: string;
  available?: boolean;
  latest?: string | null;
  reason?: string;
  error?: string;
}

declare global {
  interface Window {
    fuelradarDesktop?: { isDesktop: true; version: string; checkForUpdates: () => Promise<DesktopUpdateResult> };
  }
}

export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.fuelradarDesktop?.isDesktop === true;
}

/** Версия desktop-оболочки; в браузере — null (строку версии показывает только оболочка). */
export function desktopVersion(): string | null {
  return isDesktopShell() ? (window.fuelradarDesktop?.version ?? null) : null;
}

/**
 * Ручная проверка обновлений через мост. null — моста нет (обычный браузер).
 * Отклонение промиса — мост есть, а IPC-хендлера нет (сборка оболочки старше
 * фикс-а): вызывающий код честно показывает «не удалось проверить».
 */
export async function checkDesktopUpdates(): Promise<DesktopUpdateResult | null> {
  if (!isDesktopShell()) return null;
  const result = await window.fuelradarDesktop?.checkForUpdates();
  return result ?? null;
}
