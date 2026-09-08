import { describe, expect, it } from "vitest";
import { selectableFuelTypes } from "@/lib/fuel";

describe("selectableFuelTypes", () => {
  it("исключает служебные UNKNOWN/OTHER, не хардкодя остальной список (R98i)", () => {
    const fuels = [
      { code: "AI_92", name_ru: "АИ-92", commercial: [] },
      { code: "AI_95", name_ru: "АИ-95", commercial: [] },
      { code: "DT", name_ru: "Дизель", commercial: [] },
      { code: "UNKNOWN", name_ru: "Неизвестно", commercial: [] },
      { code: "OTHER", name_ru: "Другое", commercial: [] },
    ];
    const result = selectableFuelTypes(fuels);
    expect(result.map((f) => f.code)).toEqual(["AI_92", "AI_95", "DT"]);
  });
});
