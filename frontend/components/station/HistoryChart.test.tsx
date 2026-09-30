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

  it("нет ценовых наблюдений → блока цены нет вовсе", async () => {
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
    expect(screen.queryByText(/Цена во времени/)).not.toBeInTheDocument();
    expect(screen.queryByText(/По цене/)).not.toBeInTheDocument();
  });

  it("одна цена → честная строка «мало данных», без графика", async () => {
    mockFetchOnce([
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-08T10:00:00", received_at: null, price: 59.9, price_currency: "RUB" },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 95, source: "OSM", observed_at: "2026-09-08T11:00:00", received_at: null },
    ]);
    render(
      <I18nProvider>
        <MetaProvider>
          <HistoryChart stationId="fr_station_1" fuelCode="AI_95" />
        </MetaProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText(/По цене данных пока мало — только одно наблюдение/)).toBeInTheDocument());
    expect(screen.queryByText(/Цена во времени/)).not.toBeInTheDocument();
  });

  it("≥2 ценовых точек → спарклайн цены с подписью и подсчётом пропусков", async () => {
    mockFetchOnce([
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-08T09:00:00", received_at: null, price: 58.0, price_currency: "RUB" },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 92, source: "OSM", observed_at: "2026-09-08T10:00:00", received_at: null },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 94, source: "OSM", observed_at: "2026-09-08T11:00:00", received_at: null },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 95, source: "OSM", observed_at: "2026-09-08T12:00:00", received_at: null, price: 60.5, price_currency: "RUB" },
    ]);
    render(
      <I18nProvider>
        <MetaProvider>
          <HistoryChart stationId="fr_station_1" fuelCode="AI_95" />
        </MetaProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Цена во времени/)).toBeInTheDocument());
    expect(screen.getByText(/2 точки/)).toBeInTheDocument();
    expect(screen.getByText(/2 записей без цены/)).toBeInTheDocument();
    expect(screen.getAllByRole("img").length).toBeGreaterThanOrEqual(2);
  });

  it("на графике цены подписаны мин и макс (58.00 ₽ и 60.50 ₽)", async () => {
    mockFetchOnce([
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-08T09:00:00", received_at: null, price: 58.0, price_currency: "RUB" },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 92, source: "OSM", observed_at: "2026-09-08T10:00:00", received_at: null },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 94, source: "OSM", observed_at: "2026-09-08T11:00:00", received_at: null },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 95, source: "OSM", observed_at: "2026-09-08T12:00:00", received_at: null, price: 60.5, price_currency: "RUB" },
    ]);
    render(
      <I18nProvider>
        <MetaProvider>
          <HistoryChart stationId="fr_station_1" fuelCode="AI_95" />
        </MetaProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Цена во времени/)).toBeInTheDocument());
    expect(screen.getByText("58.00 ₽")).toBeInTheDocument();
    expect(screen.getByText("60.50 ₽")).toBeInTheDocument();
  });

  it("цена одинакова во всех точках → подписи мин/макс не нужны", async () => {
    mockFetchOnce([
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 90, source: "OSM", observed_at: "2026-09-08T09:00:00", received_at: null, price: 60.0, price_currency: "RUB" },
      { fuel_code: "AI_95", status: "AVAILABLE", confidence_raw: 95, source: "OSM", observed_at: "2026-09-08T12:00:00", received_at: null, price: 60.0, price_currency: "RUB" },
    ]);
    render(
      <I18nProvider>
        <MetaProvider>
          <HistoryChart stationId="fr_station_1" fuelCode="AI_95" />
        </MetaProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Цена во времени/)).toBeInTheDocument());
    expect(screen.queryByText("60.00 ₽")).not.toBeInTheDocument();
  });
});
