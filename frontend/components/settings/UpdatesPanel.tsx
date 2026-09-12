"use client";

/**
 * «Обновления» (desktop-оболочка, Electron): версия оболочки и ручная проверка
 * обновлений через мост fuelradarDesktop (IPC fuelradar:check-updates).
 *
 * Честность состояния (R97i):
 * - панель видна ТОЛЬКО в desktop-оболочке (в браузере автообновление делает
 *   Next.js, проверять нечего — вкладка не показывается вовсе);
 * - dev-запуск оболочки (`npm run dev`) — «проверять не с чего» (supported: false);
 * - нет сети / фид не настроен — «не удалось проверить», без выдуманного успеха;
 * - проверка только по кнопке: фоновый цикл (старт + раз в 4 ч) остаётся за
 *   electron-updater в main-процессе, UI его не дублирует.
 */

import { useState } from "react";
import { checkDesktopUpdates, desktopVersion, type DesktopUpdateResult } from "@/lib/desktop";
import { useI18n } from "@/lib/hooks/useI18n";

type CheckState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "result"; result: DesktopUpdateResult }
  | { kind: "error" };

export function UpdatesPanel() {
  const { t, tt } = useI18n();
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  const version = desktopVersion();

  async function runCheck() {
    setCheck({ kind: "busy" });
    try {
      const result = await checkDesktopUpdates();
      setCheck(result ? { kind: "result", result } : { kind: "error" });
    } catch {
      // Мост есть, IPC-хендлера нет (сборка оболочки старше фикс-а) — честная ошибка.
      setCheck({ kind: "error" });
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2 className="text-base font-semibold">{t("settings.updates.title")}</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("settings.updates.description")}</p>
      </header>

      <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
        <span className="text-gray-600 dark:text-gray-300">{t("settings.updates.version")}</span>
        <span className="font-mono text-gray-900 dark:text-gray-100">{version}</span>
      </div>

      <button
        type="button"
        onClick={runCheck}
        disabled={check.kind === "busy"}
        className="w-fit rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {check.kind === "busy" ? t("settings.updates.checking") : t("settings.updates.check")}
      </button>

      {check.kind === "result" && !check.result.available && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          {t("settings.updates.upToDate")}
          {check.result.error ? ` ${t("settings.updates.checkFailedNote")}` : ""}
        </p>
      )}

      {check.kind === "result" && check.result.available && (
        <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          {tt("settings.updates.available", { version: check.result.latest ?? "" })}
        </p>
      )}

      {check.kind === "result" && check.result.supported === false && (
        <p className="rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {check.result.reason ?? t("settings.updates.devRun")}
        </p>
      )}

      {check.kind === "error" && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {t("settings.updates.checkFailed")}
        </p>
      )}
    </section>
  );
}
