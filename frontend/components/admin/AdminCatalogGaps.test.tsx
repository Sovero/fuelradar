import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminCatalogGaps, deferredRunLabel } from "@/components/admin/AdminCatalogGaps";
import { AdminAuthProvider } from "@/lib/hooks/useAdminAuth";
import { AuthProvider } from "@/lib/hooks/useAuth";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type { Meta } from "@/lib/types";

const META: Meta = {
  fuels: [
    { code: "AI_95", name_ru: "АИ-95", name_en: "AI-95", commercial: ["АИ-95-К5"] },
    { code: "AI_92", name_ru: "АИ-92", name_en: "AI-92", commercial: [] },
    { code: "DT", name_ru: "ДТ", name_en: "Diesel", commercial: [] },
    { code: "AI_100", name_ru: "АИ-100", name_en: "AI-100", commercial: [] },
    { code: "GAS", name_ru: "Газ", name_en: "Gas", commercial: [] },
  ],
  fuel_statuses: [
    { code: "AVAILABLE", name_ru: "Есть", name_en: "Available" },
    { code: "LIKELY_AVAILABLE", name_ru: "Скорее есть", name_en: "Likely available" },
    { code: "UNCERTAIN", name_ru: "Противоречивые данные", name_en: "Conflicting" },
    { code: "UNAVAILABLE", name_ru: "Нет", name_en: "Unavailable" },
    { code: "UNKNOWN", name_ru: "Нет данных", name_en: "Unknown" },
  ],
  queue_levels: [
    { code: "NONE", name_ru: "Нет", name_en: "None" },
    { code: "LOW", name_ru: "Небольшая", name_en: "Low" },
    { code: "MEDIUM", name_ru: "Средняя", name_en: "Medium" },
    { code: "HIGH", name_ru: "Большая", name_en: "High" },
    { code: "VERY_HIGH", name_ru: "Очень большая", name_en: "Very high" },
  ],
  station_brands: [{ id: 1, name: "Лукойл", canonical: "Лукойл" }],
  sources: [{ code: "osm_overpass", name: "OSM/Overpass", attribution: "© OpenStreetMap contributors" }],
  push: { enabled: false, public_key: null },
} as unknown as Meta;

const AUTH_USER = {
  id: 1,
  telegram_id: null,
  email: "operator@example.com",
  display_name: "Operator",
  role: "OPERATOR",
  reliability_score: 1,
};

/** Naive-UTC ISO, как в реальном ответе API (без смещения зоны). */
function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19);
}

const IMPORT_FILE = {
  path: "/data/import/catalog-enrichment.csv",
  name: "catalog-enrichment.csv",
  directory: "/data/import",
  exists: true,
  size_bytes: 2048,
  modified_at: minutesAgoIso(30),
  explicit: false,
  upload_dir: "/data/import",
  last_read_at: minutesAgoIso(120),
};

const GAPS = {
  total: 4,
  missing: { brand: 2, phone: 3, address: 1, any: 3 },
  sources: [{ code: "osm_overpass", name: "OSM/Overpass", stations: 1, fields: 2 }],
  import_file: IMPORT_FILE,
  candidates: [
    {
      station_id: "fr_station_000001",
      station_name: "АЗС без бренда",
      provider_code: "osm_overpass",
      provider_name: "OSM/Overpass",
      fields: ["brand", "phone"],
    },
    {
      station_id: "fr_station_000002",
      station_name: "АЗС полная",
      provider_code: "osm_overpass",
      provider_name: "OSM/Overpass",
      fields: ["address"],
    },
  ],
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body };
}

