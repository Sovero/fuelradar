"use client";

/**
 * Минимальная панель входа. Backend поддерживает dev-вход без пароля (пока не
 * настроены SMTP/Telegram — R97i), magic-link по email и Telegram — здесь
 * реализован путь dev-входа, необходимый для персонализации (избранное/следить)
 * в ходе разработки/пилота.
 */

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";

export function LoginPanel({ onClose }: { onClose: () => void }) {
  const { user, devLogin, logout } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    setBusy(true);
    setError(null);
    try {
      await devLogin(email || `guest-${Date.now()}@fuelradar.local`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-gray-900 dark:text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold">{user ? t("login.profileTitle") : t("login.title")}</h2>
        {user ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">{user.email ?? user.telegram_id ?? `Пользователь #${user.id}`}</p>
            <button
              type="button"
              onClick={() => {
                logout();
                onClose();
              }}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {t("login.logout")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("login.description")}</p>
            <input
              type="email"
              placeholder={t("login.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="button"
              onClick={handleLogin}
              disabled={busy}
              className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? t("login.submitting") : t("login.submit")}
            </button>
          </div>
        )}
        <button type="button" onClick={onClose} className="mt-3 w-full text-center text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          {t("login.close")}
        </button>
      </div>
    </div>
  );
}
