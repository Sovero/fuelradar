"use client";

/**
 * Пользователи и отчёты (бриф: «блокировать недостоверные пользовательские
 * сообщения»). `GET /admin/reports` — отчёты всех пользователей (не только
 * свои, как `/reports/mine`), иначе администратору неоткуда узнать, кого
 * блокировать (R104-эра доводка backend). `POST /admin/users/{id}/block`
 * (`{blocked}`) переключает `User.is_blocked` — прямо из строки таблицы или
 * вручную по ID, если нужного отчёта в списке ещё нет.
 *
 * M16 RBAC: таблица пользователей с ролями (`GET /admin/users`); смену роли
 * (`POST /admin/users/{id}/role`) делает только ADMIN — селект скрыт от
 * OPERATOR, у backend'а свои проверки. Последний ADMIN защищён на backend
 * (409), поэтому понижение единственного админа из UI невозможно.
 */

import { useCallback, useEffect, useState } from "react";
import { adminGet, adminPost } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { AdminReportsPage, AdminUsersPage } from "@/lib/types";

const PAGE_SIZE = 20;
const ROLES = ["USER", "OPERATOR", "ADMIN"] as const;

/** i18n-ключ перевода роли — явный, чтобы TS принимал шаблон. */
function roleKey(role: string): "admin.roles.user" | "admin.roles.operator" | "admin.roles.admin" {
  switch (role) {
    case "OPERATOR":
      return "admin.roles.operator";
    case "ADMIN":
      return "admin.roles.admin";
    default:
      return "admin.roles.user";
  }
}

