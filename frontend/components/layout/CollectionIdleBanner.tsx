"use client";

/**
 * R58: предупреждение о простое сбора на главном экране.
 *
 * Смысл — не напугать, а не дать показывать старые статусы АЗС как свежие:
 * «нет данных» и «данные устарели, потому что сбор стоит» — разные вещи.
 * Текст собирается из машинного состояния (`state`/`reason`) и чисел backend'а,
 * поэтому переключатель языка работает и здесь (R100); никаких догадок о
 * причинах — только то, что увидел backend.
 *
 * Компонент глупый: сигнал приходит пропом (хук `useCollectionHealth` в
 * HomeScreen), поэтому его легко проверить тестом без сети.
 */

import { formatUtcDateTime } from "@/lib/format";
import { useI18n } from "@/lib/hooks/useI18n";
import type { CollectionHealth } from "@/lib/types";

/** Состояние сигнала → ключ текста (неизвестное состояние читается как «сбор молчит»). */
function stateMessageKey(state: CollectionHealth["state"]) {
  if (state === "disabled") return "collection.warning.disabled" as const;
  if (state === "overdue") return "collection.warning.overdue" as const;
  if (state === "unplanned") return "collection.warning.unplanned" as const;
  return "collection.warning.stalled" as const;
}

export function CollectionIdleBanner({ health }: { health: CollectionHealth | null }) {
  const { t, tt } = useI18n();
  if (!health?.warning) return null;

  const lastSuccess = health.last_success_at
    ? tt("collection.warning.lastSuccess", {
        time: formatUtcDateTime(health.last_success_at) ?? health.last_success_at,
      })
    : t("collection.warning.never");
  const plan =
    health.overdue_minutes !== null && health.overdue_minutes > 0
      ? tt("collection.warning.planOverdue", { minutes: Math.round(health.overdue_minutes) })
      : health.planned_at
        ? tt("collection.warning.nextRun", { time: formatUtcDateTime(health.planned_at) ?? health.planned_at })
        : null;

  return (
    <div
      role="status"
      data-collection-state={health.state}
      className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <p className="font-medium">
        {t(stateMessageKey(health.state))} {t("collection.warning.impact")}
      </p>
      <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-amber-700 dark:text-amber-300">
        <span>{lastSuccess}</span>
        {plan && <span>{plan}</span>}
        {health.running_jobs > 0 && (
          <span>{tt("collection.warning.running", { count: health.running_jobs })}</span>
        )}
      </p>
    </div>
  );
}
