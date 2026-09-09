import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueOfflineReport,
  flushOfflineReports,
  listOfflineReports,
  removeOfflineReport,
} from "@/lib/offlineReports";
import type { ReportBody } from "@/lib/types";

const BODY: ReportBody = { station_id: "fr_station_1", fuel: { AI_95: "AVAILABLE" }, idempotency_key: "k1" };

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("offlineReports (R39.2)", () => {
  it("enqueue/list/remove работают на localStorage", () => {
    expect(listOfflineReports()).toEqual([]);
    const entry = enqueueOfflineReport(BODY);
    expect(listOfflineReports()).toHaveLength(1);
    expect(listOfflineReports()[0].body).toEqual(BODY);
    removeOfflineReport(entry.queueId);
    expect(listOfflineReports()).toEqual([]);
  });

  it("flush отправляет очередь и очищает её при успехе", async () => {
    enqueueOfflineReport(BODY);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(201, { id: 1, station_id: "fr_station_1", gps_confirmed: false, distance_to_station_m: null, created: true, created_at: "now" })),
    );
    const result = await flushOfflineReports();
    expect(result).toEqual({ sent: 1, remaining: 0, failed: 0 });
    expect(listOfflineReports()).toEqual([]);
  });

  it("сетевая ошибка (status 0) — запись остаётся в очереди для следующей попытки", async () => {
    enqueueOfflineReport(BODY);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    const result = await flushOfflineReports();
    expect(result.remaining).toBe(1);
    expect(listOfflineReports()).toHaveLength(1);
  });

  it("сервер отклонил как невалидный (422) — запись удаляется, повтор бессмысленен", async () => {
    enqueueOfflineReport(BODY);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(422, { detail: "невалидный отчёт" })),
    );
    const result = await flushOfflineReports();
    expect(result).toEqual({ sent: 0, remaining: 0, failed: 1 });
    expect(listOfflineReports()).toEqual([]);
  });

  it("сессия истекла (401) — запись остаётся в очереди, а не теряется молча", async () => {
    enqueueOfflineReport(BODY);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { detail: "нет сессии" })),
    );
    const result = await flushOfflineReports();
    expect(result.remaining).toBe(1);
    expect(listOfflineReports()).toHaveLength(1);
  });
});
