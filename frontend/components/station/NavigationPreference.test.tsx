import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavigationPreference } from "./NavigationPreference";
import { I18nProvider } from "@/lib/hooks/useI18n";

function renderWith(props: { provider: string; onSelect: (p: string) => void; lat?: number; lon?: number }) {
  return render(
    <I18nProvider>
      <NavigationPreference
        provider={props.provider as never}
        onSelect={props.onSelect}
        lat={props.lat ?? 45.03}
        lon={props.lon ?? 38.97}
      />
    </I18nProvider>,
  );
}

describe("NavigationPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("показывает три варианта навигатора", () => {
    renderWith({ provider: "yandex", onSelect: () => {} });
    expect(screen.getByRole("button", { name: /яндекс/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /2\s?гис|2gis/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /google/i })).toBeTruthy();
  });

  it("текущий провайдер подсвечен как нажатый (aria-pressed)", () => {
    renderWith({ provider: "2gis", onSelect: () => {} });
    const yandex = screen.getByRole("button", { name: /яндекс/i });
    const gis = screen.getByRole("button", { name: /2\s?гис|2gis/i });
    expect(gis.getAttribute("aria-pressed")).toBe("true");
    expect(yandex.getAttribute("aria-pressed")).toBe("false");
  });

  it("клик по варианту вызывает onSelect с этим провайдером", async () => {
    const user = userEvent.setup();
    const picked: string[] = [];
    renderWith({ provider: "yandex", onSelect: (p) => picked.push(p) });
    await user.click(screen.getByRole("button", { name: /google/i }));
    expect(picked).toEqual(["google"]);
  });

  it("ссылка открывает внешний навигатор выбранного провайдера (R80) — это не декоративный выбор", () => {
    renderWith({ provider: "2gis", onSelect: () => {} });
    const link = screen.getByRole("link", { name: /Открыть точку станции в «2ГИС»/ });
    expect(link.getAttribute("href")).toContain("2gis.ru");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("смена провайдера меняет адрес внешней ссылки", () => {
    renderWith({ provider: "google", onSelect: () => {} });
    const link = screen.getByRole("link", { name: /Открыть точку станции в «Google»/ });
    expect(link.getAttribute("href")).toContain("google.com/maps");
  });
});
