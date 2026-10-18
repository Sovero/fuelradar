import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FiltersPanel } from "@/components/filters/FiltersPanel";
import { FiltersProvider } from "@/lib/hooks/useFilters";
import { I18nProvider } from "@/lib/hooks/useI18n";

// Фильтры живут в URL (useFilters): ловим вызовы router.replace, чтобы проверить,
// какие параметры уходят в адресную строку.
const replaceMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Справочники не тянем по сети — панели нужны только пустые списки и подписи.
vi.mock("@/lib/hooks/useMeta", () => ({
  useMeta: () => ({
    meta: { fuel_types: [], station_brands: [], sources: [], fuel_statuses: [], queue_levels: [] },
    loading: false,
    error: null,
    fuelLabel: (code: string) => code,
    statusLabel: (code: string) => code,
    queueLabel: (code: string) => code,
  }),
}));

afterEach(() => {
  cleanup();
  replaceMock.mockClear();
});

async function renderOpenPanel() {
  render(
    <I18nProvider>
      <FiltersProvider>
        <FiltersPanel />
      </FiltersProvider>
    </I18nProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
}

describe("FiltersPanel — без дубля радиуса и с выключателем «вероятного наличия»", () => {
  it("радиус не дублируется в панели — он наверху экрана (TopControls)", async () => {
    await renderOpenPanel();

    expect(screen.queryByRole("spinbutton", { name: "Радиус, км" })).toBeNull();
  });

  it("чекбокс «вероятного наличия» кладёт параметр в URL", async () => {
    await renderOpenPanel();

    await userEvent.click(screen.getByRole("checkbox", { name: "Показывать вероятное наличие" }));

    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("likely=1"), { scroll: false });
  });

  it("«Сбросить фильтры» возвращает адрес без параметров фильтров", async () => {
    await renderOpenPanel();

    await userEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));

    expect(replaceMock).toHaveBeenCalledWith("/", { scroll: false });
  });
});
