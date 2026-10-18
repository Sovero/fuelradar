import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminCollectionCycles } from "@/components/admin/AdminCollectionCycles";
import { AdminAuthProvider } from "@/lib/hooks/useAdminAuth";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type { CollectionCyclesOut } from "@/lib/types";

const AUTH_USER = {
  id: 1,
  telegram_id: null,
  email: "operator@example.com",
  display_name: "Operator",
  role: "ADMIN",
  reliability_score: 1,
};

/** Naive-UTC ISO, как в реальном ответе API (без смещения зоны). */
function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19);
}

function minutesAheadIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 19);
}

const CYCLES: CollectionCyclesOut = {
  now: minutesAgoIso(0),
  scheduler: {
    mode: "external",
    reason: "",
    collect_in_process: false,
    tick_seconds: 10,
    pending_jobs: 2,
    running_jobs: 1,
    last_tick_at: null,
    last_tick_status: null,
    next_tick_at: null,
  },
  sources: [
    {
      id: 1,
      code: "osm_overpass",
      name: "OSM/Overpass",
      status: "ACTIVE",
      collectable: true,
      min_interval_minutes: 1440,
      health: "ONLINE",
      last_success_at: minutesAgoIso(120),
      last_attempt_at: minutesAgoIso(120),
      consecutive_failures: 0,
      last_error: "",
      waiting_reason: null,
      next_run_at: minutesAheadIso(30),
      queued_job_id: 7,
      active_job_status: "PENDING",
      running_jobs: 0,
      running_job_id: null,
      running_since: null,
      last_job: {
        id: 5,
        job_type: "catalog",
        trigger: "schedule",
        status: "DONE",
        records_count: 12,
        error_count: 0,
        error_message: "",
        started_at: minutesAgoIso(122),
        finished_at: minutesAgoIso(121),
      },
    },
    {
      id: 2,
      code: "network_import",
      name: "Импорт списков сетей (CSV/JSON)",
      status: "ACTIVE",
      collectable: true,
      min_interval_minutes: 5,
      health: "OFFLINE",
      last_success_at: null,
      last_attempt_at: minutesAgoIso(10),
      consecutive_failures: 3,
      last_error: "FileNotFoundError",
      waiting_reason: null,
      next_run_at: minutesAheadIso(45),
      queued_job_id: null,
      active_job_status: null,
      running_jobs: 0,
      running_job_id: null,
      running_since: null,
      last_job: {
        id: 6,
        job_type: "catalog",
        trigger: "schedule",
        status: "FAILED",
        records_count: 0,
        error_count: 1,
        error_message: "FileNotFoundError",
        started_at: minutesAgoIso(11),
        finished_at: minutesAgoIso(10),
      },
    },
    {
      id: 3,
      code: "user_reports",
      name: "Отчёты пользователей",
      status: "ACTIVE",
      collectable: false,
      min_interval_minutes: 60,
      health: "UNKNOWN",
      last_success_at: null,
      last_attempt_at: null,
      consecutive_failures: 0,
      last_error: "",
      waiting_reason: null,
      next_run_at: null,
      queued_job_id: null,
      active_job_status: null,
      running_jobs: 0,
      running_job_id: null,
      running_since: null,
      last_job: null,
    },
    {
      id: 4,
      code: "network_lists",
      name: "Сетевые списки АЗС (HTTP)",
      status: "NOT_USED",
      collectable: false,
      min_interval_minutes: 1440,
      health: "UNKNOWN",
      last_success_at: null,
      last_attempt_at: null,
      consecutive_failures: 0,
      last_error: "",
      waiting_reason: null,
      next_run_at: null,
      queued_job_id: null,
      active_job_status: null,
      running_jobs: 0,
      running_job_id: null,
      running_since: null,
      last_job: null,
    },
  ],
};

