import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCyclesRefresh } from "@/lib/hooks/useCyclesRefresh";
import { REFRESH_SECONDS_DEFAULT, REFRESH_SECONDS_MAX, REFRESH_SECONDS_MIN } from "@/lib/collectionCycles";

const STORAGE_KEY = "fuelradar:cycles-refresh-seconds";

describe("useCyclesRefresh (R58)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("по умолчанию — 60 секунд", () => {
    const { result } = renderHook(() => useCyclesRefresh());
    expect(result.current.seconds).toBe(REFRESH_SECONDS_DEFAULT);
    expect(REFRESH_SECONDS_DEFAULT).toBe(60);
  });

  it("ручной период сохраняется в localStorage", () => {
    const { result } = renderHook(() => useCyclesRefresh());
    act(() => result.current.setSeconds("20"));
    expect(result.current.seconds).toBe(20);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("20");
  });

  it("восстанавливает сохранённый период при монтировании", () => {
    localStorage.setItem(STORAGE_KEY, "120");
    const { result } = renderHook(() => useCyclesRefresh());
    expect(result.current.seconds).toBe(120);
  });

  it("битое значение в хранилище нормализуется, а не ломает вкладку", () => {
    localStorage.setItem(STORAGE_KEY, "abc");
    const { result } = renderHook(() => useCyclesRefresh());
    expect(result.current.seconds).toBe(REFRESH_SECONDS_DEFAULT);
  });

  it("выход за границы зажимается и сохраняется уже нормализованным", () => {
    const { result } = renderHook(() => useCyclesRefresh());
    act(() => result.current.setSeconds(1));
    expect(result.current.seconds).toBe(REFRESH_SECONDS_MIN);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(REFRESH_SECONDS_MIN));

    act(() => result.current.setSeconds(999_999));
    expect(result.current.seconds).toBe(REFRESH_SECONDS_MAX);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(REFRESH_SECONDS_MAX));
  });
});
