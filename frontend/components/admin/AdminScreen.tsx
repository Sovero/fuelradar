"use client";

/** Админка (R58/R51/R52/T03/T07) — вкладки поверх admin-токена (R95i). */

import { useState } from "react";
import Link from "next/link";
import { AdminAuthProvider } from "@/lib/hooks/useAdminAuth";
import { AdminTokenGate } from "@/components/admin/AdminTokenGate";
import { AdminSourcesTable } from "@/components/admin/AdminSourcesTable";
import { AdminCollectionLog } from "@/components/admin/AdminCollectionLog";
import { AdminCoverage } from "@/components/admin/AdminCoverage";
import { AdminDeficitByRegion } from "@/components/admin/AdminDeficitByRegion";
import { AdminDedupQueue } from "@/components/admin/AdminDedupQueue";
import { AdminUsersBlock } from "@/components/admin/AdminUsersBlock";
import { useI18n } from "@/lib/hooks/useI18n";

type AdminTab = "sources" | "log" | "coverage" | "bi" | "dedup" | "users";
const TABS: AdminTab[] = ["sources", "log", "coverage", "bi", "dedup", "users"];

function AdminTabs() {
  const [tab, setTab] = useState<AdminTab>("sources");
  const { t } = useI18n();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 bg-white px-2 py-2 dark:border-gray-800 dark:bg-gray-900">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
              tab === key
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            }`}
          >
            {t(`admin.tab.${key}` as const)}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto">
        {tab === "sources" && <AdminSourcesTable />}
        {tab === "log" && <AdminCollectionLog />}
        {tab === "coverage" && <AdminCoverage />}
        {tab === "bi" && <AdminDeficitByRegion />}
        {tab === "dedup" && <AdminDedupQueue />}
        {tab === "users" && <AdminUsersBlock />}
      </div>
    </div>
  );
}

export function AdminScreen() {
  const { t } = useI18n();
  return (
    <AdminAuthProvider>
      <div className="flex h-dvh flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            ← {t("settings.backHome")}
          </Link>
          <h1 className="text-lg font-bold">{t("admin.title")}</h1>
        </header>
        <AdminTokenGate>
          <AdminTabs />
        </AdminTokenGate>
      </div>
    </AdminAuthProvider>
  );
}
