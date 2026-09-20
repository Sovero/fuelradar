import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WindowControls } from "@/components/layout/WindowControls";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type { DesktopWindowState } from "@/lib/desktop";

afterEach(() => {
  cleanup();
  delete window.fuelradarDesktop;
  vi.restoreAllMocks();
});

function renderControls() {
  render(
    <I18nProvider>
      <WindowControls />
    </I18nProvider>,
  );
}

function installBridge(overrides?: Partial<NonNullable<NonNullable<Window["fuelradarDesktop"]>["windowControls"]>>) {
  window.fuelradarDesktop = {
    isDesktop: true,
    version: "0.1.2",
    checkForUpdates: vi.fn(async () => ({ supported: false, reason: "тест" })),
    windowControls: {
      minimize: vi.fn(() => true),
      toggleMaximize: vi.fn(() => true),
      close: vi.fn(() => true),
      state: vi.fn(async (): Promise<DesktopWindowState> => ({ exists: true, isMaximized: false })),
      ...overrides,
    },
  };
  return window.fuelradarDesktop!.windowControls!;
}

describe("WindowControls", () => {
  it("в браузере (моста нет) не рисует ничего", () => {
    renderControls();
    expect(screen.queryByRole("group", { name: "Управление окном" })).toBeNull();
  });

  it("в сборке оболочки без моста windowControls (старее безрамочного режима) тоже не рисует ничего", () => {
    window.fuelradarDesktop = { isDesktop: true, version: "0.1.1", checkForUpdates: vi.fn(async () => ({ supported: false })) };
    renderControls();
    expect(screen.queryByRole("group", { name: "Управление окном" })).toBeNull();
  });

  it("с мостом рисует три кнопки и зовёт minimize/close", async () => {
    const controls = installBridge();
    renderControls();

    const group = await screen.findByRole("group", { name: "Управление окном" });
    expect(group).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Свернуть" }));
    expect(controls.minimize).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(controls.close).toHaveBeenCalledTimes(1);
  });

  it("«Развернуть» зовёт toggleMaximize и перечитывает состояние (метка становится «Восстановить»)", async () => {
    const controls = installBridge();
    (controls.state as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ exists: true, isMaximized: false })
      .mockResolvedValueOnce({ exists: true, isMaximized: true });
    renderControls();

    await userEvent.click(await screen.findByRole("button", { name: "Развернуть" }));
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Восстановить" })).not.toBeNull());
  });

  it("отказ state() не ломает кнопки (состояние не критично)", async () => {
    installBridge({ state: vi.fn(async () => Promise.reject(new Error("ipc down"))) });
    renderControls();
    expect(await screen.findByRole("button", { name: "Свернуть" })).not.toBeNull();
  });
});
