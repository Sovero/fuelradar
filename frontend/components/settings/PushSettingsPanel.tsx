"use client";

/**
 * Push-уведомления браузера (T14, R64/R97i): подписка/отписка.
 *
 * Честность состояния (R97i):
 * - `/meta` не отдал `push.enabled` (нет VAPID-ключей на сервере) → панель
 *   честно пишет «не настроено» и не предлагает кнопку, которая не сработает;
 * - браузер без Notification/PushManager (например, iOS до 16.4 или desktop-
 *   оболочка, где push не поддержан) → «недоступно в этом браузере»;
 * - отказ в разрешении → «заблокировано в настройках браузера»;
 * - приложение открытое (профилей нет): доступность push определяется только
 *   настройкой сервера (VAPID), поддержкой браузера и выданным разрешением.
 */

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { pushSupport, urlBase64ToUint8Array } from "@/lib/push";
import { isDesktopShell } from "@/lib/desktop";
import { useMeta } from "@/lib/hooks/useMeta";
import { useI18n } from "@/lib/hooks/useI18n";

interface PushSubscriptionView {
  id: number;
  endpoint: string;
  endpoint_host: string;
  is_active: boolean;
  created_at: string;
  last_success_at: string | null;
}

export function PushSettingsPanel() {
  const { meta } = useMeta();
  const { t } = useI18n();
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionView[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pushEnabled = meta?.push?.enabled === true;
  const vapidKey = meta?.push?.vapid_public_key ?? null;
  // В desktop-оболочке service worker не регистрируется (ServiceWorkerRegister) —
  // подписка технически невозможна: честное состояние вместо нерабочей кнопки (R97i).
  const support = isDesktopShell() ? "unsupported" : pushSupport();

  const reload = useCallback(() => {
    apiGet<PushSubscriptionView[]>("/push/subscriptions")
      .then(setSubscriptions)
      .catch(() => setSubscriptions([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function subscribe() {
    setBusy(true);
    setStatus(null);
    try {
      if (!vapidKey) {
        setStatus(t("settings.push.notConfigured"));
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey) as unknown as BufferSource,
        }));
      const json = subscription.toJSON();
      await apiPost("/push/subscriptions", {
        endpoint: json.endpoint,
        keys: json.keys,
      });
      setStatus(t("settings.push.subscribed"));
      reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("settings.push.error"));
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe(id: number) {
    setBusy(true);
    try {
      await apiDelete(`/push/subscriptions/${id}`);
      reload();
    } catch {
      setStatus(t("settings.push.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2 className="text-base font-semibold">{t("settings.push.title")}</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("settings.push.description")}</p>
      </header>

      {!pushEnabled && (
        <p className="rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {t("settings.push.notConfigured")}
        </p>
      )}

      {pushEnabled && support === "unsupported" && (
        <p className="rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {t("settings.push.unsupported")}
        </p>
      )}

      {pushEnabled && support === "denied" && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {t("settings.push.denied")}
        </p>
      )}

      {pushEnabled && support === "ok" && (
        <button
          type="button"
          onClick={subscribe}
          disabled={busy}
          className="w-fit rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? t("loading") : t("settings.push.subscribe")}
        </button>
      )}

      {subscriptions.length > 0 && (
        <ul className="flex flex-col gap-2">
          {subscriptions.map((sub) => (
            <li
              key={sub.id}
              className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700"
            >
              <span className="min-w-0 truncate text-gray-700 dark:text-gray-300" title={sub.endpoint_host}>
                {sub.endpoint_host}
                {!sub.is_active && <span className="ml-2 text-xs text-gray-400">{t("settings.push.inactive")}</span>}
              </span>
              <button
                type="button"
                onClick={() => unsubscribe(sub.id)}
                disabled={busy}
                className="shrink-0 text-xs text-red-600 hover:underline dark:text-red-400"
              >
                {t("settings.push.unsubscribe")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {status && <p className="text-sm text-emerald-700 dark:text-emerald-400">{status}</p>}
    </section>
  );
}
