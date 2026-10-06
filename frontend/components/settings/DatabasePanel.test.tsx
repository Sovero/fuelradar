import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatabasePanel } from "@/components/settings/DatabasePanel";
import { I18nProvider } from "@/lib/hooks/useI18n";
import type {
  DesktopDatabaseBackupResult,
  DesktopDatabaseMigrateResult,
  DesktopDatabaseStatus,
} from "@/lib/desktop";

afterEach(() => {
  cleanup();
  delete window.fuelradarDesktop;
  vi.restoreAllMocks();
});

function renderPanel() {
  render(
    <I18nProvider>
      <DatabasePanel />
    </I18nProvider>,
  );
}

function status(partial: Partial<DesktopDatabaseStatus> = {}): DesktopDatabaseStatus {
  return {
    supported: true,
    reason: null,
    external: false,
    externalUrl: null,
    externalSource: null,
    dataDir: "C:\\Users\\pilot\\AppData\\Roaming\\FuelRadar\\data",
    localFile: "C:\\Users\\pilot\\AppData\\Roaming\\FuelRadar\\data\\fuelradar.db",
    localExists: true,
    localBytes: 2048,
    localModifiedAt: "2026-10-06T07:00:00.000Z",
    backupDir: "C:\\Users\\pilot\\AppData\\Roaming\\FuelRadar\\data\\backups",
    newestBackup: null,
    migrationSupported: false,
    ...partial,
  };
}

/** Мост desktop-оболочки: панель «Данные» поверх IPC датабазы. */
function installBridge(overrides: {
  status?: () => Promise<DesktopDatabaseStatus>;
  backup?: () => Promise<DesktopDatabaseBackupResult>;
  exportCopy?: () => Promise<DesktopDatabaseBackupResult>;
  migrate?: () => Promise<DesktopDatabaseMigrateResult>;
  reveal?: (target: string) => Promise<{ ok: boolean }>;
} = {}) {
  const reveal = overrides.reveal ?? vi.fn(async () => ({ ok: true }));
  window.fuelradarDesktop = {
    isDesktop: true,
    version: "0.1.8",
    checkForUpdates: async () => ({ supported: false }),
    database: {
      status: overrides.status ?? (async () => status()),
      backup: overrides.backup ?? (async () => ({ ok: true })),
      exportCopy: overrides.exportCopy ?? (async () => ({ ok: true })),
      migrate: overrides.migrate ?? (async () => ({ ok: true })),
      reveal,
    },
  };
  return { reveal };
}

describe("DatabasePanel (desktop-оболочка)", () => {
  it("без моста честно говорит, что состояние данных неизвестно", async () => {
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText(/Состояние данных неизвестно/),
      ).toBeInTheDocument(),
    );
  });

  it("показывает локальную базу, её размер и последнюю копию", async () => {
    installBridge({
      status: async () =>
        status({
          newestBackup: {
            path: "C:\\...\\data\\backups\\fuelradar-20261006-070509.db",
            bytes: 4096,
            modifiedAt: "2026-10-06T07:05:09.000Z",
          },
        }),
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText(/fuelradar\.db$/)).toBeInTheDocument());
    expect(screen.getByText("2,0 КБ", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/fuelradar-20261006-070509\.db \(4,0 КБ\)/)).toBeInTheDocument();
    // Переноса нет — вместо кнопки честное «не настроено».
    expect(screen.getByText(/Внешняя база не настроена/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Перенести данные" })).not.toBeInTheDocument();
  });

  it("снимает копию, показывает путь и число записей и умеет открыть папку", async () => {
    const { reveal } = installBridge({
      backup: async () => ({
        ok: true,
        path: "C:\\Users\\pilot\\AppData\\Roaming\\FuelRadar\\data\\backups\\fuelradar-20261006-070509.db",
        bytes: 2048,
        rows: 42,
        created_at: "2026-10-06T07:05:09.000Z",
      }),
    });
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Создать резервную копию" })).toBeEnabled());

    await userEvent.click(screen.getByRole("button", { name: "Создать резервную копию" }));

    await waitFor(() => expect(screen.getByText(/Копия готова: .*fuelradar-20261006-070509\.db/)).toBeInTheDocument());
    expect(screen.getByText(/Записей в копии: 42/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Показать в папке" }));
    expect(reveal).toHaveBeenCalledWith(
      "C:\\Users\\pilot\\AppData\\Roaming\\FuelRadar\\data\\backups\\fuelradar-20261006-070509.db",
    );
  });

  it("экспорт в выбранное место: отмена — это честная отмена, а не успех", async () => {
    installBridge({
      exportCopy: async () => ({ ok: false, canceled: true }),
    });
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Экспортировать копию…" })).toBeEnabled());

    await userEvent.click(screen.getByRole("button", { name: "Экспортировать копию…" }));

    await waitFor(() => expect(screen.getByText(/Экспорт отменён — копия не создавалась\./)).toBeInTheDocument());
    expect(screen.queryByText(/Копия готова/)).not.toBeInTheDocument();
  });

  it("ошибка копии показывается причиной, а не «готово»", async () => {
    installBridge({
      backup: async () => ({ ok: false, error: "локальная база не найдена" }),
    });
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Создать резервную копию" })).toBeEnabled());

    await userEvent.click(screen.getByRole("button", { name: "Создать резервную копию" }));

    await waitFor(() => expect(screen.getByText(/Не удалось снять копию: локальная база не найдена/)).toBeInTheDocument());
  });

  it("перенос во внешнюю базу: цель без пароля и результат цифрами", async () => {
    const migrate = vi.fn(async () => ({
      ok: true,
      inserted: 12,
      skipped: 3,
      target_rows: { stations: 4, fuel_observations: 11 },
      target: "postgresql+psycopg://fr:***@db:5432/fuelradar",
    }));
    installBridge({
      status: async () =>
        status({
          external: true,
          externalUrl: "postgresql+psycopg://fr:***@db:5432/fuelradar",
          externalSource: "config.json (backend.databaseUrl)",
          migrationSupported: true,
        }),
      migrate,
    });
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Перенести данные" })).toBeEnabled());

    await userEvent.click(screen.getByRole("button", { name: "Перенести данные" }));

    await waitFor(() =>
      expect(screen.getByText(/Перенос завершён: вставлено 12, пропущено уже имеющихся 3\./)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Строк в целевой базе: 15/)).toBeInTheDocument();
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("неудачный перенос показывает причину и молчит про успех", async () => {
    installBridge({
      status: async () =>
        status({
          external: true,
          externalUrl: "postgresql+psycopg://fr:***@db:5432/fuelradar",
          externalSource: "config.json (backend.databaseUrl)",
          migrationSupported: true,
        }),
      migrate: async () => ({ ok: false, error: "OperationalError: connection refused" }),
    });
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Перенести данные" })).toBeEnabled());

    await userEvent.click(screen.getByRole("button", { name: "Перенести данные" }));

    await waitFor(() =>
      expect(screen.getByText(/Перенос не выполнен: OperationalError: connection refused/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Перенос завершён/)).not.toBeInTheDocument();
  });
});
