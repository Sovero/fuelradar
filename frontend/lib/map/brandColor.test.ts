import { describe, expect, it } from "vitest";
import { brandRingColor } from "@/lib/map/brandColor";

describe("brandRingColor (R103)", () => {
  it("независимая станция (пустой/отсутствующий brand) — без кольца", () => {
    expect(brandRingColor(null)).toBeNull();
    expect(brandRingColor(undefined)).toBeNull();
    expect(brandRingColor("")).toBeNull();
    expect(brandRingColor("   ")).toBeNull();
  });

  it("для сети — детерминированный цвет из палитры, стабильный между вызовами", () => {
    const a1 = brandRingColor("Лукойл");
    const a2 = brandRingColor("Лукойл");
    expect(a1).not.toBeNull();
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("разные сети обычно получают разные цвета (не хардкод по одному имени)", () => {
    const brands = ["Лукойл", "Роснефть", "Газпромнефть", "РусОйл", "Ирбис", "УфимНефть"];
    const colors = new Set(brands.map((b) => brandRingColor(b)));
    expect(colors.size).toBeGreaterThan(1);
  });
});
