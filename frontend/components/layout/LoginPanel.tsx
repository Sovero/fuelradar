"use client";

/**
 * Вход (R06/R66): dev-вход без пароля (пока не настроены SMTP/Telegram —
 * R97i), magic-link по email (`POST /auth/magic-link`, активен при SMTP_URL)
 * и Telegram (`TelegramLoginButton`, активен при NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
 * + backend TELEGRAM_BOT_TOKEN). Каждый способ честно показывает backend-овское
 * «не настроено», если ключи не заданы — ничего не имитируем.
 */

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { TelegramLoginButton } from "@/components/layout/TelegramLoginButton";

type LoginTab = "dev" | "magic" | "telegram";

export function LoginPanel({ onClose }: { onClose: () => void }) {
  const { user, devLogin, requestMagicLink, logout } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<LoginTab>("dev");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDevLogin() {
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

  async function handleMagicLink() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestMagicLink(email);
      setNotice(t("login.magic.sent"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("login.magic.error"));
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
            <div className="flex gap-1 border-b border-gray-200 text-sm dark:border-gray-800">
              {(["dev", "magic", "telegram"] as LoginTab[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setTab(key);
                    setError(null);
                    setNotice(null);
                  }}
                  className={`-mb-px border-b-2 px-3 py-1.5 font-medium ${
                    tab === key
                      ? "border-emerald-600 text-emerald-700 dark:text-emerald-400"
                      : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400"
                  }`}
                >
                  {key === "dev" ? t("login.tab.dev") : key === "magic" ? t("login.tab.magic") : t("login.tab.telegram")}
                </button>
              ))}
            </div>

            {tab === "dev" && (
              <>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("login.description")}</p>
                <input
                  type="email"
                  placeholder={t("login.emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                />
                <button
                  type="button"
                  onClick={handleDevLogin}
                  disabled={busy}
                  className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? t("login.submitting") : t("login.submit")}
                </button>
              </>
            )}

            {tab === "magic" && (
              <>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("login.magic.description")}</p>
                <input
                  type="email"
                  placeholder={t("login.emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                />
                {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
                <button
                  type="button"
                  onClick={handleMagicLink}
                  disabled={busy || !email}
                  className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? t("login.submitting") : t("login.magic.submit")}
                </button>
              </>
            )}

            {tab === "telegram" && (
              <>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("login.telegram.description")}</p>
                <TelegramLoginButton onError={setError} onSuccess={onClose} />
              </>
            )}

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}
        <button type="button" onClick={onClose} className="mt-3 w-full text-center text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          {t("login.close")}
        </button>
      </div>
    </div>
  );
}
