import type { MetaFuelType } from "@/lib/types";

/**
 * Виды топлива для быстрых фильтров/выбора — все базовые виды из `/meta`,
 * кроме служебных UNKNOWN/OTHER (R98i: список топлива не хардкодится, только
 * фильтруются служебные коды, которые сама же `/meta` помечает этими именами).
 */
export function selectableFuelTypes(fuelTypes: MetaFuelType[]): MetaFuelType[] {
  return fuelTypes.filter((f) => f.code !== "UNKNOWN" && f.code !== "OTHER");
}
