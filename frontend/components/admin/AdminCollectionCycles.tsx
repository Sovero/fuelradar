"use client";

/**
 * Журнал циклов сбора (R58): по каждому источнику — время последнего успешного
 * сбора, следующий запуск и причина сбоя; сверху — состояние планировщика
 * (`GET /admin/collection-cycles`).
 *
 * Вид отвечает на вопрос «сбор вообще идёт?», которого не видно ни в снимке
 * health (`/sources`), ни в истории запусков (`/collection-log`): там есть
 * факты, но нет ни «последний успех», ни «следующий тик», ни режима сборщика.
 *
 * Вкладка живая: журнал перезапрашивается сам с периодом, который оператор задаёт
 * полем «живое обновление» (по умолчанию 60 с), до следующего тика идёт обратный
 * отсчёт, а источник, у которого цикл идёт прямо сейчас, подсвечен. Отсчёт
 * считается по серверным часам
 * (ответ несёт `now`) — часы браузера могут уходить на минуты. Ни одно время
 * не выдумывается: нет плана — так и написано, обновить не удалось — на экране
 * остаются прошлые данные с честной пометкой.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { adminGet } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt, formatUtcDateTime } from "@/lib/format";
import { useCyclesRefresh } from "@/lib/hooks/useCyclesRefresh";
import {
  CYCLES_CLOCK_MS,
  REFRESH_SECONDS_MAX,
  REFRESH_SECONDS_MIN,
  countdownMs,
  durationParts,
  normalizeRefreshSeconds,
  runningMs,
  serverClockSkewMs,
} from "@/lib/collectionCycles";
import { ApiError } from "@/lib/api";
import type { CollectionCycleSource, CollectionCyclesOut } from "@/lib/types";

const HEALTH_COLOR: Record<string, string> = {
  ONLINE: "text-emerald-700 dark:text-emerald-400",
  DEGRADED: "text-amber-700 dark:text-amber-400",
  RATE_LIMITED: "text-amber-700 dark:text-amber-400",
  AUTH_ERROR: "text-red-700 dark:text-red-400",
  OFFLINE: "text-red-700 dark:text-red-400",
  UNKNOWN: "text-gray-400",
};

function Cell({ at, fallback }: { at: string | null; fallback: string }) {
  if (!at) return <span className="text-gray-400">{fallback}</span>;
  return <span title={formatUtcDateTime(at) ?? undefined}>{formatUpdatedAt(at)}</span>;
}

/** Точка «цикл идёт сейчас»: цветная и пульсирующая, но не единственный носитель смысла — рядом текст. */
function RunningDot() {
  return (
    <span className="relative flex h-2 w-2" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-600" />
    </span>
  );
}

