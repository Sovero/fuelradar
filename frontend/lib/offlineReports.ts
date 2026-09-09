/**
 * Офлайн-очередь отправки отчётов (R39.2/R05.3): если `POST /reports` не
 * удался из-за сети — отчёт сохраняется на устройстве и повторно отправляется
 * при восстановлении соединения (`online`). Простая очередь без sync-менеджера
 * (см. бриф задачи — "без сложного sync-менеджера").
 */

import { apiPost, ApiError } from "@/lib/api";
import type { ReportBody, ReportOut } from "@/lib/types";

const STORAGE_KEY = "fr_offline_reports";

export interface QueuedReport {
  /** Локальный идентификатор записи очереди (не путать с идемпотентным ключом отчёта). */
  queueId: string;
  body: ReportBody;
  queuedAt: string;
}

function readQueue(): QueuedReport[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedReport[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedReport[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage переполнен/недоступен — отчёт теряется молча, это не критичная функция
  }
}

export function listOfflineReports(): QueuedReport[] {
  return readQueue();
}

export function enqueueOfflineReport(body: ReportBody): QueuedReport {
  const entry: QueuedReport = {
    queueId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `q-${Date.now()}-${Math.random()}`,
    body,
    queuedAt: new Date().toISOString(),
  };
  const queue = readQueue();
  queue.push(entry);
  writeQueue(queue);
  return entry;
}

export function removeOfflineReport(queueId: string): void {
  writeQueue(readQueue().filter((q) => q.queueId !== queueId));
}

/** Сеть недоступна — по признаку `ApiError.status === 0` из lib/api.ts (см. request()). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}

export interface FlushResult {
  sent: number;
  remaining: number;
  failed: number;
}

/** Ошибки, из-за которых повтор бессмысленен (данные отчёта отклонены сервером). */
function isPermanentRejection(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 422);
}

/**
 * Повторно отправляет очередь. В очереди остаётся всё, что не удалось
 * подтвердить как окончательный отказ: сеть недоступна (status 0), сессия
 * истекла (401/403 — может восстановиться после повторного входа), сервер
 * перегружен (429/5xx). Удаляются из очереди только успешные отправки и
 * записи, которые сервер отклонил как невалидные (404/422) — повторять их
 * бессмысленно.
 */
export async function flushOfflineReports(): Promise<FlushResult> {
  const queue = readQueue();
  let sent = 0;
  let failed = 0;
  const remaining: QueuedReport[] = [];
  for (const entry of queue) {
    try {
      await apiPost<ReportOut>("/reports", entry.body);
      sent += 1;
    } catch (err) {
      if (isPermanentRejection(err)) {
        failed += 1;
      } else {
        remaining.push(entry);
      }
    }
  }
  writeQueue(remaining);
  return { sent, remaining: remaining.length, failed };
}
