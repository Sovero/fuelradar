"use client";

import { useState } from "react";
import { ReportForm } from "@/components/station/ReportForm";
import { useI18n } from "@/lib/hooks/useI18n";

/** Кнопка «Сообщить» (R39): входа нет — форма открывается сразу. */
export function ReportButton({
  stationId,
  stationLat,
  stationLon,
}: {
  stationId: string;
  stationLat: number;
  stationLon: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

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
        <ReportForm stationId={stationId} stationLat={stationLat} stationLon={stationLon} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
