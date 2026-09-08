"use client";

import { useState } from "react";
import { useI18n } from "@/lib/hooks/useI18n";

/**
 * «Сообщить» (R30 №1, R30.2, R39) — сама форма отчёта (POST /reports) собирается
 * в T10. Здесь — заглушка/точка входа, которую T10 заменит полноценной формой:
 * кнопка есть и что-то делает (не битая ссылка), но не отправляет отчёт.
 */
export function ReportButton() {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        📝 {t("station.report")}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-gray-900 dark:text-gray-100" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Форма отчёта о наличии топлива/очереди появится в следующем обновлении.
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              Понятно
            </button>
          </div>
        </div>
      )}
    </>
  );
}
