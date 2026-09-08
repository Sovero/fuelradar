"use client";

/**
 * Справочники и переводы (R98i, A02, R100) — единственный источник видов
 * топлива, сетей и текстов статусов. Компоненты НЕ хранят списки топлива/
 * переводы сами. `name_en` берётся, если backend его прислал — иначе честный
 * откат на `name_ru` (не все справочники ещё переведены на английском).
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { useI18n } from "@/lib/hooks/useI18n";
import type { Meta } from "@/lib/types";

interface MetaState {
  meta: Meta | null;
  loading: boolean;
  error: string | null;
  fuelLabel: (code: string) => string;
  statusLabel: (code: string) => string;
  queueLabel: (code: string) => string;
}

const MetaContext = createContext<MetaState | null>(null);

const EMPTY_META: Meta = { fuel_types: [], station_brands: [], sources: [], fuel_statuses: [], queue_levels: [] };

export function MetaProvider({ children }: { children: React.ReactNode }) {
  const { locale } = useI18n();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<Meta>("/meta")
      .then((data) => {
        if (!cancelled) setMeta(data);
      })
      .catch(() => {
        if (!cancelled) setError("Не удалось загрузить справочники — часть подписей может быть недоступна");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<MetaState>(() => {
    const m = meta ?? EMPTY_META;
    // en, если backend его прислал — иначе честный откат на ru (R100).
    const pick = (ru: string, en: string | undefined) => (locale === "en" && en ? en : ru);
    const fuelMap = new Map(m.fuel_types.map((f) => [f.code, pick(f.name_ru, f.name_en)]));
    const statusMap = new Map(m.fuel_statuses.map((s) => [s.code, pick(s.name_ru, s.name_en)]));
    const queueMap = new Map(m.queue_levels.map((q) => [q.code, pick(q.name_ru, q.name_en)]));
    return {
      meta,
      loading,
      error,
      fuelLabel: (code: string) => fuelMap.get(code) ?? code,
      statusLabel: (code: string) => statusMap.get(code) ?? code,
      queueLabel: (code: string) => queueMap.get(code) ?? code,
    };
  }, [meta, loading, error, locale]);

  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
}

export function useMeta(): MetaState {
  const ctx = useContext(MetaContext);
  if (!ctx) throw new Error("useMeta должен использоваться внутри MetaProvider");
  return ctx;
}