function renderGaps(
  fetchMock: ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => unknown),
) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/me")) return Promise.resolve(jsonResponse(200, { user: AUTH_USER }));
    if (url.includes("/auth/bootstrap")) return Promise.resolve(jsonResponse(200, { required: false }));
    return fetchMock(input, init);
  });
  render(
    <I18nProvider>
      <AuthProvider>
        <AdminAuthProvider>
          <AdminCatalogGaps />
        </AdminAuthProvider>
      </AuthProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("AdminCatalogGaps (пост-M16)", () => {
  it("кнопка «Импортировать CSV» отправляет файл с cookie-сессией и показывает результат", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("catalog-gaps/import-csv")) {
        return Promise.resolve(jsonResponse(200, { saved: "/data/import/catalog-enrichment.csv", rows: 3, job_id: 42, provider: "network_import" }));
      }
      return Promise.resolve(jsonResponse(200, GAPS));
    });
    renderGaps(fetchMock as unknown as ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => unknown));

    await waitFor(() => expect(screen.getByRole("button", { name: "Импортировать CSV" })).toBeInTheDocument());
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(["name,brand\n"], "filled.csv", { type: "text/csv" }));

    await waitFor(() => expect(screen.getByText(/№42/)).toBeInTheDocument());
    expect(screen.getByText(/строк сохранено — 3/)).toBeInTheDocument();
    const importCall = fetchMock.mock.calls.find(([u]) => String(u).includes("import-csv"));
    expect(importCall).toBeTruthy();
    const [, init] = importCall as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("импорт сообщает, что воркер возьмёт задание не раньше потолка частоты источника", async () => {
    const user = userEvent.setup();
    // backend отдаёт naive-UTC ISO без смещения — как в реальном ответе
    const naiveUtc = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 19);
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("catalog-gaps/import-csv")) {
        return Promise.resolve(jsonResponse(200, {
          saved: "/data/import/catalog-enrichment.csv",
          rows: 1,
          job_id: 7,
          provider: "network_import",
          next_run_at: naiveUtc,
        }));
      }
      return Promise.resolve(jsonResponse(200, GAPS));
    });
    renderGaps(fetchMock as unknown as ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => unknown));

    await waitFor(() => expect(screen.getByRole("button", { name: "Импортировать CSV" })).toBeInTheDocument());
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(["name,brand\n"], "filled.csv", { type: "text/csv" }));

    // плашка не обещает мгновенный результат: интервал источника ещё не истёк
    await waitFor(() => expect(screen.getByText(/не раньше/)).toBeInTheDocument());
    expect(screen.getByText(/задание сбора №7/)).toBeInTheDocument();
  });

  it("ошибка импорта (битый файл) показывается честно", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("catalog-gaps/import-csv")) {
        return Promise.resolve(jsonResponse(422, { detail: "Файл не разобран: строка 1: нет координат lat/lon" }));
      }
      return Promise.resolve(jsonResponse(200, GAPS));
    });
    renderGaps(fetchMock as unknown as ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => unknown));

    await waitFor(() => expect(screen.getByRole("button", { name: "Импортировать CSV" })).toBeInTheDocument());
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(["garbage"], "bad.csv", { type: "text/csv" }));

    await waitFor(() => expect(screen.getByText(/Файл не разобран/)).toBeInTheDocument());
  });

  it("кнопка «Скачать CSV» скачивает файл экспорта с cookie-сессией", async () => {
    const user = userEvent.setup();
    const csvBody = "name,brand,lat,lon,address,phone,ref,city,region,osm_url\nАЗС без бренда,Лукойл,45.055500,38.995300,,,,,,,https://www.openstreetmap.org/node/1\n";
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("catalog-gaps/export.csv")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => new Blob([csvBody], { type: "text/csv" }),
        });
      }
      return Promise.resolve(jsonResponse(200, GAPS));
    });
    renderGaps(fetchMock as unknown as ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => unknown));

    await waitFor(() => expect(screen.getByRole("button", { name: "Скачать CSV для заполнения" })).toBeInTheDocument());
    const created: Array<{ href: string; download: string }> = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:mock",
      revokeObjectURL: () => {},
    });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, opts?: ElementCreationOptions) => {
      const el = origCreate(tag, opts) as HTMLAnchorElement;
      if (tag === "a") {
        Object.defineProperty(el, "click", { value: () => created.push({ href: el.href, download: el.download }) });
      }
      return el;
    });

    await user.click(screen.getByRole("button", { name: "Скачать CSV для заполнения" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].download).toBe("catalog-gaps-enrichment-template.csv");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/catalog-gaps/export.csv",
      expect.objectContaining({ credentials: "include" }),
    );
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("показывает покрытие пустых полей и кандидатов дозаполнения", async () => {
    renderGaps(vi.fn().mockResolvedValue(jsonResponse(200, GAPS)));

    await waitFor(() => expect(screen.getByText("Покрытие каталога")).toBeInTheDocument());
    // агрегаты отрисованы как карточки с числом и долей
    expect(screen.getByText("Без бренда")).toBeInTheDocument();
    expect(screen.getByText("Без телефона")).toBeInTheDocument();
    expect(screen.getByText("Без адреса")).toBeInTheDocument();
    expect(screen.getByText("Хоть одно поле пусто")).toBeInTheDocument();
    expect(screen.getByText("Всего АЗС")).toBeInTheDocument();
    // кандидаты: названия и источники отрисованы, поля — тегами
    await waitFor(() => expect(screen.getByText("АЗС без бренда")).toBeInTheDocument());
    expect(screen.getByText("АЗС полная")).toBeInTheDocument();
    expect(screen.getByText("Бренд")).toBeInTheDocument();
    expect(screen.getByText("Телефон")).toBeInTheDocument();
    expect(screen.getByText("Адрес")).toBeInTheDocument();
  });

  it("показывает, какой файл читает источник и когда он обновлялся", async () => {
    renderGaps(vi.fn().mockResolvedValue(jsonResponse(200, GAPS)));

    await waitFor(() => expect(screen.getByText("Файл источника")).toBeInTheDocument());
    expect(screen.getByText("/data/import/catalog-enrichment.csv")).toBeInTheDocument();
    expect(screen.getByText("Источник читает")).toBeInTheDocument();
    // обе даты рядом: правка файла и последний успешный сбор
    expect(screen.getByText("Последний успешный сбор")).toBeInTheDocument();
    expect(screen.getByText(/^\d+ мин назад$/)).toBeInTheDocument(); // обновлён ~30 мин назад
    expect(screen.getByText(/^\d+ ч назад$/)).toBeInTheDocument(); // последний сбор ~2 ч назад
    // файл новее последнего сбора — честное предупреждение, а не «данные почему-то старые»
    expect(screen.getByText(/данные на диске, но воркер их ещё не забрал/)).toBeInTheDocument();
  });

  it("честно пишет, когда файла нет и сбор ещё не проходил", async () => {
    const empty = { ...GAPS, import_file: { ...IMPORT_FILE, exists: false, size_bytes: null, modified_at: null, last_read_at: null } };
    renderGaps(vi.fn().mockResolvedValue(jsonResponse(200, empty)));

    await waitFor(() => expect(screen.getByText("Файл источника")).toBeInTheDocument());
    expect(screen.getByText("файла нет — источник ждёт данных")).toBeInTheDocument();
    expect(screen.getByText("ещё не было")).toBeInTheDocument();
    expect(screen.queryByText(/данные на диске, но воркер/)).toBeNull();
  });

  it("видно, когда источник читает файл по явному пути вне каталога загрузки", async () => {
    const explicit = {
      ...GAPS,
      import_file: { ...IMPORT_FILE, path: "/srv/lists/krasnodar.csv", explicit: true, last_read_at: null },
    };
    renderGaps(vi.fn().mockResolvedValue(jsonResponse(200, explicit)));

    await waitFor(() => expect(screen.getByText("/srv/lists/krasnodar.csv")).toBeInTheDocument());
    expect(screen.getByText(/импорт из админки попадёт в \/data\/import/)).toBeInTheDocument();
  });

  it("после импорта показывает файл, который только что записан", async () => {
    const user = userEvent.setup();
    const beforeImport = { ...GAPS, import_file: { ...IMPORT_FILE, exists: false, size_bytes: null, modified_at: null } };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("catalog-gaps/import-csv")) {
        return Promise.resolve(jsonResponse(200, {
          saved: "/data/import/catalog-enrichment.csv",
          rows: 2,
          job_id: 9,
          provider: "network_import",
          file: { ...IMPORT_FILE, size_bytes: 512, modified_at: minutesAgoIso(0) },
        }));
      }
      return Promise.resolve(jsonResponse(200, beforeImport));
    });
    renderGaps(fetchMock as unknown as ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => unknown));

    await waitFor(() => expect(screen.getByText("файла нет — источник ждёт данных")).toBeInTheDocument());
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(["name,brand\n"], "filled.csv", { type: "text/csv" }));

    await waitFor(() => expect(screen.queryByText("файла нет — источник ждёт данных")).toBeNull());
    expect(screen.getByText("только что")).toBeInTheDocument();
  });

  it("честно пишет, когда кандидатов нет", async () => {
    renderGaps(
      vi.fn().mockResolvedValue(
        jsonResponse(200, { total: 3, missing: { brand: 0, phone: 0, address: 0, any: 0 }, sources: [], candidates: [], import_file: null }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Кандидатов нет — все поля, известные источникам, уже в каталоге.")).toBeInTheDocument());
    expect(screen.getByText("У записей источников нет полей, которых не хватает мастер-каталогу.")).toBeInTheDocument();
  });

  it("401/403 превращаются в ошибку авторизации", async () => {
    renderGaps(vi.fn().mockResolvedValue(jsonResponse(401, { detail: "Требуется вход" })));
    await waitFor(() => expect(screen.getByText(/Требуется вход/i)).toBeInTheDocument());
  });
});

describe("deferredRunLabel (время запуска импорта)", () => {
  it("naive-UTC без смещения читается как UTC, а не как локальное время", () => {
    const naiveUtc = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 19);
    const label = deferredRunLabel(naiveUtc);
    expect(label).not.toBeNull();
    // без перевода в UTC браузер сдвинул бы время на смещение зоны
    const expected = new Date(`${naiveUtc}Z`).toLocaleString();
    expect(label).toBe(expected);
  });

  it("молчит, когда задание идёт на ближайшем тике", () => {
    expect(deferredRunLabel(null)).toBeNull();
    expect(deferredRunLabel(undefined)).toBeNull();
    expect(deferredRunLabel(new Date(Date.now() - 60_000).toISOString())).toBeNull();
    expect(deferredRunLabel("не-дата")).toBeNull();
  });
});
