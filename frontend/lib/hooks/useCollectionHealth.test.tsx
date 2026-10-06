import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { COLLECTION_HEALTH_INTERVAL_MS, useCollectionHealth } from "@/lib/hooks/useCollectionHealth";

const HEALTH = {
  state: "stalled",
  warning: true,
  reason: "no_success",
  mode: "external",
  mode_reason: null,
  tick_seconds: 10,
  last_success_at: "2026-10-06T09:00:00",
  age_minutes: 240,
  planned_at: null,
  overdue_minutes: null,
  next_run_at: null,
  next_tick_at: null,
  pending_jobs: 0,
  running_jobs: 0,
  stale_after_minutes: 180,
  overdue_after_minutes: 30,
};

function stubFetch(payload: unknown = HEALTH) {
  const mock = vi.fn(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useCollectionHealth (R58)", () => {
  it("запрашивает сигнал о сборе при открытии экрана", async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useCollectionHealth());

    await waitFor(() => expect(result.current.health?.state).toBe("stalled"));

    const [path] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/collection/health");
    expect(result.current.error).toBe(false);
  });

  it("перепроверяет сигнал по событию realtime (revision)", async () => {
    const fetchMock = stubFetch();
    const { rerender } = renderHook(({ tick }) => useCollectionHealth(tick), { initialProps: { tick: 0 } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ tick: 1 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("перепроверяет сигнал по таймеру: простой случается, пока окно открыто", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch();
    renderHook(() => useCollectionHealth());
    // Первый запрос — по эффекту монтирования (промис разрешаем микрозадачей).
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(COLLECTION_HEALTH_INTERVAL_MS);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("сетевой сбой честно помечается ошибкой, а не выдуманным «сбор стоит»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { result } = renderHook(() => useCollectionHealth());

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.health).toBeNull();
  });
});
