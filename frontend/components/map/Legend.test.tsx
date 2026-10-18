import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Legend } from "@/components/map/Legend";
import { I18nProvider } from "@/lib/hooks/useI18n";

// Справочники не тянем по сети: легенде нужны только подписи статусов.
vi.mock("@/lib/hooks/useMeta", () => ({
  useMeta: () => ({
    meta: null,
    loading: false,
    error: null,
    fuelLabel: (code: string) => code,
    statusLabel: (code: string) => code,
    queueLabel: (code: string) => code,
  }),
}));

afterEach(() => cleanup());

function renderLegend(props: Parameters<typeof Legend>[0] = {}) {
  render(
    <I18nProvider>
      <Legend {...props} />
    </I18nProvider>,
  );
}

describe("Legend — переключатель тепловой карты (R50)", () => {
  it("без обработчика чекбокса нет — легенда не создаёт видимость выбора", () => {
    renderLegend();

    expect(screen.queryByRole("checkbox", { name: "Тепловая карта" })).toBeNull();
  });

  it("чекбокс отражает состояние и отдаёт изменение наверх", async () => {
    const onChange = vi.fn();
    renderLegend({ heatOn: false, onToggleHeat: onChange });

    const box = screen.getByRole("checkbox", { name: "Тепловая карта" }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("сбой тепловой карты объясняется рядом с переключателем, пояснение остаётся", () => {
    renderLegend({ showHeat: true, heatOn: true, heatError: "unavailable", onToggleHeat: () => {} });

    expect(screen.getByText(/Тепловая карта недоступна/)).toBeInTheDocument();
    expect(screen.getByText("Доступность (тепловая карта)")).toBeInTheDocument();
  });
});
