"use client";

import { useState } from "react";
import Link from "next/link";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { LoginPanel } from "@/components/layout/LoginPanel";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { LocaleToggle } from "@/components/layout/LocaleToggle";
import { TourRestartButton } from "@/components/layout/TourRestartButton";
import { MapProviderToggle } from "@/components/layout/MapProviderToggle";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";

/** Шапка главного экрана по макету брифа §104: логотип, профиль, 🔔, карта OSM/Яндекс (R102.1), тема (R99), язык (R100). */
export function Header() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-2">
        <span className="text-xl">⛽</span>
        <span className="text-lg font-bold text-gray-900 dark:text-gray-100">{t("app.title")}</span>
      </div>
      <div className="flex items-center gap-1">
        <MapProviderToggle />
        <LocaleToggle />
        <ThemeToggle />
        <TourRestartButton />
        <NotificationBell />
        {user && (
          <Link
            href="/settings"
            className="rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
            aria-label={t("header.settings")}
            title={t("header.settings")}
          >
            ⚙️
          </Link>
        )}
        <Link
          href="/admin"
          className="rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={t("header.admin")}
          title={t("header.admin")}
        >
          🛠️
        </Link>
        <button
          type="button"
          onClick={() => setLoginOpen(true)}
          className="rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={user ? t("header.profile") : t("header.login")}
          title={user ? user.email ?? user.telegram_id ?? t("header.profile") : t("header.login")}
        >
          {user ? "👤" : "🔑"}
        </button>
      </div>
      {loginOpen && <LoginPanel onClose={() => setLoginOpen(false)} />}
    </header>
  );
}
