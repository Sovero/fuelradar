/**
 * Живая вкладка «Циклы сбора»: арифметика обратного отсчёта без React и DOM.
 *
 * Все значения — планы самого backend (`next_tick_at`, `next_run_at`), поэтому
 * отсчёт считается от серверных часов, а не от клиентских: ответ несёт поле `now`,
 * и по нему вычисляется смещение часов браузера. Иначе на машине со сбитым
 * временем отсчёт показывал бы «через 3 часа» вместо «через 10 с» — и оператор
 * поверил бы числу, которого сбор не обещал.
 */

import { parseUtcIso } from "@/lib/format";

/**
 * Период автообновления вкладки задаёт оператор (поле «живое обновление»),
 * дефолт — 60 с. Границы — не вкус, а защита от двух крайностей: запрос каждую
 * секунду превратил бы админку в поток запросов, а период в часы — в мёртвый
 * экран, который молча показывает вчерашний журнал.
 */
export const REFRESH_SECONDS_DEFAULT = 60;
export const REFRESH_SECONDS_MIN = 5;
export const REFRESH_SECONDS_MAX = 60 * 60;

/** Локальный такт часов: секунда — достаточная точность для «через N с» и «идёт N мин». */
export const CYCLES_CLOCK_MS = 1_000;

/** Смещение часов клиента относительно сервера (мс): serverNow разобран в клиентской шкале. */
export function serverClockSkewMs(serverNowIso: string | null | undefined, clientNowMs: number): number {
  const at = parseUtcIso(serverNowIso);
  if (!at || !Number.isFinite(clientNowMs)) return 0;
  return at.getTime() - clientNowMs;
}

/** Сколько миллисекунд осталось до момента (отрицательное — момент уже прошёл). */
export function countdownMs(targetIso: string | null | undefined, serverNowMs: number): number | null {
  const at = parseUtcIso(targetIso);
  if (!at) return null;
  return at.getTime() - serverNowMs;
}

/** Сколько длится процесс с момента старта (null — старт неизвестен/битый). */
export function runningMs(startedIso: string | null | undefined, serverNowMs: number): number | null {
  const at = parseUtcIso(startedIso);
  if (!at) return null;
  return Math.max(0, serverNowMs - at.getTime());
}

/**
 * Ввод оператора → период опроса в секундах. Пусто/мусор/ноль — дефолт 60 с (а не
 * «пять секунд», чтобы опечатка в поле не превращалась в частый опрос), число —
 * округляется и зажимается в границы: что реально действует, то и видно в поле.
 */
export function normalizeRefreshSeconds(value: unknown): number {
  if (value === null || value === undefined) return REFRESH_SECONDS_DEFAULT;
  const raw = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(raw) || raw <= 0) return REFRESH_SECONDS_DEFAULT;
  return Math.min(REFRESH_SECONDS_MAX, Math.max(REFRESH_SECONDS_MIN, Math.round(raw)));
}

/** Гранулярность подписи длительности: секунды < 1 мин, минуты < 1 ч, дальше часы и минуты. */
export type DurationParts =
  | { unit: "seconds"; seconds: number }
  | { unit: "minutes"; minutes: number }
  | { unit: "hours"; hours: number; minutes: number };

/** Разложить длительность для подписи — текст собирает компонент (ru/en). */
export function durationParts(ms: number): DurationParts {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return { unit: "seconds", seconds: total };
  const totalMinutes = Math.floor(total / 60);
  if (totalMinutes < 60) return { unit: "minutes", minutes: totalMinutes };
  return { unit: "hours", hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
