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

const NETWORK_LISTS = { urls: ["https://lists.example.com/azs.geojson"], source: "db" };

/** Мок, знающий и таблицу источников, и пополняемый список URL (network-lists). */
function sourcesResponse(input: RequestInfo | URL, init?: RequestInit) {
  if (String(input).includes("/sources/network-lists")) return jsonResponse(200, NETWORK_LISTS);
  return jsonResponse(200, SOURCES);
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
    renderTable(vi.fn().mockImplementation(sourcesResponse));
    await waitFor(() => expect(screen.getByText("OSM/Overpass")).toBeInTheDocument());
    expect(screen.getByText("Яндекс.Карты")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("«обновить сейчас» ставит задание, не собирая синхронно (R53.1/R58.1)", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/refresh")) {
        return Promise.resolve(jsonResponse(200, { job_id: 42, provider: "osm_overpass", status: "PENDING", priority: "P1" }));
      }
      return sourcesResponse(url, init);
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
    renderTable(vi.fn().mockImplementation(sourcesResponse));
    await waitFor(() => expect(screen.getByText("Яндекс.Карты")).toBeInTheDocument());
    const buttons = screen.getAllByText("Обновить сейчас");
    expect(buttons[1]).toBeDisabled();
  });

  it("показывает файл файлового источника и когда он обновлялся (R58)", async () => {
    renderTable(vi.fn().mockImplementation(sourcesResponse));
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
    renderTable(vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const withoutFile2 = withoutFile.map((s) =>
        s.code === "network_import" && s.file ? { ...s, file: { ...s.file, exists: false, size_bytes: null, modified_at: null } } : s,
      );
      return sourcesResponse(url, init) ?? jsonResponse(200, withoutFile);
    }));
  });

  it("401 без cookie-сессии — понятная ошибка, не падение экрана", async () => {
    renderTable(vi.fn().mockResolvedValue(jsonResponse(401, { detail: "Требуется вход оператора" })));
    await waitFor(() => expect(screen.getByText("Требуется вход оператора")).toBeInTheDocument());
  });

  it("пополняемый список сетей: загрузка, сохранение PUT, возврат к .env при очистке", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/sources/network-lists") && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { urls: string[] };
        if (body.urls.length === 0) return Promise.resolve(jsonResponse(200, { urls: [], source: "env", count: 0, previous_count: 1, activated: false, job_id: null }));
        return Promise.resolve(jsonResponse(200, { urls: body.urls, source: "db", count: body.urls.length, previous_count: 1, activated: true, job_id: 77 }));
      }
      return sourcesResponse(url, init);
    });
    renderTable(fetchMock);
    await waitFor(() => expect(screen.getByText("Список сетей (URL)")).toBeInTheDocument(), { timeout: 3000 });

    // текущий список загружен в textarea
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("https://lists.example.com/azs.geojson"));
    expect(screen.getByText(/Действует список из админки: 1/)).toBeInTheDocument();

    // правка и сохранение → PUT с разобранными URL (по одному в строке)
    const user = userEvent.setup();
    await user.clear(textarea);
    await user.type(textarea, "https://new.example.com/a.json\nhttps://new.example.com/b.csv");
    await user.click(screen.getByText("Сохранить список"));

    await waitFor(() => expect(screen.getByText(/Список сохранён: 2/)).toBeInTheDocument());
    // обновление по запросу: сбор запущен сразу — уведомление об этом
    expect(screen.getByText(/активирован, сбор запущен сейчас/)).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/sources/network-lists") && (init as RequestInit)?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      urls: ["https://new.example.com/a.json", "https://new.example.com/b.csv"],
    });

    // очистка → честная пометка «действует дефолт из .env» (строка статуса обновляется)
    await user.clear(textarea);
    await user.click(screen.getByText("Сохранить список"));
    await waitFor(() => {
      const statusLine = screen.getByText(/^(Действует|Используется)/);
      expect(statusLine).toHaveTextContent(/дефолт из .env/);
      expect(statusLine).toHaveTextContent("0");
    });
  });

  it("некорректный URL отклоняется — ошибка сервера показана, список не тронут", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/sources/network-lists") && init?.method === "PUT") {
        return Promise.resolve(jsonResponse(422, { detail: "URL должен начинаться с http(s)://: not-a-url" }));
      }
      return sourcesResponse(url, init);
    });
    renderTable(fetchMock);
    await waitFor(() => expect(screen.getByText("Список сетей (URL)")).toBeInTheDocument(), { timeout: 3000 });

    const user = userEvent.setup();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("https://lists.example.com/azs.geojson"));
    await user.clear(textarea);
    await user.type(textarea, "not-a-url");
    await user.click(screen.getByText("Сохранить список"));

    await waitFor(() => expect(screen.getByText(/URL должен начинаться/)).toBeInTheDocument());
    // значение в textarea не сброшено — оператор не теряет ввод
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("not-a-url");
  });

  it("ADMIN редактирует trust/статус/интервал — PATCH с изменёнными значениями", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url.includes("/sources/1")) {
        return Promise.resolve(jsonResponse(200, { id: 1, code: "osm_overpass", changed: true, changes: { trust: { from: 0.7, to: 0.9 } } }));
      }
      return sourcesResponse(url, init);
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
