import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HistoryChart } from "@/components/station/HistoryChart";
import { MetaProvider } from "@/lib/hooks/useMeta";
import { I18nProvider } from "@/lib/hooks/useI18n";

const EMPTY_META = { fuel_types: [], station_brands: [], sources: [], fuel_statuses: [], queue_levels: [] };

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function mockFetchOnce(historyBody: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/meta")) return Promise.resolve(jsonResponse(EMPTY_META));
      return Promise.resolve(jsonResponse(historyBody));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HistoryChart", () => {
  it("график открывается даже когда данных мало — с объяснением (R46.1)", async () => {
    mockFetchOnce([
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-08T10:00:00", received_at: null },
    ]);
    render(
      <I18nProvider>
        <MetaProvider>
          <HistoryChart stationId="fr_station_1" fuelCode="AI_95" />
        </MetaProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Данных пока мало/)).toBeInTheDocument());
  });

  it("рисует график при нескольких точках истории", async () => {
    mockFetchOnce([
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-08T10:00:00", received_at: null },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 95, source: "OSM", observed_at: "2026-09-08T11:00:00", received_at: null },
    ]);
    render(
      <I18nProvider>
        <MetaProvider>
          <HistoryChart stationId="fr_station_1" fuelCode="AI_95" />
        </MetaProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByRole("img", { name: "График истории" })).toBeInTheDocument());
  });
});
