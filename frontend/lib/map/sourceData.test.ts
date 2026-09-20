import { describe, expect, it, vi } from "vitest";

import { applyWhenSourceReady } from "@/lib/map/sourceData";

/**
 * Регрессия: раньше эффекты гейтились по `map.isStyleLoaded()`, который в
 * MapLibre 4 временно false, пока обновляются источники/грузятся тайлы, — и
 * апдейт молча терялся (линия маршрута не рисовалась). Критерий готовности —
 * наличие источника, а ждать `load` нужно только до его появления.
 */
describe("applyWhenSourceReady", () => {
  it("применяет данные сразу, когда источник уже есть в стиле", () => {
    const apply = vi.fn();
    const once = vi.fn();
    const map = { getSource: () => ({ setData: vi.fn() }), once };

    applyWhenSourceReady(map, "fr-route", apply);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(once).not.toHaveBeenCalled();
  });

  it("до загрузки стиля ждёт load и применяет данные после него", () => {
    const apply = vi.fn();
    let onLoad: (() => void) | null = null;
    const map = {
      getSource: () => undefined,
      once: (event: "load", listener: () => void) => {
        expect(event).toBe("load");
        onLoad = listener;
      },
    };

    applyWhenSourceReady(map, "fr-route", apply);

    expect(apply).not.toHaveBeenCalled();
    expect(onLoad).not.toBeNull();
    onLoad!();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("не молчит, если источник появился между рендерами — каждый вызов проверяет стиль заново", () => {
    const apply = vi.fn();
    let source: object | undefined;
    const map = { getSource: () => source, once: vi.fn() };

    applyWhenSourceReady(map, "fr-route", apply);
    expect(apply).not.toHaveBeenCalled();

    source = { setData: vi.fn() };
    applyWhenSourceReady(map, "fr-route", apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
