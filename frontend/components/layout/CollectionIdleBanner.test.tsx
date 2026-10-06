import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CollectionIdleBanner } from "@/components/layout/CollectionIdleBanner";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type { CollectionHealth } from "@/lib/types";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem("fr_locale");
});

function health(partial: Partial<CollectionHealth> = {}): CollectionHealth {
  return {
    state: "stalled",
    warning: true,
    reason: "no_success",
    mode: "external",
    mode_reason: null,
    tick_seconds: 10,
    last_success_at: "2026-10-06T09:00:00",
    age_minutes: 240,
    planned_at: "2026-10-06T10:00:00",
    overdue_minutes: null,
    next_run_at: "2026-10-06T10:00:00",
    next_tick_at: null,
    pending_jobs: 0,
    running_jobs: 0,
    stale_after_minutes: 180,
    overdue_after_minutes: 30,
    ...partial,
  };
}

function renderBanner(signal: CollectionHealth | null) {
  render(
    <I18nProvider>
      <CollectionIdleBanner health={signal} />
    </I18nProvider>,
  );
}

describe("CollectionIdleBanner (R58)", () => {
  it("молчит, когда сбора в порядке: предупреждение не должно быть шумом", () => {
    const { container } = render(
      <I18nProvider>
        <CollectionIdleBanner health={health({ state: "ok", warning: false, reason: null })} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("молчит, когда сигнала нет вовсе (нет ответа — нет и выдуманного предупреждения)", () => {
    const { container } = render(
      <I18nProvider>
        <CollectionIdleBanner health={null} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("выключенное расписание объясняет причину и показывает, что успехов не было", () => {
    renderBanner(health({ state: "disabled", reason: "schedule_off", last_success_at: null, age_minutes: null, planned_at: null }));
    expect(screen.getByRole("status")).toHaveAttribute("data-collection-state", "disabled");
    expect(screen.getByText(/расписание сбора выключено/)).toBeInTheDocument();
    expect(screen.getByText(/Статусы АЗС могут быть устаревшими/)).toBeInTheDocument();
    expect(screen.getByText("успешных сборов ещё не было")).toBeInTheDocument();
  });

  it("просроченный план показывает, на сколько он просрочен", () => {
    renderBanner(health({ state: "overdue", reason: "plan_overdue", overdue_minutes: 120, planned_at: "2026-10-06T08:00:00" }));
    expect(screen.getByText(/план сбора просрочен надолго/)).toBeInTheDocument();
    expect(screen.getByText(/план просрочен на 120 мин/)).toBeInTheDocument();
    expect(screen.getByText(/последний успешный сбор: /)).toBeInTheDocument();
  });

  it("без просрочки показывает время следующего сбора, а не пустоту", () => {
    renderBanner(health({ state: "stalled", overdue_minutes: null, planned_at: "2026-10-06T14:00:00" }));
    expect(screen.getByText(/Сбор данных молчит/)).toBeInTheDocument();
    expect(screen.getByText(/следующий сбор: /)).toBeInTheDocument();
  });

  it("показывает идущие задания, если они есть (это не «простой»)", () => {
    renderBanner(health({ state: "overdue", running_jobs: 2 }));
    expect(screen.getByText(/заданий выполняется: 2/)).toBeInTheDocument();
  });

  it("переключатель языка действует и на предупреждении (R100)", async () => {
    window.localStorage.setItem("fr_locale", "en");
    renderBanner(health({ state: "unplanned", reason: "nothing_planned" }));
    await waitFor(() => expect(screen.getByText(/No collection is planned/)).toBeInTheDocument());
    expect(screen.getByText(/Station statuses may be outdated/)).toBeInTheDocument();
    // Русский словарь по умолчанию тут не должен протекать.
    expect(screen.queryByText(/Сбор данных не запланирован/)).not.toBeInTheDocument();
  });
});
