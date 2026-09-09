"use client";

/** Полная лента уведомлений (A03, §13 №10) — список + «отметить всё прочитанным». */

import { useI18n } from "@/lib/hooks/useI18n";
import { useMeta } from "@/lib/hooks/useMeta";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { formatUpdatedAt } from "@/lib/format";
import type { NotificationItem } from "@/lib/types";
import type { TranslationKey } from "@/lib/i18n";

const EVENT_LABELS: Record<string, TranslationKey> = {
  FUEL_APPEARED: "notifications.event.fuelAppeared",
  FUEL_DISAPPEARED: "notifications.event.fuelDisappeared",
  FUEL_LOW: "notifications.event.fuelLow",
  QUEUE_INCREASED: "notifications.event.queueIncreased",
  QUEUE_DECREASED: "notifications.event.queueDecreased",
  CONFIDENCE_INCREASED: "notifications.event.confidenceIncreased",
  STATION_NEW: "notifications.event.stationNew",
};

function NotificationRow({ item }: { item: NotificationItem }) {
  const { t } = useI18n();
  const { fuelLabel } = useMeta();
  const labelKey = EVENT_LABELS[item.event_type];
  return (
    <li className={`border-b border-gray-100 px-4 py-3 dark:border-gray-800 ${item.delivered ? "" : "bg-blue-50/60 dark:bg-blue-950/30"}`}>
      <p className="text-sm text-gray-800 dark:text-gray-200">
        {labelKey ? t(labelKey) : item.event_type}
        {item.fuel_code ? ` · ${fuelLabel(item.fuel_code)}` : ""}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">{item.station_name}</p>
      <p className="text-xs text-gray-400 dark:text-gray-500">{formatUpdatedAt(item.created_at)}</p>
    </li>
  );
}

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { t, tt } = useI18n();
  const { items, unreadCount, loading, available, markRead } = useNotifications();

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/40 p-4 sm:items-start" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-lg bg-white shadow-xl dark:bg-gray-900 dark:text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <h2 className="text-lg font-semibold">{t("notifications.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("login.close")} className="rounded-full p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
            ✕
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            {unreadCount > 0 ? tt("notifications.unread", { count: unreadCount }) : t("notifications.allRead")}
          </span>
          <button
            type="button"
            onClick={() => markRead()}
            disabled={unreadCount === 0}
            className="text-emerald-700 hover:underline disabled:text-gray-300 disabled:no-underline dark:text-emerald-400 dark:disabled:text-gray-600"
          >
            {t("notifications.markAllRead")}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && <p className="px-4 py-3 text-sm text-gray-400">{t("loading")}</p>}
          {!loading && !available && <p className="px-4 py-3 text-sm text-gray-400">{t("notifications.unavailable")}</p>}
          {!loading && available && items.length === 0 && <p className="px-4 py-3 text-sm text-gray-400">{t("notifications.empty")}</p>}
          {!loading && items.length > 0 && (
            <ul>
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
