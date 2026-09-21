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
  {
    id: 3,
    code: "network_import",
    name: "Импорт списков сетей (CSV/JSON)",
    status: "ACTIVE",
    trust: 0.8,
    capabilities: [],
    attribution: "",
    min_interval_minutes: 5,
    health: { state: "DEGRADED", last_check_at: null, last_success_at: null, consecutive_failures: 0, last_error: "" },
    file: {
      path: "/data/import/catalog-enrichment.csv",
      name: "catalog-enrichment.csv",
      directory: "/data/import",
      exists: true,
      size_bytes: 2048,
      modified_at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19),
      explicit: false,
      upload_dir: "/data/import",
    },
  },
];

const AUTH_USER = {
  id: 1,
  telegram_id: null,
  email: "admin@example.com",
  display_name: "Test administrator",
  role: "ADMIN",
  reliability_score: 1,
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function renderTable(fetchMock: ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => unknown)) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/me")) return Promise.resolve(jsonResponse(200, { user: AUTH_USER }));
    if (url.includes("/auth/bootstrap")) return Promise.resolve(jsonResponse(200, { required: false }));
    return fetchMock(input, init);
  });
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

  it("показывает файл файлового источника и когда он обновлялся (R58)", async () => {
    renderTable(vi.fn().mockResolvedValue(jsonResponse(200, SOURCES)));
    await waitFor(() => expect(screen.getByText("Импорт списков сетей (CSV/JSON)")).toBeInTheDocument());

    const line = screen.getByText(/Читает файл:/);
    expect(line).toHaveTextContent("/data/import/catalog-enrichment.csv");
    expect(line).toHaveTextContent(/обновлён \d+ мин назад/);
    // только у файлового источника — у сетевых этой строки нет
    expect(screen.getAllByText(/Читает файл:/)).toHaveLength(1);
  });

  it("честно пишет, что файла источника нет", async () => {
    const withoutFile = SOURCES.map((s) =>
      s.code === "network_import" && s.file
        ? { ...s, file: { ...s.file, exists: false, size_bytes: null, modified_at: null } }
        : s,
    );
    renderTable(vi.fn().mockResolvedValue(jsonResponse(200, withoutFile)));

    await waitFor(() => expect(screen.getByText("Импорт списков сетей (CSV/JSON)")).toBeInTheDocument());
    expect(screen.getByText(/Читает файл:/)).toHaveTextContent("файла нет — ждёт данных");
  });

  it("401 без cookie-сессии — понятная ошибка, не падение экрана", async () => {
    renderTable(vi.fn().mockResolvedValue(jsonResponse(401, { detail: "Требуется вход оператора" })));
    await waitFor(() => expect(screen.getByText("Требуется вход оператора")).toBeInTheDocument());
  });

  it("ADMIN редактирует trust/статус/интервал — PATCH с изменёнными значениями", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url.includes("/sources/1")) {
        return Promise.resolve(jsonResponse(200, { id: 1, code: "osm_overpass", changed: true, changes: { trust: { from: 0.7, to: 0.9 } } }));
      }
      return Promise.resolve(jsonResponse(200, SOURCES));
    });
    renderTable(fetchMock);
    await waitFor(() => expect(screen.getByText("OSM/Overpass")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getAllByText("Изменить")[0]);
    const trustInput = screen.getAllByDisplayValue("0.7")[0];
    await user.clear(trustInput);
    await user.type(trustInput, "0.9");
    const intervalInput = screen.getAllByDisplayValue("60")[0];
    await user.clear(intervalInput);
    await user.type(intervalInput, "30");
    await user.click(screen.getAllByText("Сохранить")[0]);

    await waitFor(() => expect(screen.getByText("Изменения сохранены")).toBeInTheDocument());
    const patchCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/sources/1") && (init as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.trust).toBe(0.9);
    expect(body.min_interval_minutes).toBe(30);
    expect(body.status).toBe("ACTIVE");
  });
});
