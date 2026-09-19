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
    expect(result.current.source).toBe("gps");
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
    expect(result.current.source).toBeNull();
    expect(result.current.error).toContain("Доступ к геолокации запрещён");
  });

  it("falls back to an IP lookup when the device has no location source", async () => {
    const getCurrentPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
      error({ code: 2, message: "position unavailable" } as GeolocationPositionError);
    });
    installGeolocation({ getCurrentPosition });
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, latitude: 45.04, longitude: 38.98, city: "Краснодар" }), { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.request());
    await act(async () => {});

    expect(result.current.status).toBe("ready");
    expect(result.current.source).toBe("ip");
    expect(result.current.position).toEqual({ lat: 45.04, lon: 38.98 });
    expect(result.current.error).toBeNull();
  });

  it("reports a recoverable error when both device and IP lookup fail", async () => {
    const getCurrentPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
      error({ code: 3, message: "timeout" } as GeolocationPositionError);
    });
    installGeolocation({ getCurrentPosition });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network down"))),
    );

    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.request());
    await act(async () => {});

    expect(result.current.status).toBe("error");
    expect(result.current.source).toBeNull();
    expect(result.current.error).toContain("выберите точку вручную");
  });

  it("reports an unavailable geolocation API", () => {
    Reflect.deleteProperty(navigator, "geolocation");

    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.request());

    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("Геолокация недоступна");
  });
});
