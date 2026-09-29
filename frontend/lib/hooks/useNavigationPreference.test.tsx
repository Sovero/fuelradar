import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNavigationPreference } from "./useNavigationPreference";

describe("useNavigationPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("по умолчанию — яндекс", () => {
    const { result } = renderHook(() => useNavigationPreference());
    expect(result.current.provider).toBe("yandex");
  });

  it("setProvider сохраняет выбор в localStorage", () => {
    const { result } = renderHook(() => useNavigationPreference());
    act(() => result.current.setProvider("2gis"));
    expect(result.current.provider).toBe("2gis");
    expect(localStorage.getItem("fuelradar:nav-provider")).toBe("2gis");
  });

  it("восстанавливает сохранённый выбор при монтировании", () => {
    localStorage.setItem("fuelradar:nav-provider", "google");
    const { result } = renderHook(() => useNavigationPreference());
    expect(result.current.provider).toBe("google");
  });

  it("битое/чужое значение в хранилище отбрасывается к дефолту", () => {
    localStorage.setItem("fuelradar:nav-provider", "apple-maps");
    const { result } = renderHook(() => useNavigationPreference());
    expect(result.current.provider).toBe("yandex");
  });
});
