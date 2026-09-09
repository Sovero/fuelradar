"use client";

/**
 * Приватность геолокации (R24): выключить GPS, точка вручную, «удалить
 * историю позиций». Хранится в localStorage на устройстве (как тема/язык) —
 * позиция пользователя не отправляется на backend как трек ни в каком случае
 * (см. `backend/app/reports/schemas.py::ReportBody.lat/lon` — только текущая
 * точка одного отчёта, истории координат в БД нет отдельной таблицей).
 *
 * CONCERN (см. отчёт задачи): backend не хранит трек позиций пользователя и
 * не имеет endpoint'а для удаления «истории геопозиции» — истории на сервере
 * попросту нет, поэтому «удалить историю» здесь чистит только то, что могло
 * накопиться на этом устройстве (последняя известная точка, кэш применения
 * геолокации в фильтрах). Настоящего серверного трека, который надо было бы
 * стирать по R24.1, в системе нет — инвариант спецификации §11 «в системе нет
 * хранения постоянного трека» уже соблюдён на backend по построению.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export interface ManualPoint {
  lat: number;
  lon: number;
  label?: string;
}

interface PrivacyState {
  /** Разрешено ли использовать браузерную геолокацию (R24). По умолчанию — да, до явного отказа. */
  gpsEnabled: boolean;
  setGpsEnabled: (enabled: boolean) => void;
  manualPoint: ManualPoint | null;
  setManualPoint: (point: ManualPoint | null) => void;
  /** «Удалить историю геопозиции» одним кликом (R24.1) — см. CONCERN в комментарии модуля. */
  clearHistory: () => void;
  /** Точка последнего успешного геолокационного запроса — то, что подчищает clearHistory. */
  lastKnownPosition: { lat: number; lon: number } | null;
  setLastKnownPosition: (point: { lat: number; lon: number } | null) => void;
}

const PrivacyContext = createContext<PrivacyState | null>(null);

const GPS_KEY = "fr_privacy_gps_enabled";
const MANUAL_POINT_KEY = "fr_privacy_manual_point";
const LAST_POSITION_KEY = "fr_privacy_last_position";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // недоступно — настройка просто не переживёт перезагрузку
  }
}

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  // SSR-безопасный дефолт (см. урок T09 про useStations/hydration) — реальное
  // значение подставляется эффектом после монтирования.
  const [gpsEnabled, setGpsEnabledState] = useState(true);
  const [manualPoint, setManualPointState] = useState<ManualPoint | null>(null);
  const [lastKnownPosition, setLastKnownPositionState] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    setGpsEnabledState(readBool(GPS_KEY, true));
    setManualPointState(readJson<ManualPoint>(MANUAL_POINT_KEY));
    setLastKnownPositionState(readJson<{ lat: number; lon: number }>(LAST_POSITION_KEY));
  }, []);

  const setGpsEnabled = useCallback((enabled: boolean) => {
    setGpsEnabledState(enabled);
    try {
      window.localStorage.setItem(GPS_KEY, enabled ? "1" : "0");
    } catch {
      // не критично
    }
  }, []);

  const setManualPoint = useCallback((point: ManualPoint | null) => {
    setManualPointState(point);
    writeJson(MANUAL_POINT_KEY, point);
  }, []);

  const setLastKnownPosition = useCallback((point: { lat: number; lon: number } | null) => {
    setLastKnownPositionState(point);
    writeJson(LAST_POSITION_KEY, point);
  }, []);

  const clearHistory = useCallback(() => {
    setLastKnownPositionState(null);
    writeJson(LAST_POSITION_KEY, null);
  }, []);

  const value = useMemo<PrivacyState>(
    () => ({ gpsEnabled, setGpsEnabled, manualPoint, setManualPoint, clearHistory, lastKnownPosition, setLastKnownPosition }),
    [gpsEnabled, setGpsEnabled, manualPoint, setManualPoint, clearHistory, lastKnownPosition, setLastKnownPosition],
  );

  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

export function usePrivacy(): PrivacyState {
  const ctx = useContext(PrivacyContext);
  if (!ctx) throw new Error("usePrivacy должен использоваться внутри PrivacyProvider");
  return ctx;
}