/** Первый источник собирается прямо сейчас: RUNNING-задание и его длительность. */
const RUNNING_CYCLES: CollectionCyclesOut = {
  ...CYCLES,
  scheduler: { ...CYCLES.scheduler, running_jobs: 1 },
  sources: [
    {
      ...CYCLES.sources[0],
      active_job_status: "RUNNING",
      running_jobs: 1,
      running_job_id: 7,
      running_since: minutesAgoIso(2),
    },
    ...CYCLES.sources.slice(1),
  ],
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

/** Тело можно собрать функцией: живой сервер отвечает своим «сейчас» на каждый запрос. */
function installFetch(body: unknown | (() => unknown), status = 200) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/me")) return jsonResponse(200, { user: AUTH_USER });
    if (url.includes("/auth/bootstrap")) return jsonResponse(200, { required: false });
    return jsonResponse(status, typeof body === "function" ? (body as () => unknown)() : body);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Запросы именно журнала: остальное (auth-проверки) в счёт не идёт. */
function cyclesCalls(calls: unknown[][]): number {
  return calls.filter(([input]) => String(input).includes("collection-cycles")).length;
}

function renderTab() {
  render(
    <I18nProvider>
      <AdminAuthProvider>
        <AdminCollectionCycles />
      </AdminAuthProvider>
    </I18nProvider>,
  );
}

function renderCycles(body: unknown, status = 200) {
  installFetch(body, status);
  renderTab();
}

/**
 * Промис-цепочку запроса разрешаем микрозадачами: с fake timers `waitFor` не
 * дружит (vitest не подменяет глобальный `jest`, по которому он распознаёт
 * фейковые таймеры), поэтому ожидание здесь явное.
 */
async function flush(rounds = 5) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  // Период автообновления живёт в localStorage — тесты не должны влиять друг на друга.
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AdminCollectionCycles (R58)", () => {
  it("показывает последний успех, следующий запуск и очередь по каждому источнику", async () => {
    renderCycles(CYCLES);

    await waitFor(() => expect(screen.getByText("OSM/Overpass")).toBeInTheDocument());
    // последний успешный сбор — 2 часа назад
    expect(screen.getByText("2 ч назад")).toBeInTheDocument();
    // следующий запуск — в будущем: «через N мин», а не «N мин назад»
    expect(screen.getByText("через 30 мин")).toBeInTheDocument();
    // задание уже в очереди воркера — это видно явно
    expect(screen.getByText(/в очереди, задание №7/)).toBeInTheDocument();
    // последний цикл: статус, объём, триггер
    expect(screen.getByText(/записей: 12/)).toBeInTheDocument();
  });

  it("показывает причину сбоя и число неудач подряд", async () => {
    renderCycles(CYCLES);

    await waitFor(() => expect(screen.getByText("Импорт списков сетей (CSV/JSON)")).toBeInTheDocument());
    expect(screen.getByText("3 подряд · FileNotFoundError")).toBeInTheDocument();
    expect(screen.getByText("FAILED", { exact: false })).toBeInTheDocument();
    // ни разу не собирался — честное «ещё не было», а не пустая ячейка
    expect(screen.getAllByText("ещё не было").length).toBeGreaterThan(0);
  });

  it("различает push-источник отчётов и неактивный источник", async () => {
    renderCycles(CYCLES);

    await waitFor(() => expect(screen.getByText("Отчёты пользователей")).toBeInTheDocument());
    // user_reports: данные приходят с устройств, опроса нет
    expect(screen.getByText("не опрашивается (отчёты приходят с устройств)")).toBeInTheDocument();
    // NOT_USED/RESEARCH_REQUIRED: та же пустая ячейка, но по другой причине
    expect(screen.getByText("Сетевые списки АЗС (HTTP)")).toBeInTheDocument();
    expect(screen.getByText("не опрашивается: источник не активен")).toBeInTheDocument();
  });

  it("источник без данных показывает «ждёт данных», а не сбой и не план", async () => {
    const reason = "файл импорта не найден: C:\\data\\catalog-enrichment.csv";
    renderCycles({
      ...CYCLES,
      sources: [
        {
          ...CYCLES.sources[1],
          health: "DEGRADED",
          consecutive_failures: 0,
          last_error: reason,
          waiting_reason: reason,
          next_run_at: null,
          last_job: null,
        },
      ],
    });

    await waitFor(() => expect(screen.getByText("Импорт списков сетей (CSV/JSON)")).toBeInTheDocument());
    // «ждёт данных» вместо счётчика/обратного отсчёта; причина — в подсказке
    const waiting = screen.getByText("ждёт данных");
    expect(waiting).toHaveAttribute("title", reason);
    expect(screen.queryByText("нет запланированного запуска")).not.toBeInTheDocument();
    expect(screen.queryByText("FAILED")).not.toBeInTheDocument();
    // состояние — DEGRADED (янтарный), не красный OFFLINE
    expect(screen.getByText("DEGRADED")).toBeInTheDocument();
  });

  it("просроченный план помечен «просрочено», а не «вот-вот»", async () => {
    renderCycles({
      ...CYCLES,
      sources: [{ ...CYCLES.sources[0], next_run_at: minutesAgoIso(600), queued_job_id: null }],
    });
    await waitFor(() => expect(screen.getByText("просрочено")).toBeInTheDocument());
  });

  it("честно описывает режим планировщика: отдельный воркер и очередь", async () => {
    renderCycles(CYCLES);

    await waitFor(() => expect(screen.getByText("Планировщик")).toBeInTheDocument());
    expect(screen.getByText(/отдельный воркер \(python -m app\.worker\)/)).toBeInTheDocument();
    expect(screen.getByText(/в очереди: 2/)).toBeInTheDocument();
    expect(screen.getByText(/выполняется: 1/)).toBeInTheDocument();
    // такт виден, даже когда сбор ведёт не этот процесс
    expect(screen.getByText("10 с")).toBeInTheDocument();
  });

  it("для сбора в этом процессе показывает последний и следующий тик", async () => {
    renderCycles({
      ...CYCLES,
      scheduler: {
        ...CYCLES.scheduler,
        mode: "in_process",
        collect_in_process: true,
        last_tick_at: minutesAgoIso(1),
        last_tick_status: "collected:2",
        next_tick_at: minutesAheadIso(5),
      },
    });

    await waitFor(() => expect(screen.getByText(/в этом процессе, такт 10 с/)).toBeInTheDocument());
    expect(screen.getByText(/collected:2/)).toBeInTheDocument();
    expect(screen.getByText("через 5 мин")).toBeInTheDocument();
  });

  it("401 показывается понятной ошибкой, а не падением экрана", async () => {
    renderCycles({ detail: "Требуется вход оператора" }, 401);
    await waitFor(() => expect(screen.getByText(/Требуется вход/)).toBeInTheDocument());
  });

  it("подсвечивает источник, у которого цикл идёт прямо сейчас, и не зовёт его «в очереди»", async () => {
    renderCycles(RUNNING_CYCLES);

    await waitFor(() => expect(screen.getByText("OSM/Overpass")).toBeInTheDocument());
    // длительность и номер задания — из факта RUNNING, а не из плана
    expect(screen.getByText(/идёт сейчас · 2 мин · задание №7/)).toBeInTheDocument();
    expect(screen.getByText("OSM/Overpass").closest("tr")).toHaveAttribute("data-running", "true");
    // RUNNING и PENDING — разные состояния: «в очереди» про идущий цикл было бы неправдой
    expect(screen.queryByText(/в очереди, задание №7/)).toBeNull();
    // у остальных источников подсветки нет
    expect(screen.getByText("Импорт списков сетей (CSV/JSON)").closest("tr")).not.toHaveAttribute("data-running");
  });

  it("несколько идущих заданий показаны числом, а не одним", async () => {
    renderCycles({
      ...RUNNING_CYCLES,
      sources: [
        { ...RUNNING_CYCLES.sources[0], running_jobs: 3, running_since: minutesAgoIso(0) },
        ...RUNNING_CYCLES.sources.slice(1),
      ],
    });

    await waitFor(() => expect(screen.getByText(/заданий: 3/)).toBeInTheDocument());
  });

  it("период автообновления вводится вручную и действует сразу после Enter", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch(CYCLES);
    renderTab();
    await flush();

    // Дефолт — 60 с, он же сохранён в предпочтениях.
    const field = screen.getByTestId("refresh-seconds");
    expect(field).toHaveValue(60);

    fireEvent.change(field, { target: { value: "20" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue(20);
    expect(localStorage.getItem("fuelradar:cycles-refresh-seconds")).toBe("20");

    // Пока не прошло 20 с — запросов по расписанию нет; после — есть.
    await act(async () => {
      vi.advanceTimersByTime(19_000);
    });
    expect(cyclesCalls(fetchMock.mock.calls)).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(cyclesCalls(fetchMock.mock.calls)).toBe(2);
  });

  it("мусор в поле не превращается в частый опрос: значение нормализуется", async () => {
    renderCycles(CYCLES);
    await waitFor(() => expect(screen.getByText("OSM/Overpass")).toBeInTheDocument());

    const field = screen.getByTestId("refresh-seconds");
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.blur(field);
    // Ниже границы — честно показываем то, что действует, а не введённое «3».
    expect(field).toHaveValue(5);
    expect(localStorage.getItem("fuelradar:cycles-refresh-seconds")).toBe("5");
  });

  it("обратный отсчёт до следующего тика тикает сам, без перезапроса журнала", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
    // План тика фиксирован (его пишет сам сборщик), а `now` сервер отдаёт свежий —
    // как в жизни: между тиками план не меняется, время идёт.
    const tickAt = new Date(Date.now() + 45_000).toISOString().slice(0, 19);
    const fetchMock = installFetch(() => ({
      ...CYCLES,
      now: new Date().toISOString().slice(0, 19),
      scheduler: {
        ...CYCLES.scheduler,
        mode: "in_process",
        collect_in_process: true,
        next_tick_at: tickAt,
      },
    }));
    renderTab();
    await flush();

    expect(screen.getByTestId("next-tick")).toHaveTextContent("через 45 с");
    expect(cyclesCalls(fetchMock.mock.calls)).toBe(1);

    // Двадцать секунд по пять: отсчёт идёт по секундным часам, а журнал в это
    // время не перезапрашивается вовсе — период по умолчанию 60 с.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      await flush(2);
      expect(cyclesCalls(fetchMock.mock.calls)).toBe(1);
    }

    expect(screen.getByTestId("next-tick")).toHaveTextContent("через 25 с");
  });

  it("опросы не наслаиваются: пока ответ не пришёл, новый запрос не уходит", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/")) return jsonResponse(200, { required: false });
      calls += 1;
      return new Promise(() => {}); // сервер молчит: ответа нет
    });
    vi.stubGlobal("fetch", mock);
    renderTab();
    await flush();
    expect(calls).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    // Три такта прошло — но журнал не заваливается запросами в пустоту.
    expect(calls).toBe(1);
  });

  it("автообновляет журнал со своим периодом (по умолчанию 60 с) и говорит, когда обновлялся", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch(CYCLES);
    renderTab();
    await flush();

    expect(cyclesCalls(fetchMock.mock.calls)).toBe(1);
    expect(screen.getByTestId("cycles-updated-at")).toHaveTextContent("обновлено только что");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(cyclesCalls(fetchMock.mock.calls)).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId("cycles-updated-at")).toHaveTextContent("обновлено 3 с назад");
  });

  it("сбой фонового опроса не стирает журнал: честная пометка вместо пустого экрана", async () => {
    vi.useFakeTimers();
    let fail = false;
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) return jsonResponse(200, { user: AUTH_USER });
      if (url.includes("/auth/bootstrap")) return jsonResponse(200, { required: false });
      if (fail) throw new Error("offline");
      return jsonResponse(200, CYCLES);
    });
    vi.stubGlobal("fetch", mock);
    renderTab();
    await flush();
    expect(screen.getByText("OSM/Overpass")).toBeInTheDocument();

    fail = true;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();

    // данные на экране остались, появилась пометка — но не выдуманное состояние сбора
    expect(screen.getByText("OSM/Overpass")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/не удалось обновить журнал/);
  });

  it("скрытое окно не опрашивается, а возвращение обновляет сразу", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch(CYCLES);
    renderTab();
    await flush();
    expect(cyclesCalls(fetchMock.mock.calls)).toBe(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    try {
      await act(async () => {
        vi.advanceTimersByTime(120_000);
      });
      // невидимый экран свежести не требует — запросы не тратятся впустую
      expect(cyclesCalls(fetchMock.mock.calls)).toBe(1);

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await flush();
      expect(cyclesCalls(fetchMock.mock.calls)).toBe(2);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });
});
