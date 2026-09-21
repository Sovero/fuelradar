"use client";

/**
 * Подписка на сводку в Telegram (R64): токен бота, чат и интервал рассылки.
 *
 * Честность состояния (R97i):
 * - нет токена/чата или интервал 0 → канал выключен, панель пишет об этом;
 * - токен хранится на сервере и наружу не отдаётся (R68) — API показывает
 *   только отпечаток, чтобы оператор узнавал, какой токен в работе;
 * - «Определить чат» работает, только если боту уже написали в Telegram —
 *   иначе честная причина, а не выдуманный id;
 * - «Проверить» отправляет сводку прямо сейчас и показывает результат.
 */

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { useI18n } from "@/lib/hooks/useI18n";

interface TelegramState {
  configured: boolean;
  has_token: boolean;
  token_fingerprint: string;
  token_from_env: boolean;
  chat_id: string | null;
  interval_minutes: number;
  last_sent_at: string | null;
  last_status: string | null;
  next_send_at: string | null;
}

interface DiscoverResult {
  ok: boolean;
  reason: string;
  detail?: string | null;
  state: TelegramState;
}

function fmtDateTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale === "ru" ? "ru-RU" : "en-GB");
}

export function TelegramDigestPanel() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<TelegramState | null>(null);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [interval, setInterval] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await apiGet<TelegramState>("/settings/telegram");
      setState(s);
      setChatId(s.chat_id ?? "");
      setInterval(s.interval_minutes);
    } catch {
      setError(t("telegram.loadError"));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const s = await apiPut<TelegramState>("/settings/telegram", {
        token: token.trim() ? token.trim() : undefined,
        chat_id: chatId.trim() || "",
        interval_minutes: Math.max(0, Math.floor(interval)),
      });
      setState(s);
      setToken("");
      setNotice(t("telegram.saved"));
    } catch {
      setError(t("telegram.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function discover() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await apiPost<DiscoverResult>("/settings/telegram/discover");
      setState(r.state);
      setChatId(r.state.chat_id ?? "");
      if (r.ok) {
        setNotice(t("telegram.chatFound"));
      } else {
        // Причина приходит с сервера в понятном тексте (detail); ключ — запасной.
        setError(r.detail ?? t("telegram.testFailed"));
      }
    } catch {
      setError(t("telegram.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await apiPost<DiscoverResult & { ok: boolean; reason: string; detail?: string | null }>(
        "/settings/telegram/test",
      );
      setState(r.state);
      if (r.ok) {
        setNotice(t("telegram.testSent"));
      } else {
        setError(r.detail ?? t("telegram.testFailed"));
      }
    } catch {
      setError(t("telegram.testFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return <p className="p-4 text-sm text-gray-400">{error ?? t("loading")}</p>;
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t("telegram.description")}</p>

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-2 flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${state.configured ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"}`}
          />
          <span className="text-sm font-medium">
            {state.configured ? t("telegram.enabled") : t("telegram.disabled")}
          </span>
        </div>
        <dl className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
          <div className="flex justify-between gap-2">
            <dt>{t("telegram.tokenStatus")}</dt>
            <dd className="text-right">
              {state.has_token ? (
                <>
                  <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{state.token_fingerprint}</code>
                  {state.token_from_env && <span className="ml-1 text-xs text-gray-400">({t("telegram.fromEnv")})</span>}
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>{t("telegram.chat")}</dt>
            <dd>{state.chat_id ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>{t("telegram.interval")}</dt>
            <dd>{state.interval_minutes > 0 ? `${state.interval_minutes} ${t("telegram.minutes")}` : "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>{t("telegram.lastSent")}</dt>
            <dd>
              {fmtDateTime(state.last_sent_at, locale)}
              {state.last_status && state.last_status !== "sent" && ` (${state.last_status})`}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>{t("telegram.nextSend")}</dt>
            <dd>{fmtDateTime(state.next_send_at, locale)}</dd>
          </div>
        </dl>
      </div>

      <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("telegram.tokenLabel")}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={state.has_token ? t("telegram.tokenPlaceholder") : "123456:ABC-DEF…"}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            autoComplete="off"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("telegram.chatLabel")}</span>
          <div className="flex gap-2">
            <input
              type="text"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="123456789"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            />
            <button
              type="button"
              onClick={discover}
              disabled={busy}
              className="whitespace-nowrap rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {t("telegram.discoverChat")}
            </button>
          </div>
          <span className="mt-1 block text-xs text-gray-400">{t("telegram.discoverHint")}</span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("telegram.intervalLabel")}</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={10080}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
              className="w-28 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            />
            <span className="text-sm text-gray-500">{t("telegram.minutes")}</span>
          </div>
          <span className="mt-1 block text-xs text-gray-400">{t("telegram.intervalHint")}</span>
        </label>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {t("telegram.save")}
          </button>
          <button
            type="button"
            onClick={sendTest}
            disabled={busy || !state.configured}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            {t("telegram.test")}
          </button>
        </div>
      </div>

      {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
