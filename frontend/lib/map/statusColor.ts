import type { FuelStatusCode } from "@/lib/types";

/**
 * Цветовая легенда карты (R27, бриф §16.2):
 * 🟢 есть · 🟡 вероятно есть/устаревает · 🟠 заканчивается/противоречиво ·
 * 🔴 нет · ⚪ нет данных.
 *
 * Это визуальное кодирование статуса, а не переводы текста — тексты статусов
 * по-прежнему приходят из `/meta` (R98i). ⚪ (UNKNOWN) — «нет данных», это
 * НЕ равнозначно «нет топлива» (🔴 UNAVAILABLE) — инвариант R15/R27.1.
 */
export interface StatusVisual {
  emoji: string;
  hex: string;
  /** топливо можно считать «доступным» для составного значка (✅/❌) */
  ok: boolean;
}

const VISUALS: Record<FuelStatusCode, StatusVisual> = {
  AVAILABLE: { emoji: "🟢", hex: "#16a34a", ok: true },
  LIKELY_AVAILABLE: { emoji: "🟡", hex: "#eab308", ok: true },
  LOW_STOCK: { emoji: "🟠", hex: "#f97316", ok: false },
  UNCERTAIN: { emoji: "🟠", hex: "#f97316", ok: false },
  UNAVAILABLE: { emoji: "🔴", hex: "#dc2626", ok: false },
  UNKNOWN: { emoji: "⚪", hex: "#9ca3af", ok: false },
};

export function statusVisual(status: FuelStatusCode | string | undefined | null): StatusVisual {
  if (status && status in VISUALS) return VISUALS[status as FuelStatusCode];
  return VISUALS.UNKNOWN;
}

/** Порядок «серьёзности» статуса — для выбора «лучшего»/агрегированного статуса станции. */
const RANK: Record<FuelStatusCode, number> = {
  AVAILABLE: 5,
  LIKELY_AVAILABLE: 4,
  LOW_STOCK: 3,
  UNCERTAIN: 2,
  UNAVAILABLE: 1,
  UNKNOWN: 0,
};

export function statusRank(status: FuelStatusCode | string | undefined | null): number {
  if (status && status in RANK) return RANK[status as FuelStatusCode];
  return 0;
}
