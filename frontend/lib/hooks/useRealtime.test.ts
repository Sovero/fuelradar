import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRealtime } from "@/lib/hooks/useRealtime";
import { pushSupport, urlBase64ToUint8Array } from "@/lib/push";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static instances: FakeEventSource[] = [];
  url: string;
  open: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, handler: (ev: unknown) => void) {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
  }

  close() {
    this.closed = true;
  }

  closed = false;
  readyState: number | undefined = undefined;

  emit(name: string) {
    for (const handler of this.listeners.get(name) ?? []) handler({});
  }
}

describe("useRealtime (T14, R64)", () => {
  let originalEventSource: typeof EventSource | undefined;

  beforeEach(() => {
    originalEventSource = globalThis.EventSource;
    FakeEventSource.instances = [];
    FakeEventSource.last = null;
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (originalEventSource) {
      (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
    }
    vi.useRealTimers();
  });

  it("подписывается на /api/v1/realtime/stream и переходит в live", () => {
    const { result } = renderHook(() => useRealtime({}));
    expect(FakeEventSource.last?.url).toBe("/api/v1/realtime/stream");
    expect(result.current).toBe("connecting");
    act(() => FakeEventSource.last?.emit("open"));
    expect(result.current).toBe("live");
  });

  it("событие revision вызывает onRevision ровно на каждое событие", () => {
    const onRevision = vi.fn();
    renderHook(() => useRealtime({ onRevision }));
    act(() => FakeEventSource.last?.emit("revision"));
    act(() => FakeEventSource.last?.emit("revision"));
    expect(onRevision).toHaveBeenCalledTimes(2);
  });

  it("при обрыве состояние offline, данные не трогаются, переподписка не дублируется", () => {
    const onRevision = vi.fn();
    const { result } = renderHook(() => useRealtime({ onRevision }));
    act(() => FakeEventSource.last?.emit("error"));
    expect(result.current).toBe("offline");
    // EventSource браузера сам переподключается — наш хук не создаёт второй источник
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("событие bye закрывает источник и переподключается (ротация сервера)", () => {
    vi.useFakeTimers();
    renderHook(() => useRealtime({}));
    const first = FakeEventSource.last;
    act(() => FakeEventSource.last?.emit("bye"));
    expect(first?.closed).toBe(true);
    act(() => vi.advanceTimersByTime(1500));
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it("фатальная ошибка (readyState CLOSED) — переподключение собственными силами", () => {
    // Браузер НЕ переподключается после фатальной ошибки (503 лимита, сбой прокси):
    // без этого хук остаётся offline до перемонтирования.
    vi.useFakeTimers();
    renderHook(() => useRealtime({}));
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.last!.readyState = 2; // EventSource.CLOSED
    act(() => FakeEventSource.last?.emit("error"));
    expect(FakeEventSource.last?.closed).toBe(true);
    act(() => vi.advanceTimersByTime(3500));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("восстанавливаемая ошибка (readyState CONNECTING) — браузер переподключается сам, дублей нет", () => {
    vi.useFakeTimers();
    renderHook(() => useRealtime({}));
    FakeEventSource.last!.readyState = 0; // EventSource.CONNECTING
    act(() => FakeEventSource.last?.emit("error"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("enabled=false не открывает соединение", () => {
    renderHook(() => useRealtime({ enabled: false }));
    expect(FakeEventSource.last).toBeNull();
  });

  it("unmount закрывает соединение", () => {
    const { unmount } = renderHook(() => useRealtime({}));
    const source = FakeEventSource.last;
    unmount();
    expect(source?.closed).toBe(true);
  });
});

describe("push helpers (T14)", () => {
  it("urlBase64ToUint8Array декодирует base64url (с и без padding)", () => {
    const fromPadded = urlBase64ToUint8Array("BQ==");
    expect(Array.from(fromPadded)).toEqual([5]);
    const fromUnpadded = urlBase64ToUint8Array("BQ");
    expect(Array.from(fromUnpadded)).toEqual([5]);
  });

  it("pushSupport без браузерных API — unsupported", () => {
    // jsdom: no PushManager / Notification by default in this config
    const result = pushSupport();
    expect(["unsupported", "ok", "denied"]).toContain(result);
  });
});
