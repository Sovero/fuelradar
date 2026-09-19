"use client";

/**
 * «Обновления» (desktop-оболочка, Electron): версия оболочки, состояние фида и
 * ручная проверка обновлений через мост fuelradarDesktop (IPC
 * fuelradar:check-updates / fuelradar:feed-status).
 *
 * Честность состояния (R97i):
 * - панель видна ТОЛЬКО в desktop-оболочке (в браузере автообновление делает
 *   Next.js, проверять нечего — вкладка не показывается вовсе);
 * - dev-запуск оболочки (`npm run dev`) — «проверять не с чего» (state: dev-run);
 * - самопроверка фида разделяет причины, которые раньше выглядели одинаково:
 *   токен не упакован / токен не принят / доступ есть, но релизов нет / нет сети —
 *   и показывает отпечаток токена (сверить можно, секрет не раскрывается);
 * - сборка оболочки без IPC-хендлера — «состояние фида неизвестно», без
 *   выдуманного «всё хорошо»;
 * - проверка только по кнопке: фоновый цикл (старт + раз в 4 ч) остаётся за
 *   electron-updater в main-процессе, UI его не дублирует.
 */

import { useCallback, useEffect, useState } from "react";
import { formatUtcDateTime } from "@/lib/format";
import {
  checkDesktopUpdates,
  desktopFeedStatus,
  desktopVersion,
  type DesktopFeedStatus,
  type DesktopUpdateResult,
} from "@/lib/desktop";
import { useI18n } from "@/lib/hooks/useI18n";

type CheckState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "result"; result: DesktopUpdateResult }
  | { kind: "error" };

type FeedState =
  | { kind: "loading" }
  | { kind: "status"; status: DesktopFeedStatus }
  | { kind: "unavailable" };

/** Состояния фида, которые честно означают «обновлений не будет» — спокойный серый. */
const NEUTRAL_FEED_STATES = new Set(["no-token", "no-release", "dev-run"]);

function feedMessageKey(state: string) {
  if (state === "ok") return "settings.updates.feed.ok" as const;
  if (state === "no-access") return "settings.updates.feed.noAccess" as const;
  if (state === "no-release") return "settings.updates.feed.noRelease" as const;
  if (state === "no-config") return "settings.updates.feed.noConfig" as const;
  if (state === "rate-limited") return "settings.updates.feed.rateLimited" as const;
  if (state === "network") return "settings.updates.feed.network" as const;
  if (state === "dev-run") return "settings.updates.feed.devRun" as const;
  if (state === "no-token") return "settings.updates.feed.noToken" as const;
  return "settings.updates.feed.httpError" as const;
}

export function UpdatesPanel() {
  const { t, tt } = useI18n();
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [feed, setFeed] = useState<FeedState>({ kind: "loading" });

  const version = desktopVersion();

  const loadFeed = useCallback(async (force: boolean) => {
    setFeed({ kind: "loading" });
    try {
      const status = await desktopFeedStatus(force);
      setFeed(status ? { kind: "status", status } : { kind: "unavailable" });
    } catch {
      // Мост есть, а IPC-хендлера нет — состояние фида узнать нечем.
      setFeed({ kind: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void loadFeed(false);
  }, [loadFeed]);

  async function runCheck() {
    setCheck({ kind: "busy" });
    try {
      const result = await checkDesktopUpdates();
      setCheck(result ? { kind: "result", result } : { kind: "error" });
    } catch {
      // Мост есть, IPC-хендлера нет (сборка оболочки старше фикс-а) — честная ошибка.
      setCheck({ kind: "error" });
    }
    // Ручная проверка — повод переспросить фид, не дожидаясь кэша оболочки (5 мин).
    void loadFeed(true);
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

      <div className="rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-600 dark:text-gray-300">{t("settings.updates.feed.title")}</span>
          {feed.kind === "status" && (
            <button
              type="button"
              onClick={() => void loadFeed(true)}
              className="text-xs text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
            >
              {t("settings.updates.feed.recheck")}
            </button>
          )}
        </div>

        {feed.kind === "loading" && (
          <p className="mt-1 text-gray-500 dark:text-gray-400">{t("settings.updates.feed.checking")}</p>
        )}

        {feed.kind === "unavailable" && (
          <p className="mt-1 text-amber-700 dark:text-amber-300">{t("settings.updates.feed.unavailable")}</p>
        )}

        {feed.kind === "status" && (
          <>
            <p
              className={`mt-1 ${
                feed.status.updateAvailable
                  ? "text-blue-700 dark:text-blue-300"
                  : NEUTRAL_FEED_STATES.has(feed.status.state)
                    ? "text-gray-500 dark:text-gray-400"
                    : "text-amber-700 dark:text-amber-300"
              }`}
              title={feed.status.detail ?? undefined}
            >
              {tt(feedMessageKey(feed.status.state), { tag: feed.status.release?.tag ?? t("settings.updates.feed.noTag") })}
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              {feed.status.fingerprint
                ? t("settings.updates.feed.token").replace("{fingerprint}", feed.status.fingerprint)
                : t("settings.updates.feed.tokenMissing")}
              {feed.status.checkedAt
                ? ` · ${t("settings.updates.feed.checkedAt").replace(
                    "{time}",
                    formatUtcDateTime(feed.status.checkedAt) ?? feed.status.checkedAt,
                  )}`
                : ""}
            </p>
          </>
        )}
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
