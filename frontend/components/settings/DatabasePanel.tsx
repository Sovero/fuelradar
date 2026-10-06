"use client";

/**
 * «Данные» (desktop-оболочка, Electron): резервная копия и экспорт локальной
 * базы + разовый перенос накопленного во внешний Postgres. Работает через мост
 * `fuelradarDesktop.database` (IPC fuelradar:db-status / db-backup / db-export /
 * db-migrate / db-reveal).
 *
 * Честность состояния (R97i), а не «кнопка ради кнопки»:
 * - копию и перенос выполняет backend приложения — если оболочка не нашла, чем
 *   его запустить, панель говорит «нечем» и кнопок не показывает;
 * - внешняя база не настроена → перенос помечается «не настроено» с указанием,
 *   где именно задать адрес (backend.databaseUrl); кнопка не имитирует работу;
 * - результат любой операции показывается цифрами (путь, размер, записей,
 *   вставлено/пропущено), а не словом «готово»; ошибка — текстом причины;
 * - пароль внешней базы панель не получает вовсе: оболочка отдаёт адрес уже
 *   замаскированным (R68), а `output` — только технической подробностью в title.
 */

import { useCallback, useEffect, useState } from "react";
import { formatBytes, formatUtcDateTime } from "@/lib/format";
import {
  desktopDatabase,
  type DesktopDatabaseBackupResult,
  type DesktopDatabaseMigrateResult,
  type DesktopDatabaseStatus,
} from "@/lib/desktop";
import { useI18n } from "@/lib/hooks/useI18n";

type StatusState =
  | { kind: "loading" }
  | { kind: "status"; status: DesktopDatabaseStatus }
  | { kind: "unavailable" };

type BackupState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "result"; result: DesktopDatabaseBackupResult }
  | { kind: "canceled" }
  | { kind: "error"; message: string };

type MigrateState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "result"; result: DesktopDatabaseMigrateResult }
  | { kind: "error"; message: string };

