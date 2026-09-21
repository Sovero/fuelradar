"use client";

import Link from "next/link";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { LocaleToggle } from "@/components/layout/LocaleToggle";
import { TourRestartButton } from "@/components/layout/TourRestartButton";
import { MapProviderToggle } from "@/components/layout/MapProviderToggle";
import { WindowControls } from "@/components/layout/WindowControls";
import { useI18n } from "@/lib/hooks/useI18n";

/** Шапка главного экрана по макету брифа §104: логотип, 🔔, карта OSM/Яндекс (R102.1), тема (R99), язык (R100). Входа нет — настройки и админка открыты сразу. */
export function Header() {
  const { t } = useI18n();

  return (
    // app-drag: в desktop-оболочке безрамочного окна вся шапка — область
    // перетаскивания окна; интерактив внутри — в app-no-drag зонах.
    <header className="app-drag flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-2">
        <span className="text-xl">⛽</span>
        <span className="text-lg font-bold text-gray-900 dark:text-gray-100">{t("app.title")}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="app-no-drag flex items-center gap-1">
          <MapProviderToggle />
          <LocaleToggle />
          <ThemeToggle />
          <TourRestartButton />
          <NotificationBell />
          <Link
            href="/settings"
            className="rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
            aria-label={t("header.settings")}
            title={t("header.settings")}
          >
            ⚙️
          </Link>
          <Link
            href="/admin"
            className="rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
            aria-label={t("header.admin")}
            title={t("header.admin")}
          >
            🛠️
          </Link>
        </div>
        <WindowControls />
      </div>
    </header>
  );
}
