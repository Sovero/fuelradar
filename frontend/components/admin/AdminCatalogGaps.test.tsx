import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AdminCatalogGaps } from "@/components/admin/AdminCatalogGaps";
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

const GAPS = {
  total: 4,
  missing: { brand: 2, phone: 3, address: 1, any: 3 },
  sources: [{ code: "osm_overpass", name: "OSM/Overpass", stations: 1, fields: 2 }],
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
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
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

  it("честно пишет, когда кандидатов нет", async () => {
    renderGaps(
      vi.fn().mockResolvedValue(
        jsonResponse(200, { total: 3, missing: { brand: 0, phone: 0, address: 0, any: 0 }, sources: [], candidates: [] }),
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
