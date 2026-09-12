"use client";

/**
 * Realtime (T14, R64): подписка на SSE `/api/v1/realtime/stream`.
 *
 * Контракт минимальный и честный: поток несёт ТОЛЬКО сигнал «данные изменились»
 * (event: revision). Что с этим делать — решает колбэк `onRevision`: экран
 * переподтягивает `/stations` обычным кэшируемым GET (R82) через существующий
 * `refetch`. При обрыве соединения существующие данные НЕ трогаются — браузерный
 * EventSource переподключится сам, следующее событие обновит список.
 *
 * Возврат `disconnect` позволяет панели явно останавливать поток (например,
 * когда вкладка скрыта — экономия соединений на сервере).
 */

import { useEffect, useRef, useState } from "react";

export type RealtimeState = "connecting" | "live" | "offline";

interface RealtimeOptions {
  enabled?: boolean;
  onRevision?: () => void;
}

export function useRealtime({ enabled = true, onRevision }: RealtimeOptions): RealtimeState {
  const [state, setState] = useState<RealtimeState>("connecting");
  // Колбэк в ref: переподписка EventSource не должна пересоздаваться на каждый
  // рендер родителя с новой ссылкой на функцию.
  const handlerRef = useRef(onRevision);
  handlerRef.current = onRevision;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }
    let source: EventSource | null = null;
    let disposed = false;
    // EventSource сам переподключается с backoff; наш retry-таймер — для случаев,
    // когда браузер этого НЕ делает: bye/rotate и фатальная ошибка (CLOSED).
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = (delayMs: number) => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delayMs);
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource("/api/v1/realtime/stream");
      source.addEventListener("open", () => setState("live"));
      source.addEventListener("revision", () => {
        setState("live");
        handlerRef.current?.();
      });
      source.addEventListener("bye", () => {
        // Сервер честно закрывает соединение (ротация): переподключаемся сами.
        source?.close();
        setState("connecting");
        scheduleReconnect(1000);
      });
      source.addEventListener("error", () => {
        // Обрыв/сеть: EventSource переподключится сам; данные на экране не трогаем.
        setState("offline");
        // readyState 2 (CLOSED) — фатальная ошибка (например, 503 при исчерпании
        // sse_max_clients или сбой прокси): браузер НЕ будет переподключаться сам,
        // остаёмся offline навсегда. Переподключаемся сами, с паузой против горячего цикла.
        // Сравнение по числовой константе спеки (2), а не EventSource.CLOSED —
        // глобал может быть подменён/отсутствовать в тестовом окружении.
        if (source && source.readyState === 2) {
          source.close();
          scheduleReconnect(3000);
        }
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled]);

  return state;
}
