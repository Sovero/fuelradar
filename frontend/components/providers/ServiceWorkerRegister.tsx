"use client";

import { useEffect } from "react";

/** Регистрирует service worker для офлайн-кэша карты/последнего ответа списка (R05/R05.1). */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // офлайн-кэш — не критичная функция, тихо игнорируем сбой регистрации
    });
  }, []);
  return null;
}
