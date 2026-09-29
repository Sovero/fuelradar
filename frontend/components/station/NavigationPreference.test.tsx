import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavigationPreference } from "./NavigationPreference";
import { I18nProvider } from "@/lib/hooks/useI18n";

function renderWith(props: { provider: string; onSelect: (p: string) => void }) {
  return render(
    <I18nProvider>
      <NavigationPreference provider={props.provider as never} onSelect={props.onSelect} />
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
});
