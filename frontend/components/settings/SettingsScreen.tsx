"use client";

/**
 * Экран персонализации (R21/R23/R24/R25/R26/R77) — зоны, приватность, режим
 * наблюдения, предпочтения сетей, правила уведомлений. Персонализация только
 * с профилем (R65) — анонимному пользователю предлагаем войти, как везде.
 */

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { LoginPanel } from "@/components/layout/LoginPanel";
import { MonitoringZonesPanel } from "@/components/settings/MonitoringZonesPanel";
import { PrivacySettings } from "@/components/settings/PrivacySettings";
import { ObservationModeSettings } from "@/components/settings/ObservationModeSettings";
import { NetworkPreferences } from "@/components/settings/NetworkPreferences";
import { AlertRulesPanel } from "@/components/settings/AlertRulesPanel";
import { PushSettingsPanel } from "@/components/settings/PushSettingsPanel";

type SettingsTab = "zones" | "privacy" | "observation" | "networks" | "rules" | "push";

const TABS: SettingsTab[] = ["zones", "privacy", "observation", "networks", "rules", "push"];

export function SettingsScreen() {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>("zones");
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center gap-2">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            ← {t("settings.backHome")}
          </Link>
          <h1 className="text-lg font-bold">{t("settings.title")}</h1>
        </div>
      </header>

      {loading && <p className="p-4 text-sm text-gray-400">{t("loading")}</p>}

      {!loading && !user && (
        <div className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-gray-600 dark:text-gray-400">{t("settings.needLogin")}</p>
          <button
            type="button"
            onClick={() => setLoginOpen(true)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t("header.login")}
          </button>
          {loginOpen && <LoginPanel onClose={() => setLoginOpen(false)} />}
        </div>
      )}

      {!loading && user && (
        <div className="flex flex-1 flex-col overflow-hidden sm:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 bg-white px-2 py-2 dark:border-gray-800 dark:bg-gray-900 sm:w-48 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
            {TABS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-medium ${
                  tab === key
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                {t(`settings.tab.${key}` as const)}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto p-4">
            {tab === "zones" && <MonitoringZonesPanel />}
            {tab === "privacy" && <PrivacySettings />}
            {tab === "observation" && <ObservationModeSettings />}
            {tab === "networks" && <NetworkPreferences />}
            {tab === "rules" && <AlertRulesPanel />}
            {tab === "push" && <PushSettingsPanel />}
          </div>
        </div>
      )}
    </div>
  );
}
