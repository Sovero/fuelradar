import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpdatesPanel } from "@/components/settings/UpdatesPanel";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type { DesktopUpdateResult } from "@/lib/desktop";

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

/** Мост desktop-оболочки: версия + проверка обновлений. */
function installBridge(version: string, check: () => Promise<DesktopUpdateResult>) {
  window.fuelradarDesktop = { isDesktop: true, version, checkForUpdates: check };
}

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
