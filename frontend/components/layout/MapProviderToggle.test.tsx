import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapProviderToggle } from "@/components/layout/MapProviderToggle";
import { MapProviderPreferenceProvider } from "@/lib/hooks/useMapProviderPreference";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

describe("MapProviderToggle (R102.1)", () => {
  it("не рендерится вовсе без ключа Яндекс.Карт — не создаёт видимость несуществующего выбора", () => {
    vi.stubEnv("NEXT_PUBLIC_YANDEX_MAPS_API_KEY", "");
    render(
      <MapProviderPreferenceProvider>
        <MapProviderToggle />
      </MapProviderPreferenceProvider>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("по умолчанию OSM, даже когда ключ есть; переключение сохраняется в localStorage", async () => {
    vi.stubEnv("NEXT_PUBLIC_YANDEX_MAPS_API_KEY", "test-key");
    render(
      <MapProviderPreferenceProvider>
        <MapProviderToggle />
      </MapProviderPreferenceProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("OSM");

    const user = userEvent.setup();
    await user.click(button);

    await waitFor(() => expect(window.localStorage.getItem("fr_map_provider")).toBe("yandex"));
    expect(button).toHaveTextContent("Яндекс");
  });
});
