"use client";

/**
 * R58: сигнал о простое сбора для главного экрана.
 *
 * Триггеры перезапроса: загрузка экрана, событие realtime (`revision` — данные
 * изменились после сборки) и таймер раз в 5 минут: простой — это то, что
 * случается само по себе, пока окно открыто, и молчащий экран обязан сказать об
 * этом даже без перезагрузки.
 *
 * Обрыв сети не выдумывает предупреждение: при ошибке состояние остаётся
 * прежним (или пустым), а не превращается в «сбор стоит» — за честность
 * отвечает backend, хук только показывает его ответ.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { CollectionHealth } from "@/lib/types";

/** Периодичность перепроверки: сигнал меняется медленно (пороги — десятки минут). */
export const COLLECTION_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

export function useCollectionHealth(revisionTick = 0) {
  const [health, setHealth] = useState<CollectionHealth | null>(null);
  const [error, setError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(() => {
    apiGet<CollectionHealth>("/collection/health")
      .then((response) => {
        setHealth(response);
        setError(false);
      })
      .catch(() => {
        // Не смогли спросить — не подменяем ответ backend своей догадкой.
        setError(true);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload, revisionTick]);

  useEffect(() => {
    timerRef.current = setInterval(reload, COLLECTION_HEALTH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [reload]);

  return { health, error, reload };
}
