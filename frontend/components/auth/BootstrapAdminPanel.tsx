"use client";

/**
 * Одноразовый мастер первого запуска (M16): если в базе ещё нет ADMIN,
 * пользователь должен создать именно первую административную учётку.
 * Закрыть мастер без создания нельзя — это не обход авторизации.
 */

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";

export function BootstrapAdminPanel() {
  const { bootstrapAdmin } = useAuth();
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirm) {
      setError(t("bootstrap.passwordMismatch"));
      return;
    }
    setBusy(true);
    try {
      await bootstrapAdmin({
        display_name: displayName,
        email,
        password,
        password_confirm: passwordConfirm,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("bootstrap.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="fuelradar-bootstrap-title"
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-900 dark:text-gray-100"
      >
        <h1 id="fuelradar-bootstrap-title" className="mb-2 text-xl font-semibold">
          {t("bootstrap.title")}
        </h1>
        <p className="mb-5 text-sm text-gray-600 dark:text-gray-400">{t("bootstrap.description")}</p>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-sm">
            {t("bootstrap.name")}
            <input
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
              className="rounded-md border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("bootstrap.email")}
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              className="rounded-md border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("bootstrap.password")}
            <input
              required
              minLength={12}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              className="rounded-md border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("bootstrap.passwordConfirm")}
            <input
              required
              minLength={12}
              type="password"
              value={passwordConfirm}
              onChange={(event) => setPasswordConfirm(event.target.value)}
              autoComplete="new-password"
              className="rounded-md border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
            />
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? t("bootstrap.submitting") : t("bootstrap.create")}
          </button>
        </form>
      </section>
    </div>
  );
}
