"use client";

import { useState } from "react";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { ReportForm } from "@/components/station/ReportForm";

/**
 * «Сообщить» (R30 №1, R30.2, R39) — точка входа в форму отчёта (`ReportForm`,
 * `POST /reports`). Отчёты требуют профиль (backend/app/alerts/authz.py) —
 * анонимному пользователю предлагаем войти, как и у «В избранное».
 */
export function ReportButton({
  stationId,
  stationLat,
  stationLon,
  onRequireLogin,
}: {
  stationId: string;
  stationLat: number;
  stationLon: number;
  onRequireLogin: () => void;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => (user ? setOpen(true) : onRequireLogin())}
        className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        📝 {t("station.report")}
      </button>
      {open && (
        <ReportForm stationId={stationId} stationLat={stationLat} stationLon={stationLon} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
