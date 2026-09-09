"use client";

/**
 * Лента уведомлений + счётчик непрочитанных (A03/§16.1 №8, §13 №10). Читает
 * `GET /notifications` (T07). Отказоустойчиво: любая ошибка (404/500/сеть) —
 * просто 0/скрытый бейдж и пустая лента, а не падение экрана.
 */

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import type { NotificationItem, NotificationsPage } from "@/lib/types";

interface NotificationsState {
  items: NotificationItem[];
  unreadCount: number;
  available: boolean;
  loading: boolean;
  refresh: () => void;
  /** Без ids — отмечает прочитанными все текущие непрочитанные (см. backend/app/alerts/router.py). */
  markRead: (ids?: number[]) => void;
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

function extractItems(data: unknown): NotificationItem[] {
  if (Array.isArray(data)) return data as NotificationItem[];
  if (data && typeof data === "object" && Array.isArray((data as NotificationsPage).items)) {
    return (data as NotificationsPage).items;
  }
  return [];
}

export function useNotifications(): NotificationsState {
  const { user } = useAuth();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!user) {
      setItems([]);
      setUnreadCount(0);
      return;
    }
    setLoading(true);
    apiGet<unknown>("/notifications")
      .then((data) => {
        setAvailable(true);
        setItems(extractItems(data));
        setUnreadCount(extractUnreadCount(data));
      })
      .catch(() => {
        // T07 может отвечать иначе/быть недоступен — не ломаем шапку/ленту
        setAvailable(false);
        setItems([]);
        setUnreadCount(0);
      })
      .finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = useCallback(
    (ids?: number[]) => {
      apiPost<{ unread_count?: number }>("/notifications/read", ids && ids.length ? { ids } : undefined)
        .then((res) => {
          if (ids && ids.length) {
            setItems((prev) => prev.map((item) => (ids.includes(item.id) ? { ...item, delivered: true } : item)));
          } else {
            setItems((prev) => prev.map((item) => ({ ...item, delivered: true })));
          }
          setUnreadCount(typeof res?.unread_count === "number" ? res.unread_count : 0);
        })
        .catch(() => {
          // нет эндпоинта/сеть — сбрасываем локально, не мешаем пользователю
          setUnreadCount(0);
        });
    },
    [],
  );

  return { items, unreadCount, available, loading, refresh: load, markRead };
}
