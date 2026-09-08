"use client";

/**
 * Пустое состояние (§16.4 R75, брифа §108): не «пусто», а объяснение и выходы —
 * 4 кнопки: [+20 км][+30 км][Показывать вероятное наличие][Создать уведомление/Следить].
 */

import { useI18n } from "@/lib/hooks/useI18n";

interface EmptyStateProps {
  radiusKm: number;
  fuelLabel: string;
  onExpandRadius: (extraKm: number) => void;
  onShowLikely: () => void;
  onCreateAlert: () => void;
  likelyShown: boolean;
  alertBusy?: boolean;
  alertCreated?: boolean;
}

export function EmptyState({
  radiusKm,
  fuelLabel,
  onExpandRadius,
  onShowLikely,
  onCreateAlert,
  likelyShown,
  alertBusy,
  alertCreated,
}: EmptyStateProps) {
  const { t, tt } = useI18n();
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700"
    >
      <p className="text-lg font-medium text-gray-800 dark:text-gray-100">{tt("empty.headline", { radius: radiusKm, fuel: fuelLabel })}</p>
      <p className="text-sm text-gray-500 dark:text-gray-400">{t("empty.reason")}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => onExpandRadius(20)}
          className="rounded-full border border-emerald-600 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
        >
          {t("empty.radius20")}
        </button>
        <button
          type="button"
          onClick={() => onExpandRadius(30)}
          className="rounded-full border border-emerald-600 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
        >
          {t("empty.radius30")}
        </button>
        <button
          type="button"
          onClick={onShowLikely}
          disabled={likelyShown}
          className="rounded-full border border-amber-600 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-400 dark:hover:bg-amber-950"
        >
          {likelyShown ? t("empty.showLikely.done") : t("empty.showLikely")}
        </button>
        <button
          type="button"
          onClick={onCreateAlert}
          disabled={alertBusy}
          className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {alertCreated ? t("empty.createAlert.done") : t("empty.createAlert")}
        </button>
      </div>
    </div>
  );
}