export function AdminCollectionCycles() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [data, setData] = useState<CollectionCyclesOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [loadedAtMs, setLoadedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [skewMs, setSkewMs] = useState(0);
  const { seconds: refreshSeconds, setSeconds: setRefreshSeconds } = useCyclesRefresh();
  // В поле — до ввода оператора; применяется по Enter/blur, а не на каждой цифре,
  // чтобы период не менялся трижды, пока набирают «600».
  const [refreshDraft, setRefreshDraft] = useState(String(refreshSeconds));
  const inFlightRef = useRef(false);
  const hasDataRef = useRef(false);

  useEffect(() => {
    setRefreshDraft(String(refreshSeconds));
  }, [refreshSeconds]);

  const commitRefresh = useCallback(() => {
    const next = normalizeRefreshSeconds(refreshDraft);
    setRefreshSeconds(next);
    // В поле показываем то, что реально действует: мусор и выход за границы
    // честно нормализуются, а не остаются на экране невыполненным обещанием.
    setRefreshDraft(String(next));
  }, [refreshDraft, setRefreshSeconds]);

  const load = useCallback(
    (silent = false) => {
      if (inFlightRef.current) return; // фоновый опрос не наслаивается на предыдущий
      inFlightRef.current = true;
      if (!silent) setLoading(true);
      adminGet<CollectionCyclesOut>("/collection-cycles")
        .then((body) => {
          setData(body);
          hasDataRef.current = true;
          setError(null);
          setStale(false);
          // Смещение часов считаем на каждом ответе: сервер диктует отсчёт, а не браузер.
          setSkewMs(serverClockSkewMs(body.now, Date.now()));
          setLoadedAtMs(Date.now());
          markVerified();
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) markInvalid(err.message);
          // Сбой фонового опроса не стирает уже показанный журнал и не выдумывает
          // состояние сбора — только честная пометка «обновить не удалось».
          if (silent && hasDataRef.current) {
            setStale(true);
          } else {
            setError(err instanceof ApiError ? err.message : t("admin.loadError"));
          }
        })
        .finally(() => {
          inFlightRef.current = false;
          setLoading(false);
        });
    },
    [markVerified, markInvalid, t],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Секундные часы: «через N с» и «идёт N мин» меняются на глазах, без перезапроса журнала.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CYCLES_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  // Автообновление с периодом из поля. Скрытое окно не опрашиваем — невидимый
  // экран не нуждается в свежести, — но при возвращении обновляем сразу, чтобы
  // оператор не смотрел на устаревший журнал.
  const refreshMs = refreshSeconds * 1000;
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(true);
    }, refreshMs);
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) load(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, refreshMs]);

  if (loading && !data) return <p className="p-4 text-sm text-gray-400">{t("loading")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return null;

  const { scheduler } = data;
  /** «Сейчас» по часам сервера: отсчёт не должен зависеть от часов браузера. */
  const serverNowMs = nowMs + skewMs;
  const updatedSeconds = loadedAtMs === null ? null : Math.max(0, Math.round((nowMs - loadedAtMs) / 1000));
  const updatedLabel =
    updatedSeconds === null
      ? null
      : updatedSeconds < 2
        ? t("admin.cycles.updatedNow")
        : t("admin.cycles.updatedAgo").replace("{seconds}", String(updatedSeconds));

  const modeLabel =
    scheduler.mode === "in_process"
      ? t("admin.cycles.mode.inProcess").replace("{seconds}", String(scheduler.tick_seconds))
      : scheduler.mode === "off"
        ? t("admin.cycles.mode.off").replace("{reason}", scheduler.reason)
        : t("admin.cycles.mode.external");

  /** Отсчёт до момента: секунды в последнюю минуту, дальше минуты/часы, прошедшее — pastLabel. */
  function countdownLabel(iso: string, pastLabel: string): string {
    const ms = countdownMs(iso, serverNowMs);
    if (ms === null) return t("admin.cycles.noPlan");
    if (ms <= 0) return pastLabel;
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 60) return t("admin.cycles.inSeconds").replace("{seconds}", String(seconds));
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return t("admin.cycles.inMinutes").replace("{minutes}", String(minutes));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) {
      const key = rest ? "admin.cycles.inHours" : "admin.cycles.inHoursExact";
      return t(key).replace("{hours}", String(hours)).replace("{minutes}", String(rest));
    }
    return formatUtcDateTime(iso) ?? pastLabel;
  }

  /**
   * «Следующий запуск» — время в будущем, поэтому «через N мин», а не «N мин назад».
   * Прошедший план — это «просрочено»: задание ждёт ближайшего тика сборщика,
   * и обещать «вот-вот» на план недельной давности было бы неправдой.
   */
  function whenLabel(iso: string): string {
    return countdownLabel(iso, t("admin.cycles.overdue"));
  }

  /**
   * Тик — план процесса, а не гарантия: загрузка может сдвинуть его на секунды.
   * Поэтому прошедший на минуту тик — «сейчас» (сборщик вот-вот вернётся),
   * а просроченный надолго — честное «просрочено», как и у плана источника.
   */
  function tickLabel(iso: string): string {
    const ms = countdownMs(iso, serverNowMs);
    if (ms === null) return t("admin.cycles.tickNever");
    if (ms <= 0) return ms > -60_000 ? t("admin.cycles.tickNow") : t("admin.cycles.overdue");
    return countdownLabel(iso, t("admin.cycles.tickNow"));
  }

  /** «идёт сейчас · 12 с · задание №7 · заданий: 2» — только факты из ответа. */
  function runningChip(source: CollectionCycleSource): string {
    const ms = runningMs(source.running_since, serverNowMs);
    const parts: string[] = [];
    if (ms === null) {
      parts.push(t("admin.cycles.runningNow"));
    } else {
      const duration = durationParts(ms);
      const label =
        duration.unit === "seconds"
          ? t("admin.cycles.durationSeconds").replace("{seconds}", String(duration.seconds))
          : duration.unit === "minutes"
            ? t("admin.cycles.durationMinutes").replace("{minutes}", String(duration.minutes))
            : t("admin.cycles.durationHours")
                .replace("{hours}", String(duration.hours))
                .replace("{minutes}", String(duration.minutes));
      parts.push(t("admin.cycles.runningFor").replace("{duration}", label));
    }
    if (source.running_job_id !== null) {
      parts.push(t("admin.cycles.runningJob").replace("{id}", String(source.running_job_id)));
    }
    if (source.running_jobs > 1) {
      parts.push(t("admin.cycles.runningCount").replace("{count}", String(source.running_jobs)));
    }
    return parts.join(" · ");
  }

  function nextRun(source: CollectionCycleSource) {
    if (!source.collectable) {
      // user_reports — push-источник (отчёты с устройств), остальное просто не активно:
      // одна фраза на оба случая была бы неправдой для одного из них.
      const key = source.code === "user_reports" ? "admin.cycles.deviceReports" : "admin.cycles.inactive";
      return <span className="text-gray-400">{t(key)}</span>;
    }
    if (source.waiting_reason) {
      // Источник включён, но данных ещё нет (файл не загружен, URL не задан):
      // планировать нечего, и это не сбой — «ждёт данных» с причиной в подсказке.
      return (
        <span className="text-amber-700 dark:text-amber-400" title={source.waiting_reason}>
          {t("admin.cycles.waiting")}
        </span>
      );
    }
    if (!source.next_run_at) return <span className="text-gray-400">{t("admin.cycles.noPlan")}</span>;
    return (
      <>
        <span className="tabular-nums" title={formatUtcDateTime(source.next_run_at) ?? undefined}>
          {whenLabel(source.next_run_at)}
        </span>
        {/* «В очереди» — только про PENDING: у идущего задания это была бы неправда. */}
        {source.queued_job_id !== null && source.active_job_status === "PENDING" && (
          <> · {t("admin.cycles.queued").replace("{id}", String(source.queued_job_id))}</>
        )}
      </>
    );
  }

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t("admin.cycles.title")}</h2>
        <label className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          <RunningDot />
          <span>{t("admin.cycles.live")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={REFRESH_SECONDS_MIN}
            max={REFRESH_SECONDS_MAX}
            step={5}
            value={refreshDraft}
            onChange={(event) => setRefreshDraft(event.target.value)}
            onBlur={commitRefresh}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRefresh();
            }}
            aria-label={t("admin.cycles.refreshEvery")
              .replace("{min}", String(REFRESH_SECONDS_MIN))
              .replace("{max}", String(REFRESH_SECONDS_MAX))}
            data-testid="refresh-seconds"
            className="w-14 rounded border border-gray-300 bg-white px-1 py-0 text-center text-xs tabular-nums text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
          />
          <span>{t("admin.cycles.secondsShort")}</span>
        </label>
        <button
          type="button"
          onClick={() => load(false)}
          disabled={loading}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          {t("admin.cycles.refresh")}
        </button>
        {updatedLabel && (
          <span className="text-xs text-gray-400" data-testid="cycles-updated-at">
            {updatedLabel}
          </span>
        )}
      </div>
      <p className="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">{t("admin.cycles.subtitle")}</p>
      <p className="mt-1 max-w-3xl text-xs text-gray-400">{t("admin.cycles.liveNote")}</p>

      {stale && updatedSeconds !== null && (
        <p
          role="status"
          className="mt-2 max-w-3xl rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          {t("admin.cycles.staleWarning").replace("{seconds}", String(updatedSeconds))}
        </p>
      )}

      <section className="mt-4 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
        <h3 className="text-sm font-semibold uppercase text-gray-500 dark:text-gray-400">
          {t("admin.cycles.schedulerTitle")}
        </h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-gray-400">{t("admin.cycles.mode")}</dt>
            <dd className="font-medium">{modeLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">{t("admin.cycles.queue")}</dt>
            <dd className="font-medium">
              {t("admin.cycles.queuePending").replace("{pending}", String(scheduler.pending_jobs))}
              {" · "}
              {t("admin.cycles.queueRunning").replace("{running}", String(scheduler.running_jobs))}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">{t("admin.cycles.lastTick")}</dt>
            <dd className="font-medium">
              <Cell at={scheduler.last_tick_at} fallback={t("admin.cycles.tickNever")} />
              {scheduler.last_tick_status && scheduler.last_tick_status !== "idle" && (
                <span className="ml-1 text-xs text-gray-400">({scheduler.last_tick_status})</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">{t("admin.cycles.nextTick")}</dt>
            <dd className="font-medium tabular-nums" data-testid="next-tick">
              {scheduler.mode !== "in_process" ? (
                <span className="text-gray-400">{t("admin.cycles.tickUnavailable")}</span>
              ) : scheduler.next_tick_at ? (
                <span title={formatUtcDateTime(scheduler.next_tick_at) ?? undefined}>
                  {tickLabel(scheduler.next_tick_at)}
                </span>
              ) : (
                <span className="text-gray-400">{t("admin.cycles.tickNever")}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">{t("admin.cycles.tickSeconds")}</dt>
            <dd className="font-medium">{t("admin.cycles.seconds").replace("{seconds}", String(scheduler.tick_seconds))}</dd>
          </div>
        </dl>
      </section>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
              <th className="py-2 pr-3">{t("admin.cycles.col.source")}</th>
              <th className="py-2 pr-3">{t("admin.cycles.col.health")}</th>
              <th className="py-2 pr-3">{t("admin.cycles.col.lastSuccess")}</th>
              <th className="py-2 pr-3">{t("admin.cycles.col.nextRun")}</th>
              <th className="py-2 pr-3">{t("admin.cycles.col.lastCycle")}</th>
              <th className="py-2 pr-3">{t("admin.cycles.col.failure")}</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((source) => {
              const running = source.running_jobs > 0;
              return (
                <tr
                  key={source.id}
                  data-running={running ? "true" : undefined}
                  className={`border-b border-gray-100 dark:border-gray-800 ${
                    running ? "bg-emerald-50/70 dark:bg-emerald-950/30" : ""
                  }`}
                >
                  <td className="py-2 pr-3">
                    <p className="flex items-center gap-2 font-medium text-gray-800 dark:text-gray-200">
                      {running && <RunningDot />}
                      {source.name}
                    </p>
                    <p className="text-xs text-gray-400">
                      {source.code} · {source.status} · {t("admin.cycles.interval").replace("{minutes}", String(source.min_interval_minutes))}
                    </p>
                    {running && (
                      <p className="mt-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        {runningChip(source)}
                      </p>
                    )}
                  </td>
                  <td className={`py-2 pr-3 font-medium ${HEALTH_COLOR[source.health] ?? "text-gray-500"}`}>{source.health}</td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                    <Cell at={source.last_success_at} fallback={t("admin.cycles.neverSuccess")} />
                  </td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{nextRun(source)}</td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                    {source.last_job ? (
                      <span title={formatUtcDateTime(source.last_job.finished_at) ?? undefined}>
                        <span className={source.last_job.status === "FAILED" ? "text-red-700 dark:text-red-400" : ""}>
                          {source.last_job.status}
                        </span>
                        {" · "}
                        {t("admin.cycles.records").replace("{count}", String(source.last_job.records_count))}
                        {" · "}
                        {source.last_job.trigger}
                        {source.last_job.finished_at ? <> · {formatUpdatedAt(source.last_job.finished_at)}</> : null}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {source.consecutive_failures > 0 ? (
                      <span className="text-red-700 dark:text-red-400" title={source.last_error}>
                        {t("admin.cycles.failures")
                          .replace("{count}", String(source.consecutive_failures))
                          .replace("{error}", source.last_error || t("admin.sources.errorUnknown"))}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