export function DatabasePanel() {
  const { t, tt } = useI18n();
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [backup, setBackup] = useState<BackupState>({ kind: "idle" });
  const [migrate, setMigrate] = useState<MigrateState>({ kind: "idle" });

  const loadStatus = useCallback(async () => {
    const bridge = desktopDatabase();
    if (!bridge) {
      setStatus({ kind: "unavailable" });
      return;
    }
    try {
      setStatus({ kind: "status", status: await bridge.status() });
    } catch {
      // Мост есть, а IPC-хендлера нет (сборка оболочки старше панели).
      setStatus({ kind: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function runBackup(mode: "backup" | "export") {
    const bridge = desktopDatabase();
    if (!bridge) {
      setStatus({ kind: "unavailable" });
      return;
    }
    setBackup({ kind: "busy" });
    try {
      const result = mode === "export" ? await bridge.exportCopy() : await bridge.backup();
      if (result.canceled) setBackup({ kind: "canceled" });
      else if (result.ok) setBackup({ kind: "result", result });
      else setBackup({ kind: "error", message: result.error ?? result.reason ?? "" });
    } catch {
      setBackup({ kind: "error", message: t("settings.database.statusError") });
    }
    void loadStatus();
  }

  async function runMigrate() {
    const bridge = desktopDatabase();
    if (!bridge) {
      setStatus({ kind: "unavailable" });
      return;
    }
    setMigrate({ kind: "busy" });
    try {
      const result = await bridge.migrate();
      if (result.ok) setMigrate({ kind: "result", result });
      else setMigrate({ kind: "error", message: result.error ?? result.reason ?? "" });
    } catch {
      setMigrate({ kind: "error", message: t("settings.database.statusError") });
    }
    void loadStatus();
  }

  async function reveal(path: string | null | undefined) {
    const bridge = desktopDatabase();
    if (!bridge || !path) return;
    try {
      await bridge.reveal(path);
    } catch {
      // Показать в папке — удобство, а не операция: молча оставляем как есть.
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-base font-semibold">{t("settings.database.title")}</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("settings.database.description")}</p>
      </header>

      {status.kind === "loading" && <p className="text-sm text-gray-500 dark:text-gray-400">…</p>}

      {status.kind === "unavailable" && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {t("settings.database.statusError")}
        </p>
      )}

      {status.kind === "status" && (
        <>
          {!status.status.supported && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              {t("settings.database.unsupported")}
              {status.status.reason ? ` (${status.status.reason})` : ""}
            </p>
          )}

          {/* Где хранятся данные */}
          <div className="rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
            <div className="flex items-center justify-between gap-3">
              <span className="text-gray-600 dark:text-gray-300">{t("settings.database.storage.title")}</span>
              <button
                type="button"
                onClick={() => void loadStatus()}
                className="text-xs text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
              >
                {t("settings.database.refresh")}
              </button>
            </div>
            <dl className="mt-2 grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-gray-500 dark:text-gray-400">
                {status.status.external
                  ? t("settings.database.storage.external")
                  : t("settings.database.storage.local")}
              </dt>
              <dd className="break-all font-mono text-xs">
                {status.status.external ? status.status.externalUrl : status.status.localFile}
              </dd>
              {status.status.external && (
                <>
                  <dt className="text-gray-500 dark:text-gray-400">
                    {t("settings.database.storage.externalSource")}
                  </dt>
                  <dd>{status.status.externalSource}</dd>
                </>
              )}
              <dt className="text-gray-500 dark:text-gray-400">{t("settings.database.storage.dataDir")}</dt>
              <dd className="break-all font-mono text-xs">{status.status.dataDir ?? "—"}</dd>
              {!status.status.external && (
                <>
                  <dt className="text-gray-500 dark:text-gray-400">{t("settings.database.storage.size")}</dt>
                  <dd>
                    {status.status.localExists
                      ? formatBytes(status.status.localBytes)
                      : t("settings.database.storage.missing")}
                    {status.status.localExists && status.status.localModifiedAt
                      ? ` · ${formatUtcDateTime(status.status.localModifiedAt) ?? status.status.localModifiedAt}`
                      : ""}
                  </dd>
                </>
              )}
              {status.status.backupDir && (
                <>
                  <dt className="text-gray-500 dark:text-gray-400">
                    {t("settings.database.backup.title")}
                  </dt>
                  <dd className="break-all font-mono text-xs">
                    {status.status.newestBackup
                      ? tt("settings.database.backup.latest", {
                          path: status.status.newestBackup.path,
                          size: formatBytes(status.status.newestBackup.bytes),
                        })
                      : tt("settings.database.backup.folder", { path: status.status.backupDir })}
                  </dd>
                </>
              )}
            </dl>
            {status.status.external && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                {t("settings.database.storage.localNote")}
              </p>
            )}
          </div>

          {/* Копия и экспорт */}
          <div className="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700">
            <h3 className="text-sm font-medium">{t("settings.database.backup.title")}</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t("settings.database.backup.description")}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runBackup("backup")}
                disabled={backup.kind === "busy" || !status.status.supported}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {backup.kind === "busy" ? t("settings.database.backup.busy") : t("settings.database.backup.create")}
              </button>
              <button
                type="button"
                onClick={() => void runBackup("export")}
                disabled={backup.kind === "busy" || !status.status.supported}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {t("settings.database.backup.export")}
              </button>
            </div>

            {backup.kind === "result" && (
              <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                <p title={backup.result.output ?? undefined}>
                  {tt("settings.database.backup.result", { path: backup.result.path ?? "" })}
                </p>
                {typeof backup.result.rows === "number" && (
                  <p className="text-xs">
                    {tt("settings.database.backup.rows", { rows: String(backup.result.rows) })}
                    {backup.result.created_at
                      ? ` · ${formatUtcDateTime(backup.result.created_at) ?? backup.result.created_at}`
                      : ""}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void reveal(backup.result.path)}
                  className="mt-1 text-xs text-emerald-800 underline underline-offset-2 dark:text-emerald-200"
                >
                  {t("settings.database.backup.show")}
                </button>
              </div>
            )}

            {backup.kind === "canceled" && (
              <p className="mt-3 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {t("settings.database.export.canceled")}
              </p>
            )}

            {backup.kind === "error" && (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {tt("settings.database.backup.failed", { error: backup.message || "—" })}
              </p>
            )}
          </div>

          {/* Перенос во внешний Postgres */}
          <div className="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700">
            <h3 className="text-sm font-medium">{t("settings.database.migrate.title")}</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t("settings.database.migrate.description")}
            </p>

            {!status.status.migrationSupported && (
              <p className="mt-2 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {t("settings.database.migrate.notConfigured")}
              </p>
            )}

            {status.status.migrationSupported && (
              <>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {t("settings.database.migrate.target")}
                  {": "}
                  <span className="break-all font-mono">{status.status.externalUrl}</span>
                </p>
                <button
                  type="button"
                  onClick={() => void runMigrate()}
                  disabled={migrate.kind === "busy" || !status.status.supported}
                  className="mt-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {migrate.kind === "busy" ? t("settings.database.migrate.busy") : t("settings.database.migrate.run")}
                </button>
              </>
            )}

            {migrate.kind === "result" && (
              <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                <p title={migrate.result.output ?? undefined}>
                  {tt("settings.database.migrate.ok", {
                    inserted: String(migrate.result.inserted ?? 0),
                    skipped: String(migrate.result.skipped ?? 0),
                  })}
                </p>
                {migrate.result.target_rows && (
                  <p className="text-xs">
                    {tt("settings.database.migrate.targetRows", {
                      rows: String(Object.values(migrate.result.target_rows).reduce((sum, value) => sum + value, 0)),
                    })}
                  </p>
                )}
              </div>
            )}

            {migrate.kind === "error" && (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {tt("settings.database.migrate.failed", { error: migrate.message || "—" })}
              </p>
            )}

            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              {t("settings.database.migrate.note")}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
