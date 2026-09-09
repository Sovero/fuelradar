"use client";

/**
 * Ввод admin-токена (R95i) — простой промпт, как просил бриф задачи: значение
 * знает только владелец `ADMIN_TOKEN` из backend `.env`, здесь только runtime
 * ввод человеком и хранение на время вкладки (sessionStorage, `lib/adminApi.ts`).
 */

import { useState } from "react";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";

export function AdminTokenGate({ children }: { children: React.ReactNode }) {
  const { token, error, submit, logout } = useAdminAuth();
  const { t } = useI18n();
  const [input, setInput] = useState("");

  if (!token || error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-gray-700 dark:text-gray-300">{t("admin.tokenPrompt")}</p>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="X-Admin-Token"
          className="w-64 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="button"
          onClick={() => submit(input)}
          disabled={!input}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {t("admin.tokenSubmit")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-end border-b border-gray-100 px-4 py-1.5 text-xs text-gray-400 dark:border-gray-800">
        <button type="button" onClick={logout} className="hover:text-gray-600 dark:hover:text-gray-200">
          {t("admin.tokenForget")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
