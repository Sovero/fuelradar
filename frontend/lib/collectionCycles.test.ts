import { describe, expect, it } from "vitest";
import {
  REFRESH_SECONDS_DEFAULT,
  REFRESH_SECONDS_MAX,
  REFRESH_SECONDS_MIN,
  countdownMs,
  durationParts,
  normalizeRefreshSeconds,
  runningMs,
  serverClockSkewMs,
} from "@/lib/collectionCycles";

/** Naive-UTC ISO, как в ответе API (без смещения зоны). */
function naiveIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

const BASE = Date.parse("2026-10-06T12:00:00.000Z");

describe("collectionCycles (R58)", () => {
  it("serverClockSkewMs считает смещение часов клиента по полю now", () => {
    // Сервер на 12 секунд впереди клиента — отсчёт должен идти по серверу.
    expect(serverClockSkewMs(naiveIso(BASE + 12_000), BASE)).toBe(12_000);
    expect(serverClockSkewMs(naiveIso(BASE - 5_000), BASE)).toBe(-5_000);
    // Мусор/пусто не выдумывают смещение: считаем часы синхронными.
    expect(serverClockSkewMs(null, BASE)).toBe(0);
    expect(serverClockSkewMs("не время", BASE)).toBe(0);
  });

  it("countdownMs отдаёт остаток до момента и отрицательное после него", () => {
    expect(countdownMs(naiveIso(BASE + 7_000), BASE)).toBe(7_000);
    expect(countdownMs(naiveIso(BASE - 90_000), BASE)).toBe(-90_000);
    expect(countdownMs(null, BASE)).toBeNull();
    expect(countdownMs("не время", BASE)).toBeNull();
  });

  it("runningMs считает длительность цикла и не уходит в минус на будущем старте", () => {
    expect(runningMs(naiveIso(BASE - 65_000), BASE)).toBe(65_000);
    expect(runningMs(naiveIso(BASE + 10_000), BASE)).toBe(0);
    expect(runningMs(null, BASE)).toBeNull();
  });

  it("normalizeRefreshSeconds: дефолт 60 с, мусор и выход за границы не проходят как есть", () => {
    expect(normalizeRefreshSeconds(60)).toBe(60);
    expect(normalizeRefreshSeconds("45")).toBe(45);
    expect(normalizeRefreshSeconds(" 90 ")).toBe(90);
    // Опечатка в поле не должна превращаться в частый опрос или в мёртвый экран.
    expect(normalizeRefreshSeconds("3")).toBe(REFRESH_SECONDS_MIN);
    expect(normalizeRefreshSeconds(99_999)).toBe(REFRESH_SECONDS_MAX);
    expect(normalizeRefreshSeconds("")).toBe(REFRESH_SECONDS_DEFAULT);
    expect(normalizeRefreshSeconds("abc")).toBe(REFRESH_SECONDS_DEFAULT);
    expect(normalizeRefreshSeconds(0)).toBe(REFRESH_SECONDS_DEFAULT);
    expect(normalizeRefreshSeconds(null)).toBe(REFRESH_SECONDS_DEFAULT);
    // Дробное — округляем: период в поле — целые секунды.
    expect(normalizeRefreshSeconds("61.6")).toBe(62);
  });

  it("durationParts разлагает длительность на секунды/минуты/часы", () => {
    expect(durationParts(7_000)).toEqual({ unit: "seconds", seconds: 7 });
    expect(durationParts(90_000)).toEqual({ unit: "minutes", minutes: 1 });
    expect(durationParts(3_700_000)).toEqual({ unit: "hours", hours: 1, minutes: 1 });
    expect(durationParts(-5_000)).toEqual({ unit: "seconds", seconds: 0 });
  });
});
