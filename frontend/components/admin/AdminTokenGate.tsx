"use client";

/**
 * RBAC gate админ-раздела (M16). Статический X-Admin-Token здесь больше не
 * используется: backend авторизует httpOnly-cookie и роль пользователя.
 */

import { useState } from "react";
import { LoginPanel } from "@/components/layout/LoginPanel";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";

export function AdminTokenGate({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { isOperator, error, logout } = useAdminAuth();
  const { t } = useI18n();
  const [loginOpen, setLoginOpen] = useState(false);

  if (authLoading) {
    return <p className="flex flex-1 items-center justify-center p-6 text-sm text-gray-400">{t("loading")}</p>;
  }

  if (!user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-gray-700 dark:text-gray-300">{t("admin.loginRequired")}</p>
        <button
          type="button"
          onClick={() => setLoginOpen(true)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {t("header.login")}
        </button>
        {loginOpen && <LoginPanel onClose={() => setLoginOpen(false)} />}
      </div>
    );
  }

  if (!isOperator || error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-gray-700 dark:text-gray-300">{error ?? t("admin.accessDenied")}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {user.email ?? user.telegram_id ?? user.display_name ?? `#${user.id}`}
        </p>
        <button
          type="button"
          onClick={async () => {
            await logout();
            setLoginOpen(true);
          }}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          {t("admin.switchAccount")}
        </button>
        {loginOpen && <LoginPanel onClose={() => setLoginOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-1.5 text-xs text-gray-400 dark:border-gray-800">
        <span>{user.role === "ADMIN" ? t("admin.roleAdmin") : t("admin.roleOperator")}</span>
        <button type="button" onClick={() => void logout()} className="hover:text-gray-600 dark:hover:text-gray-200">
          {t("admin.signOut")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
