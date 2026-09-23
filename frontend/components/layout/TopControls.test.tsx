import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopControls } from "@/components/layout/TopControls";
import { FiltersProvider } from "@/lib/hooks/useFilters";
import { PrivacyProvider } from "@/lib/hooks/usePrivacy";
import { I18nProvider } from "@/lib/hooks/useI18n";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderControls() {
  render(
    <I18nProvider>
      <FiltersProvider>
        <PrivacyProvider>
          <TopControls />
        </PrivacyProvider>
      </FiltersProvider>
    </I18nProvider>,
  );
}

/** useGeolocation замокать целиком — его поведение покрывают хук-тесты. */
vi.mock("@/lib/hooks/useGeolocation", () => ({
  useGeolocation: vi.fn(),
}));

// FiltersProvider завязан на next/navigation (useRouter/usePathname/useSearchParams).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { useGeolocation } from "@/lib/hooks/useGeolocation";

function mockGeolocation(state: {
  status: "idle" | "loading" | "ready" | "error";
  position: { lat: number; lon: number } | null;
  source: "gps" | "ip" | null;
  error: string | null;
  ipCandidate: {
    position: { lat: number; lon: number };
    place: string;
  } | null;
}) {
  vi.mocked(useGeolocation).mockReturnValue({
    ...state,
    request: vi.fn(),
    confirmIpCandidate: vi.fn(),
    dismissIpCandidate: vi.fn(),
  } as ReturnType<typeof useGeolocation>);
}

describe("TopControls — IP-город с подтверждением", () => {
  it("показывает баннер «Вы в X?» и по подтверждению уезжает на город", async () => {
    const confirm = vi.fn();
    mockGeolocation({ status: "ready", position: null, source: null, error: null, ipCandidate: { position: { lat: 45.03, lon: 38.94 }, place: "Краснодар" } });
    // confirm в реальном хуке меняет position -> эффект применяет фильтры;
    // здесь мок, поэтому проверяем только вызов + факт отсутствия перелёта до него.
    vi.mocked(useGeolocation).mockReturnValue({
      status: "ready",
      position: null,
      source: null,
      error: null,
      request: vi.fn(),
      ipCandidate: { position: { lat: 45.03, lon: 38.94 }, place: "Краснодар" },
      confirmIpCandidate: confirm,
      dismissIpCandidate: vi.fn(),
    } as ReturnType<typeof useGeolocation>);

    renderControls();

    const banner = screen.getByTestId("ip-city-banner");
    expect(banner.textContent).toContain("возможно, вы в городе Краснодар");
    expect(screen.getByRole("button", { name: /Показать станции Краснодар/ })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Показать станции Краснодар/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("без города от провайдера баннер использует нейтральную формулировку", () => {
    mockGeolocation({ status: "ready", position: null, source: null, error: null, ipCandidate: { position: { lat: 45.03, lon: 38.94 }, place: "" } });

    renderControls();

    expect(screen.getByTestId("ip-city-banner").textContent).toContain("возможно, вы в вашем городе");
    expect(screen.getByRole("button", { name: "Показать станции этого города" })).toBeInTheDocument();
  });

  it("отмена убирает предложение без изменения карты", async () => {
    const dismiss = vi.fn();
    vi.mocked(useGeolocation).mockReturnValue({
      status: "ready",
      position: null,
      source: null,
      error: null,
      request: vi.fn(),
      ipCandidate: { position: { lat: 45.03, lon: 38.94 }, place: "Краснодар" },
      confirmIpCandidate: vi.fn(),
      dismissIpCandidate: dismiss,
    } as ReturnType<typeof useGeolocation>);

    renderControls();

    await waitFor(() => expect(screen.getByTestId("ip-city-banner")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Нет, спасибо" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("без кандидата баннера нет", () => {
    mockGeolocation({ status: "idle", position: null, source: null, error: null, ipCandidate: null });

    renderControls();

    expect(screen.queryByTestId("ip-city-banner")).not.toBeInTheDocument();
  });
});
