import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouteButton } from "@/components/station/RouteButton";
import { I18nProvider } from "@/lib/hooks/useI18n";

afterEach(() => {
  cleanup();
});

function renderButton(props: Parameters<typeof RouteButton>[0]) {
  render(
    <I18nProvider>
      <RouteButton {...props} />
    </I18nProvider>,
  );
}

describe("RouteButton", () => {
  it("с обработчиком строит маршрут на внутренней карте (не ссылка, не внешний браузер)", async () => {
    const onBuildRoute = vi.fn();
    renderButton({ lat: 45.03, lon: 38.97, onBuildRoute });

    const button = screen.getByRole("button", { name: /Маршрут/ });
    await userEvent.click(button);
    expect(onBuildRoute).toHaveBeenCalledWith(45.03, 38.97);
  });

  it("без обработчика (карты рядом нет) — честный fallback: deep-link на внешний навигатор", () => {
    renderButton({ lat: 45.03, lon: 38.97 });

    const link = screen.getByRole("link", { name: /Маршрут/ });
    expect(link.getAttribute("href")).toContain("yandex.ru/maps");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
