"use client";

/**
 * Счётчик непрочитанных уведомлений (A03/§16.1 №8). Эндпоинт `GET /notifications`
 * строит параллельный таск T07 — на момент сборки T09 он может быть ещё не готов
 * или отличаться по форме ответа. Счётчик обязан быть отказоустойчивым: любая
 * ошибка (404/500/сеть) — просто 0/скрытый бейдж, а не падение экрана.
 */

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";

interface NotificationsState {
  unreadCount: number;
  available: boolean;
  markRead: () => void;
}

export function extractUnreadCount(data: unknown): number {
  if (Array.isArray(data)) {
    return data.filter((item) => item && typeof item === "object" && !(item as { read?: boolean }).read).length;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.unread_count === "number") return obj.unread_count;
    if (typeof obj.unread === "number") return obj.unread;
    if (Array.isArray(obj.items)) return extractUnreadCount(obj.items);
  }
  return 0;
}

export function useNotifications(): NotificationsState {
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const [available, setAvailable] = useState(true);

  const load = useCallback(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    apiGet<unknown>("/notifications")
      .then((data) => {
        setAvailable(true);
        setUnreadCount(extractUnreadCount(data));
      })
      .catch(() => {
        // T07 может быть ещё не развёрнут — не ломаем шапку, просто без бейджа
        setAvailable(false);
        setUnreadCount(0);
      });
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = useCallback(() => {
    apiPost("/notifications/read")
      .then(() => setUnreadCount(0))
      .catch(() => {
        /* нет эндпоинта — сбрасываем локально, не мешаем пользователю */
        setUnreadCount(0);
      });
  }, []);

  return { unreadCount, available, markRead };
}
