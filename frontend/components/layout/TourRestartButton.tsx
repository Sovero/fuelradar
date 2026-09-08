"use client";

import { useOnboarding } from "@/lib/hooks/useOnboarding";
import { useI18n } from "@/lib/hooks/useI18n";

/** «Показать тур ещё раз» (R101) — рядом с переключателями темы/языка в шапке. */
export function TourRestartButton() {
  const { start } = useOnboarding();
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={start}
      aria-label={t("tour.restart")}
      title={t("tour.restart")}
      className="rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
    >
      🎓
    </button>
  );
}
