import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpdatesPanel } from "@/components/settings/UpdatesPanel";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type { DesktopFeedStatus, DesktopUpdateResult } from "@/lib/desktop";

afterEach(() => {
  cleanup();
  delete window.fuelradarDesktop;
  vi.restoreAllMocks();
});

function renderPanel() {
  render(
    <I18nProvider>
      <UpdatesPanel />
    </I18nProvider>,
  );
}

/** Мост desktop-оболочки: версия, проверка обновлений и (если есть) статус фида. */
function installBridge(
  version: string,
  check: () => Promise<DesktopUpdateResult>,
  feed?: (options?: { force?: boolean }) => Promise<DesktopFeedStatus>,
) {
  window.fuelradarDesktop = {
    isDesktop: true,
    version,
    checkForUpdates: check,
    ...(feed ? { feedStatus: feed } : {}),
  };
}

function feedStatus(partial: Partial<DesktopFeedStatus>): DesktopFeedStatus {
  return {
    state: "ok",
    message: "",
    release: null,
    updateAvailable: false,
    detail: null,
    fingerprint: "abc123def456",
    current: "0.1.1",
    checkedAt: "2026-09-19T10:00:00.000Z",
    tokenPacked: true,
    ...partial,
  };
}

const CHECK_UP_TO_DATE = () => Promise.resolve({ supported: true, current: "0.1.1", available: false, latest: null });

describe("UpdatesPanel (desktop-оболочка)", () => {
  it("показывает версию из моста", () => {
    installBridge("0.1.0", () => Promise.resolve({ supported: true, current: "0.1.0", available: false, latest: null }));
    renderPanel();

    expect(screen.getByText("0.1.0")).toBeInTheDocument();
  });

  it("проверка обновлений: актуальная версия → «последняя»", async () => {
    const check = vi.fn().mockResolvedValue({ supported: true, current: "0.1.0", available: false, latest: null });
    installBridge("0.1.0", check);
    renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Проверить обновления" }));

    await waitFor(() => expect(screen.getByText(/Установлена последняя версия/)).toBeInTheDocument());
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("доступное обновление показывает новую версию", async () => {
    installBridge("0.1.0", () =>
      Promise.resolve({ supported: true, current: "0.1.0", available: true, latest: "0.2.0" }),
    );
    renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Проверить обновления" }));

    await waitFor(() => expect(screen.getByText(/Доступна версия 0\.2\.0/)).toBeInTheDocument());
  });

  it("отклонение моста (сборка оболочки без IPC-хендлера) → честная ошибка", async () => {
    installBridge("0.1.0", () => Promise.reject(new Error("No handler registered for 'fuelradar:check-updates'")));
    renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Проверить обновления" }));

    await waitFor(() => expect(screen.getByText(/Не удалось проверить обновления/)).toBeInTheDocument());
  });

  it("самопроверка фида: доступен — релиз и отпечаток токена", async () => {
    installBridge("0.1.1", CHECK_UP_TO_DATE, () =>
      Promise.resolve(feedStatus({ state: "ok", release: { tag: "v0.1.1", name: null, publishedAt: null } })),
    );
    renderPanel();

    await waitFor(() => expect(screen.getByText("Доступен: последний релиз v0.1.1.")).toBeInTheDocument());
    // секрет не показывается — только отпечаток, по которому его можно сверить
    expect(screen.getByText(/токен: abc123def456 \(отпечаток\)/)).toBeInTheDocument();
  });

  it("самопроверка фида: токен не упакован → честная причина, а не «обновлений нет»", async () => {
    installBridge("0.1.1", CHECK_UP_TO_DATE, () =>
      Promise.resolve(feedStatus({ state: "no-token", fingerprint: null, tokenPacked: false })),
    );
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText("Токен фида не упакован в эту сборку — автообновление отключено.")).toBeInTheDocument(),
    );
    expect(screen.getByText(/токен не упакован/)).toBeInTheDocument();
  });

  it("самопроверка фида: нет доступа к приватному фиду — отдельный текст", async () => {
    installBridge("0.1.1", CHECK_UP_TO_DATE, () =>
      Promise.resolve(feedStatus({ state: "no-access", detail: "HTTP 404, список релизов → 404" })),
    );
    renderPanel();

    await waitFor(() => expect(screen.getByText(/Токен не даёт доступа к приватному фиду/)).toBeInTheDocument());
    // подробность (код ответа) остаётся в подсказке, не пугая текстом
    expect(screen.getByText(/Токен не даёт доступа к приватному фиду/)).toHaveAttribute(
      "title",
      "HTTP 404, список релизов → 404",
    );
  });

  it("самопроверка фида: доступ есть, релизов нет", async () => {
    installBridge("0.1.1", CHECK_UP_TO_DATE, () => Promise.resolve(feedStatus({ state: "no-release" })));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText("Доступ есть, но опубликованных релизов нет — обновляться не с чего.")).toBeInTheDocument(),
    );
  });

  it("старая сборка оболочки без IPC статуса — честное «не знаю», а не успех", async () => {
    installBridge("0.0.9", CHECK_UP_TO_DATE);
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/не сообщает состояние фида/)).toBeInTheDocument(),
    );
  });

  it("ручная проверка переспрашивает и фид (force), не дожидаясь кэша оболочки", async () => {
    const feed = vi.fn().mockResolvedValue(feedStatus({ state: "ok" }));
    installBridge("0.1.1", CHECK_UP_TO_DATE, feed);
    renderPanel();
    const user = userEvent.setup();

    await waitFor(() => expect(feed).toHaveBeenCalledWith({ force: false }));
    await user.click(screen.getByRole("button", { name: "Проверить обновления" }));

    await waitFor(() => expect(feed).toHaveBeenCalledWith({ force: true }));
  });

  it("ошибка фида: supported, но доступности нет → «последняя» с пометкой о сбое проверки", async () => {
    installBridge("0.1.0", () =>
      Promise.resolve({ supported: true, current: "0.1.0", available: false, latest: null, error: "ENOTFOUND" }),
    );
    renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Проверить обновления" }));

    await waitFor(() =>
      expect(screen.getByText(/Установлена последняя версия.*но проверить не удалось/)).toBeInTheDocument(),
    );
  });
});
