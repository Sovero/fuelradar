"use client";

/**
 * Входа и ролей в приложении нет: админ-раздел открыт тому, кто запустил
 * приложение (backend защищён только лимитами запросов). Компонент оставлен
 * как тонкая обёртка для совместимости раскладки AdminScreen.
 */

import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";

export function AdminTokenGate({ children }: { children: React.ReactNode }) {
  const { error } = useAdminAuth();
  const { t } = useI18n();

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-red-600 dark:text-red-400">
        {t("admin.accessDenied")}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
