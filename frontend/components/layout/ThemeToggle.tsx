"use client";

import { useTheme } from "@/lib/hooks/useTheme";
import { useI18n } from "@/lib/hooks/useI18n";

/** Переключатель светлой/тёмной темы (R99) — рядом с 🔔 в шапке. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? t("header.theme.toLight") : t("header.theme.toDark")}
      title={theme === "dark" ? t("header.theme.toLight") : t("header.theme.toDark")}
      className="rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}
