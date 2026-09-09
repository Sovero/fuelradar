import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminSourcesTable } from "@/components/admin/AdminSourcesTable";
import { AdminAuthProvider } from "@/lib/hooks/useAdminAuth";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type { AdminSourceOut } from "@/lib/types";

const SOURCES: AdminSourceOut[] = [
  {
    id: 1,
    code: "osm_overpass",
    name: "OSM/Overpass",
    status: "ACTIVE",
    trust: 0.7,
    capabilities: [],
    attribution: "© OpenStreetMap contributors",
    min_interval_minutes: 60,
    health: { state: "OK", last_check_at: "2026-09-09T10:00:00", last_success_at: "2026-09-09T10:00:00", consecutive_failures: 0, last_error: "" },
  },
  {
    id: 2,
    code: "yandex_maps",
    name: "Яндекс.Карты",
    status: "RESEARCH_REQUIRED",
    trust: 0.5,
    capabilities: [],
    attribution: "",
    min_interval_minutes: 60,
    health: { state: "UNKNOWN", last_check_at: null, last_success_at: null, consecutive_failures: 0, last_error: "" },
  },
];

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function renderTable(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <I18nProvider>
      <AdminAuthProvider>
        <AdminSourcesTable />
      </AdminAuthProvider>
    </I18nProvider>,
  );
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("AdminSourcesTable (R58)", () => {
  it("показывает таблицу «Источник / Состояние / Последний запрос / Ошибки»", async () => {
    renderTable(vi.fn().mockResolvedValue(jsonResponse(200, SOURCES)));
    await waitFor(() => expect(screen.getByText("OSM/Overpass")).toBeInTheDocument());
    expect(screen.getByText("Яндекс.Карты")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("«обновить сейчас» ставит задание, не собирая синхронно (R53.1/R58.1)", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/refresh")) {
        return Promise.resolve(jsonResponse(200, { job_id: 42, provider: "osm_overpass", status: "PENDING", priority: "P1" }));
      }
      return Promise.resolve(jsonResponse(200, SOURCES));
    });
    renderTable(fetchMock);
    await waitFor(() => expect(screen.getByText("OSM/Overpass")).toBeInTheDocument());

    const user = userEvent.setup();
    const buttons = screen.getAllByText("Обновить сейчас");
    await user.click(buttons[0]);

    await waitFor(() => expect(screen.getByText(/Задание поставлено в очередь/)).toBeInTheDocument());
    const refreshCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/refresh") && (init as RequestInit)?.method === "POST");
    expect(refreshCall).toBeDefined();
  });

  it("неактивный источник (RESEARCH_REQUIRED) — кнопка обновления недоступна", async () => {
    renderTable(vi.fn().mockResolvedValue(jsonResponse(200, SOURCES)));
    await waitFor(() => expect(screen.getByText("Яндекс.Карты")).toBeInTheDocument());
    const buttons = screen.getAllByText("Обновить сейчас");
    expect(buttons[1]).toBeDisabled();
  });

  it("401 без токена — понятная ошибка, не падение экрана", async () => {
    renderTable(vi.fn().mockResolvedValue(jsonResponse(401, { detail: "Требуется заголовок X-Admin-Token" })));
    await waitFor(() => expect(screen.getByText("Требуется заголовок X-Admin-Token")).toBeInTheDocument());
  });
});
