"use client";

import { useEffect } from "react";
import { isDesktopShell } from "@/lib/desktop";

/** Регистрирует service worker для офлайн-кэша карты/последнего ответа списка (R05/R05.1).
 *  В desktop-оболочке (Electron) не регистрируется — там офлайн и обновления кода делает Electron. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    if (isDesktopShell()) return; // Electron: автообновление через electron-updater
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // офлайн-кэш — не критичная функция, тихо игнорируем сбой регистрации
    });
  }, []);
  return null;
}
