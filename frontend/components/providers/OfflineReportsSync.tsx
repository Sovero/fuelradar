"use client";

/**
 * R39.2/R05.3: ретраит офлайн-очередь отчётов при восстановлении сети
 * (`online`) и один раз при монтировании приложения (на случай, если очередь
 * скопилась в предыдущей сессии, пока вкладка была закрыта). Ничего не
 * рендерит — фоновый эффект, как ServiceWorkerRegister.
 */

import { useEffect } from "react";
import { flushOfflineReports, listOfflineReports } from "@/lib/offlineReports";

export function OfflineReportsSync() {
  useEffect(() => {
    function flush() {
      if (listOfflineReports().length === 0) return;
      flushOfflineReports().catch(() => {
        // сеть всё ещё недоступна — попробуем на следующем 'online'/перезагрузке
      });
    }

    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, []);

  return null;
}
