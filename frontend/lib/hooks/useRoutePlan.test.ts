import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useRoutePlan } from "@/lib/hooks/useRoutePlan";

const ROAD_PLAN = {
  is_road_route: true,
  provider: "osrm",
  distance_km: 4.2,
  duration_min: 9,
  geometry: [
    { lat: 45.035, lon: 38.941 },
    { lat: 45.04, lon: 38.95 },
    { lat: 45.028, lon: 38.979 },
  ],
  steps: [
    { type: "depart", modifier: null, street: null, distance_m: 120, duration_s: 20 },
    { type: "turn", modifier: "right", street: "ул. Северная", distance_m: 3100, duration_s: 420 },
  ],
  reason: null,
};

function stubFetch(payload: unknown, status = 200) {
  const mock = vi.fn(async () => ({
    status,
    ok: status < 400,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRoutePlan (R22.1)", () => {
  it("не обращается к роутеру, пока точек меньше двух", async () => {
    const fetchMock = stubFetch(ROAD_PLAN);
    const { result } = renderHook(() => useRoutePlan(true, [{ lat: 45.03, lon: 38.94 }]));

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.plan).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("запрашивает план в порядке движения и отдаёт геометрию по дорогам", async () => {
    const fetchMock = stubFetch(ROAD_PLAN);
    const points = [
      { lat: 45.0356, lon: 38.9412 },
      { lat: 45.028, lon: 38.979 },
    ];
    const { result } = renderHook(() => useRoutePlan(true, points));

    await waitFor(() => expect(result.current.plan?.is_road_route).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toContain("/api/v1/route/plan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ polyline: points });
    expect(result.current.plan?.geometry).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });

  it("дебаунсит быстрые изменения точек одним запросом", async () => {
    const fetchMock = stubFetch(ROAD_PLAN);
    const { rerender } = renderHook(({ points }) => useRoutePlan(true, points), {
      initialProps: { points: [{ lat: 45.0, lon: 38.9 }, { lat: 45.01, lon: 38.91 }] },
    });

    rerender({ points: [{ lat: 45.0, lon: 38.9 }, { lat: 45.02, lon: 38.92 }] });
    rerender({ points: [{ lat: 45.0, lon: 38.9 }, { lat: 45.03, lon: 38.93 }] });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).polyline.at(-1)).toEqual({ lat: 45.03, lon: 38.93 });
  });

  it("честный отказ роутера — это не ошибка сети", async () => {
    stubFetch({ is_road_route: false, reason: "provider_unavailable", geometry: null, steps: [] });
    const { result } = renderHook(() =>
      useRoutePlan(true, [
        { lat: 45.0, lon: 38.9 },
        { lat: 45.01, lon: 38.91 },
      ]),
    );

    await waitFor(() => expect(result.current.plan).not.toBeNull());

    expect(result.current.plan?.reason).toBe("provider_unavailable");
    expect(result.current.error).toBeNull();
  });

  it("сетевой сбой не подменяет ответ роутера молчанием", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { result } = renderHook(() =>
      useRoutePlan(true, [
        { lat: 45.0, lon: 38.9 },
        { lat: 45.01, lon: 38.91 },
      ]),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error).toMatch(/соединени|маршрут/i);
    expect(result.current.plan).toBeNull();
  });
});
