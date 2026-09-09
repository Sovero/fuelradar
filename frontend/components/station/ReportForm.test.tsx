import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportForm } from "@/components/station/ReportForm";
import { MetaProvider } from "@/lib/hooks/useMeta";
import { I18nProvider } from "@/lib/hooks/useI18n";
import { PrivacyProvider } from "@/lib/hooks/usePrivacy";
import { listOfflineReports } from "@/lib/offlineReports";

const META = {
  fuel_types: [{ code: "AI_95", name_ru: "АИ-95", commercial: [] }],
  station_brands: [],
  sources: [],
  fuel_statuses: [],
  queue_levels: [
    { code: "NONE", name_ru: "Нет" },
    { code: "LOW", name_ru: "Небольшая" },
    { code: "MEDIUM", name_ru: "Средняя" },
    { code: "HIGH", name_ru: "Большая" },
    { code: "VERY_HIGH", name_ru: "Очень большая" },
  ],
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function renderForm(reportResponder: () => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/meta")) return Promise.resolve(jsonResponse(200, META));
    if (url.includes("/reports")) return reportResponder();
    return Promise.resolve(jsonResponse(404, {}));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <I18nProvider>
      <PrivacyProvider>
        <MetaProvider>
          <ReportForm stationId="fr_station_1" stationLat={45.0} stationLon={38.0} onClose={() => {}} />
        </MetaProvider>
      </PrivacyProvider>
    </I18nProvider>,
  );
  return fetchMock;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("ReportForm (R39)", () => {
  it("пустая отправка отклоняется валидацией — ни одного топлива/очереди не отмечено", async () => {
    renderForm(() => Promise.resolve(jsonResponse(201, {})));
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("АИ-95")).toBeInTheDocument());
    await user.click(screen.getByText("Отправить"));
    expect(await screen.findByText("Отметьте хотя бы одно топливо или очередь")).toBeInTheDocument();
  });

  it("отправляет отчёт с идемпотентным ключом и показывает успех", async () => {
    const fetchMock = renderForm(() =>
      Promise.resolve(
        jsonResponse(201, { id: 1, station_id: "fr_station_1", gps_confirmed: false, distance_to_station_m: null, created: true, created_at: "now" }),
      ),
    );
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("АИ-95")).toBeInTheDocument());
    await user.click(screen.getByText("Есть"));
    await user.click(screen.getByText("Отправить"));

    await waitFor(() => expect(screen.getByText(/Спасибо/)).toBeInTheDocument());

    const reportCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/reports"));
    expect(reportCall).toBeDefined();
    const body = JSON.parse((reportCall![1] as RequestInit).body as string);
    expect(body.station_id).toBe("fr_station_1");
    expect(body.fuel).toEqual({ AI_95: "AVAILABLE" });
    expect(body.idempotency_key).toMatch(/^report:fr_station_1:\d+$/);
  });

  it("сеть недоступна — отчёт уходит в офлайн-очередь, а не теряется (R39.2)", async () => {
    renderForm(() => Promise.reject(new TypeError("Failed to fetch")));
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("АИ-95")).toBeInTheDocument());
    await user.click(screen.getAllByText("Нет")[0]);
    await user.click(screen.getByText("Отправить"));

    await waitFor(() => expect(screen.getByText(/Нет соединения/)).toBeInTheDocument());
    expect(listOfflineReports()).toHaveLength(1);
    expect(listOfflineReports()[0].body.fuel).toEqual({ AI_95: "UNAVAILABLE" });
  });
});
