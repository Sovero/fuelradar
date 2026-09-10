import { describe, expect, it } from "vitest";
import { buildRouteUrl, formatAgeMinutes, formatConfidence, formatDistance, formatEtaMinutes, formatPrice, formatUpdatedAt } from "@/lib/format";

describe("format helpers", () => {
  it("formatDistance округляет метры/километры и отдаёт «—» без данных", () => {
    expect(formatDistance(0.35)).toBe("350 м");
    expect(formatDistance(3.8)).toBe("3.8 км");
    expect(formatDistance(null)).toBe("—");
  });

  it("formatEtaMinutes и formatConfidence отдают «—» без данных (R30.1)", () => {
    expect(formatEtaMinutes(9.4)).toBe("9 мин");
    expect(formatEtaMinutes(null)).toBe("—");
    expect(formatConfidence(94.4)).toBe("94%");
    expect(formatConfidence(undefined)).toBe("—");
  });

  it("formatPrice не превращает отсутствие цены в ноль и форматирует валюту (R78.3)", () => {
    expect(formatPrice(62.4)).toBe("62.40 ₽");
    expect(formatPrice(62.4, "USD")).toBe("62.40 USD");
    expect(formatPrice(null)).toBe("нет данных");
    expect(formatPrice(undefined, "RUB", { noData: "no data" })).toBe("no data");
  });

  it("formatAgeMinutes покрывает минуты/часы/дни", () => {
    expect(formatAgeMinutes(0)).toBe("только что");
    expect(formatAgeMinutes(12)).toBe("12 мин назад");
    expect(formatAgeMinutes(90)).toBe("1 ч 30 мин назад");
    expect(formatAgeMinutes(60 * 5)).toBe("5 ч назад");
    expect(formatAgeMinutes(60 * 24 * 3)).toBe("3 дн назад");
  });

  it("formatUpdatedAt считает возраст от текущего времени и обрабатывает null", () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    expect(formatUpdatedAt("2026-09-08T11:50:00", now)).toBe("10 мин назад");
    expect(formatUpdatedAt(null, now)).toBe("нет данных");
  });

  it("buildRouteUrl формирует deep-link на внешний навигатор (R80), без встроенной навигации", () => {
    expect(buildRouteUrl(45.03, 38.97)).toContain("yandex.ru/maps");
    expect(buildRouteUrl(45.03, 38.97, "google")).toContain("google.com/maps");
  });
});