export function AdminUsersBlock() {
  const { markVerified, markInvalid, isAdmin } = useAdminAuth();
  const { t } = useI18n();
  const [page, setPage] = useState<AdminReportsPage | null>(null);
  const [users, setUsers] = useState<AdminUsersPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [roleBusyId, setRoleBusyId] = useState<number | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const loadUsers = useCallback(() => {
    adminGet<AdminUsersPage>("/users", { limit: PAGE_SIZE })
      .then((data) => {
        setUsers(data);
        setRoleError(null);
      })
      .catch((err: unknown) => {
        setRoleError(err instanceof ApiError ? err.message : t("admin.loadError"));
      });
  }, [t]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const load = useCallback(() => {
    setLoading(true);
    adminGet<AdminReportsPage>("/reports", { limit: PAGE_SIZE, offset })
      .then((data) => {
        setPage(data);
        setError(null);
        markVerified();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) markInvalid(err.message);
        setError(err instanceof ApiError ? err.message : t("admin.loadError"));
      })
      .finally(() => setLoading(false));
  }, [offset, markVerified, markInvalid, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleBlock(userId: number, blocked: boolean) {
    setBusyUserId(userId);
    try {
      await adminPost(`/users/${userId}/block`, { blocked });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : t("admin.loadError"));
    } finally {
      setBusyUserId(null);
    }
  }

  async function blockManualId() {
    const id = Number(manualId);
    if (!Number.isFinite(id) || id <= 0) {
      setManualError(t("admin.users.invalidId"));
      return;
    }
    setManualBusy(true);
    setManualError(null);
    try {
      await adminPost(`/users/${id}/block`, { blocked: true });
      setManualId("");
      load();
    } catch (err) {
      setManualError(err instanceof ApiError ? `${err.status}: ${err.message}` : t("admin.loadError"));
    } finally {
      setManualBusy(false);
    }
  }

  async function changeRole(userId: number, role: string) {
    setRoleBusyId(userId);
    setRoleError(null);
    try {
      await adminPost(`/users/${userId}/role`, { role });
      loadUsers();
    } catch (err) {
      setRoleError(err instanceof ApiError ? err.message : t("admin.loadError"));
      loadUsers(); // откат селекта к фактическому значению
    } finally {
      setRoleBusyId(null);
    }
  }

  return (
    <div className="p-4">
      <h2 className="mb-1 text-lg font-semibold">{t("admin.users.title")}</h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t("admin.users.reportsHint")}</p>

      <div className="mb-6">
        <h3 className="mb-2 text-sm font-medium">{t("admin.roles.title")}</h3>
        {roleError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{roleError}</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3">{t("admin.users.col.id")}</th>
                <th className="py-2 pr-3">{t("admin.users.col.user")}</th>
                <th className="py-2 pr-3">{t("admin.roles.col.role")}</th>
                <th className="py-2 pr-3">{t("admin.users.col.action")}</th>
              </tr>
            </thead>
            <tbody>
              {(users?.items ?? []).map((u) => (
                <tr key={u.id} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-3 text-gray-400">{u.id}</td>
                  <td className="py-2 pr-3">
                    {u.email || (u.telegram_id ? `telegram:${u.telegram_id}` : u.display_name || "—")}
                    {u.is_blocked && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-400">
                        {t("admin.users.blockedBadge")}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {isAdmin ? (
                      <select
                        aria-label={t("admin.roles.col.role")}
                        value={u.role}
                        disabled={roleBusyId === u.id}
                        onChange={(e) => changeRole(u.id, e.target.value)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-sm disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800"
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(roleKey(role))}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-gray-500 dark:text-gray-400">
                        {t(roleKey(u.role))}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-gray-400">{roleBusyId === u.id ? t("admin.roles.saving") : "—"}</td>
                </tr>
              ))}
              {users?.items.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-gray-400">
                    —
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t("admin.roles.hint")}</p>
      </div>

      {loading && !page ? (
        <p className="text-sm text-gray-400">{t("loading")}</p>
      ) : error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                  <th className="py-2 pr-3">{t("admin.users.col.id")}</th>
                  <th className="py-2 pr-3">{t("admin.users.col.user")}</th>
                  <th className="py-2 pr-3">{t("admin.users.col.reliability")}</th>
                  <th className="py-2 pr-3">{t("admin.users.col.station")}</th>
                  <th className="py-2 pr-3">{t("admin.users.col.gps")}</th>
                  <th className="py-2 pr-3">{t("admin.users.col.when")}</th>
                  <th className="py-2 pr-3">{t("admin.users.col.action")}</th>
                </tr>
              </thead>
              <tbody>
                {(page?.items ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-3 text-gray-400">{r.id}</td>
                    <td className="py-2 pr-3">
                      #{r.user_id}
                      {r.user_is_blocked && (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-400">
                          {t("admin.users.blockedBadge")}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {r.user_reliability_score === null ? "—" : Math.round(r.user_reliability_score * 100) + "%"}
                    </td>
                    <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{r.station_id ?? "—"}</td>
                    <td className="py-2 pr-3">{r.gps_confirmed ? "✓" : "—"}</td>
                    <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{formatUpdatedAt(r.created_at)}</td>
                    <td className="py-2 pr-3">
                      {isAdmin && (
                      <button
                        type="button"
                        onClick={() => toggleBlock(r.user_id, !r.user_is_blocked)}
                        disabled={busyUserId === r.user_id}
                        className={
                          r.user_is_blocked
                            ? "rounded-md border border-gray-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-gray-700"
                            : "rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        }
                      >
                        {busyUserId === r.user_id
                          ? t("admin.users.blocking")
                          : r.user_is_blocked
                            ? t("admin.users.unblock")
                            : t("admin.users.block")}
                      </button>
                    )}
                    </td>
                  </tr>
                ))}
                {page?.items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-gray-400">
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-md border border-gray-300 px-2 py-1 disabled:opacity-40 dark:border-gray-700"
            >
              {t("admin.log.prevPage")}
            </button>
            <span className="text-gray-400">{t("admin.log.total")}: {page?.total ?? 0}</span>
            <button
              type="button"
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={!page || offset + PAGE_SIZE >= page.total}
              className="rounded-md border border-gray-300 px-2 py-1 disabled:opacity-40 dark:border-gray-700"
            >
              {t("admin.log.nextPage")}
            </button>
          </div>
        </>
      )}

      {isAdmin && (
        <div className="mt-6 border-t border-gray-100 pt-4 dark:border-gray-800">
          <h3 className="mb-2 text-sm font-medium">{t("admin.users.manualBlock")}</h3>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              placeholder={t("admin.users.idPlaceholder")}
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              className="w-40 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
            <button
              type="button"
              onClick={blockManualId}
              disabled={manualBusy || !manualId}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {manualBusy ? t("admin.users.blocking") : t("admin.users.block")}
            </button>
          </div>
          {manualError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{manualError}</p>}
        </div>
      )}
    </div>
  );
}
