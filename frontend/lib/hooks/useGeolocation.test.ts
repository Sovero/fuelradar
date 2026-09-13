import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGeolocation } from "@/lib/hooks/useGeolocation";

type GeolocationMock = {
  getCurrentPosition: ReturnType<typeof vi.fn>;
};

function installGeolocation(mock: GeolocationMock): void {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: mock,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "geolocation");
});

describe("useGeolocation", () => {
  it("stores the position after a successful explicit request", () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({
        coords: { latitude: 45.03, longitude: 38.97 } as GeolocationCoordinates,
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    installGeolocation({ getCurrentPosition });

    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.request());

    expect(result.current.status).toBe("ready");
    expect(result.current.position).toEqual({ lat: 45.03, lon: 38.97 });
    expect(result.current.error).toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true,
      timeout: 10_000,
    });
  });

  it("reports a denied permission without leaving the loading state", () => {
    const getCurrentPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
      error({ code: 1, message: "denied" } as GeolocationPositionError);
    });
    installGeolocation({ getCurrentPosition });

    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.request());

    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("Доступ к геолокации запрещён");
  });

  it("reports a timeout as a recoverable location error", () => {
    const getCurrentPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
      error({ code: 3, message: "timeout" } as GeolocationPositionError);
    });
    installGeolocation({ getCurrentPosition });

    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.request());

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Не удалось определить местоположение");
  });

  it("reports an unavailable geolocation API", () => {
    Reflect.deleteProperty(navigator, "geolocation");

    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.request());

    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("Геолокация недоступна");
  });
});
