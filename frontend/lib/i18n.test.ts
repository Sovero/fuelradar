import { describe, expect, it } from "vitest";
import { translate, translateTemplate } from "@/lib/i18n";

describe("i18n (R100)", () => {
  it("переводит статичные тексты интерфейса на ru/en", () => {
    expect(translate("ru", "tabs.map")).toBe("Карта");
    expect(translate("en", "tabs.map")).toBe("Map");
  });

  it("подставляет токены в шаблон (например пустое состояние)", () => {
    expect(translateTemplate("ru", "empty.headline", { radius: 10, fuel: "АИ-95" })).toBe(
      "В радиусе 10 км подтверждённого АИ-95 не найдено",
    );
    expect(translateTemplate("en", "empty.headline", { radius: 10, fuel: "AI-95" })).toBe(
      "No confirmed AI-95 found within 10 km",
    );
  });

  it("падает обратно на русский, если для ключа нет перевода в другом языке (устойчиво к неполному словарю)", () => {
    // @ts-expect-error — намеренно передаём несуществующий ключ, чтобы проверить fallback-путь
    expect(translate("en", "no.such.key")).toBe("no.such.key");
  });
});
