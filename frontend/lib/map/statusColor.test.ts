import { describe, expect, it } from "vitest";
import { statusRank, statusVisual } from "@/lib/map/statusColor";

describe("statusVisual", () => {
  it("маркирует AVAILABLE зелёным и как доступное топливо", () => {
    const v = statusVisual("AVAILABLE");
    expect(v.emoji).toBe("🟢");
    expect(v.ok).toBe(true);
  });

  it("UNKNOWN — отдельный серый цвет, не совпадающий с UNAVAILABLE (R15/R27.1)", () => {
    const unknown = statusVisual("UNKNOWN");
    const unavailable = statusVisual("UNAVAILABLE");
    expect(unknown.hex).not.toBe(unavailable.hex);
    expect(unknown.ok).toBe(false);
    expect(unavailable.ok).toBe(false);
    expect(unknown.emoji).toBe("⚪");
    expect(unavailable.emoji).toBe("🔴");
  });

  it("LOW_STOCK и UNCERTAIN — один и тот же оранжевый цвет (заканчивается/противоречиво)", () => {
    expect(statusVisual("LOW_STOCK").hex).toBe(statusVisual("UNCERTAIN").hex);
  });

  it("неизвестный/пустой статус безопасно считается UNKNOWN", () => {
    expect(statusVisual(undefined)).toEqual(statusVisual("UNKNOWN"));
    expect(statusVisual("garbage")).toEqual(statusVisual("UNKNOWN"));
  });

  it("statusRank упорядочивает статусы от лучшего к худшему", () => {
    expect(statusRank("AVAILABLE")).toBeGreaterThan(statusRank("LIKELY_AVAILABLE"));
    expect(statusRank("LIKELY_AVAILABLE")).toBeGreaterThan(statusRank("LOW_STOCK"));
    expect(statusRank("UNAVAILABLE")).toBeGreaterThan(statusRank("UNKNOWN"));
  });
});
