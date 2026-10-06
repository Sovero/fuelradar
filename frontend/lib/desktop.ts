"use client";

/**
 * Признак запуска в desktop-оболочке (Electron, см. desktop/preload.cjs).
 * Веб-код использует это, чтобы не делать то, что в оболочке делает Electron:
 * service worker (офлайн-кэш) отключается — автообновление кода там electron-updater.
 */

/** Результат IPC fuelradar:check-updates (desktop/main.cjs). */
export interface DesktopUpdateResult {
  supported: boolean;
  current?: string;
  available?: boolean;
  latest?: string | null;
  reason?: string;
  error?: string;
}

/**
 * Причина, по которой фид обновлений доступен или нет (IPC fuelradar:feed-status).
 *
 * `no-token`, `no-access`, `no-release` — это разные ситуации, и раньше все они
 * выглядели одинаково («обновлений нет»). Разбор причин даёт feed-status.cjs
 * в оболочке; панель обязана показать именно её, а не выдуманный успех (R97i).
 */
export type DesktopFeedState =
  | "ok"
  | "no-token"
  | "no-config"
  | "no-access"
  | "no-release"
  | "rate-limited"
  | "network"
  | "http-error"
  | "dev-run";

export interface DesktopFeedRelease {
  tag: string;
  name: string | null;
  publishedAt: string | null;
}

export interface DesktopFeedStatus {
  state: DesktopFeedState;
  message: string;
  release: DesktopFeedRelease | null;
  updateAvailable: boolean;
  detail: string | null;
  /** Отпечаток упакованного токена (SHA-256[:12]) — сверить, не раскрывая секрет. */
  fingerprint: string | null;
  current?: string;
  checkedAt?: string;
  tokenPacked?: boolean;
}

/** Состояние главного окна (IPC fuelradar:window-state). */
export interface DesktopWindowState {
  /** Окно живо; в сборках оболочки без моста будет false. */
  exists: boolean;
  isMaximized: boolean;
}

/**
 * Состояние данных десктоп-приложения (IPC fuelradar:db-status): где лежит
 * локальная база, настроена ли внешняя и можно ли делать копию/перенос.
 *
 * `supported: false` — честное «нечем» (в сборке нет ни встроенного backend,
 * ни каталога с Python): панель не показывает кнопки, которые ничего не сделают.
 */
export interface DesktopDatabaseStatus {
  supported: boolean;
  reason: string | null;
  external: boolean;
  /** Адрес внешней базы без пароля (R68). */
  externalUrl: string | null;
  externalSource: string | null;
  dataDir: string | null;
  localFile: string | null;
  localExists: boolean;
  localBytes: number | null;
  localModifiedAt: string | null;
  backupDir: string | null;
  newestBackup: { path: string; bytes: number; modifiedAt: string } | null;
  migrationSupported: boolean;
}

/** Результат копии/экспорта (IPC fuelradar:db-backup и fuelradar:db-export). */
export interface DesktopDatabaseBackupResult {
  supported?: boolean;
  ok: boolean;
  canceled?: boolean;
  path?: string | null;
  bytes?: number;
  created_at?: string;
  rows?: number;
  tables?: Record<string, number>;
  error?: string;
  reason?: string;
  /** Хвост вывода backend — техническая подробность для подсказки. */
  output?: string | null;
}

/** Результат переноса во внешнюю базу (IPC fuelradar:db-migrate). */
export interface DesktopDatabaseMigrateResult {
  supported?: boolean;
  ok: boolean;
  target?: string | null;
  inserted?: number;
  skipped?: number;
  tables?: Record<string, { rows: number; inserted: number; skipped: number }>;
  target_rows?: Record<string, number>;
  sequences_reset?: string[];
  snapshot?: { bytes?: number | null; created_at?: string | null; rows?: number | null };
  error?: string;
  reason?: string;
  output?: string | null;
}

declare global {
  interface Window {
    fuelradarDesktop?: {
      isDesktop: true;
      version: string;
      checkForUpdates: () => Promise<DesktopUpdateResult>;
      /** Появилось вместе с самопроверкой фида; в более старых сборках оболочки отсутствует. */
      feedStatus?: (options?: { force?: boolean }) => Promise<DesktopFeedStatus>;
      /**
       * Управление безрамочным окном (frame:false): системной рамки нет, свернуть/
       * развернуть/закрыть делают кнопки шапки интерфейса. Появилось вместе с
       * безрамочным режимом; в более старых сборках оболочки отсутствует.
       */
      windowControls?: {
        minimize: () => boolean;
        toggleMaximize: () => boolean;
        close: () => boolean;
        state: () => Promise<DesktopWindowState>;
      };
      /**
       * Данные приложения: копия/экспорт локальной базы и перенос во внешний
       * Postgres. Появилось вместе с панелью «Данные»; в более старых сборках
       * оболочки блока нет — панель честно сообщает, что мост недоступен.
       */
      database?: {
        status: () => Promise<DesktopDatabaseStatus>;
        backup: () => Promise<DesktopDatabaseBackupResult>;
        exportCopy: () => Promise<DesktopDatabaseBackupResult>;
        migrate: () => Promise<DesktopDatabaseMigrateResult>;
        reveal: (target: string) => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}

export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.fuelradarDesktop?.isDesktop === true;
}

/** Версия desktop-оболочки; в браузере — null (строку версии показывает только оболочка). */
export function desktopVersion(): string | null {
  return isDesktopShell() ? (window.fuelradarDesktop?.version ?? null) : null;
}

/**
 * Мост управления окном. null — браузер или сборка оболочки старше безрамочного
 * режима (системная рамка там на месте, кнопки окна не нужны).
 */
export function desktopWindowControls():
  | NonNullable<NonNullable<Window["fuelradarDesktop"]>["windowControls"]>
  | null {
  if (!isDesktopShell()) return null;
  const controls = window.fuelradarDesktop?.windowControls;
  return controls ?? null;
}

/**
 * Ручная проверка обновлений через мост. null — моста нет (обычный браузер).
 * Отклонение промиса — мост есть, а IPC-хендлера нет (сборка оболочки старше
 * фикс-а): вызывающий код честно показывает «не удалось проверить».
 */
export async function checkDesktopUpdates(): Promise<DesktopUpdateResult | null> {
  if (!isDesktopShell()) return null;
  const result = await window.fuelradarDesktop?.checkForUpdates();
  return result ?? null;
}

/**
 * Мост данных (панель «Данные»). null — браузер или сборка оболочки старше
 * этой панели: кнопки копии/переноса тогда не показываются (R97i — не изображать
 * работу). Появилось вместе с DatabasePanel.
 */
export function desktopDatabase():
  | NonNullable<NonNullable<Window["fuelradarDesktop"]>["database"]>
  | null {
  if (!isDesktopShell()) return null;
  return window.fuelradarDesktop?.database ?? null;
}

/**
 * Статус фида обновлений от оболочки. null — моста нет (браузер) или сборка
 * оболочки его не отдаёт; вызывающий код в этом случае честно сообщает, что
 * состояние фида неизвестно.
 */
export async function desktopFeedStatus(force = false): Promise<DesktopFeedStatus | null> {
  if (!isDesktopShell()) return null;
  const bridge = window.fuelradarDesktop;
  if (typeof bridge?.feedStatus !== "function") return null;
  const status = await bridge.feedStatus({ force });
  return status ?? null;
}
