"use client";

import { useState } from "react";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useI18n } from "@/lib/hooks/useI18n";
import { NotificationsPanel } from "@/components/layout/NotificationsPanel";

/** 🔔 со счётчиком непрочитанных (A03/§16.1 №8) — открывает полную ленту уведомлений. */
export function NotificationBell() {
  const { unreadCount } = useNotifications();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unreadCount > 0 ? `${t("header.notifications")}: ${unreadCount}` : t("header.notifications")}
        className="relative rounded-full p-2 text-xl hover:bg-black/5 dark:hover:bg-white/10"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && <NotificationsPanel onClose={() => setOpen(false)} />}
    </>
  );
}
