"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { type Filters, filtersFromSearchParams, filtersToSearchParams } from "@/lib/filters";

interface FiltersState {
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
}

const FiltersContext = createContext<FiltersState | null>(null);

/**
 * Состояние фильтров экрана, общее для карты/списка/избранного (R32.1).
 * Живёт в query-параметрах URL — не сбрасывается при переключении вкладок
 * и переживает перезагрузку страницы (R39.1).
 *
 * `router.replace` обновляет URL асинхронно, поэтому несколько setFilters
 * подряд (до того как searchParams успеют перечитаться) не должны терять
 * данные друг друга — держим последнее «намеренное» состояние в ref и
 * мёржим патчи на него, а не на потенциально устаревший `filters` из рендера.
 */
export function FiltersProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams]);
  const latestRef = useRef(filters);

  useEffect(() => {
    latestRef.current = filters;
  }, [filters]);

  const setFilters = useCallback(
    (patch: Partial<Filters>) => {
      const next = { ...latestRef.current, ...patch };
      latestRef.current = next;
      const params = filtersToSearchParams(next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const value = useMemo<FiltersState>(() => ({ filters, setFilters }), [filters, setFilters]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersState {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters должен использоваться внутри FiltersProvider");
  return ctx;
}
