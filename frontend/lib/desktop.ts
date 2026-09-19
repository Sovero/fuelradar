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

declare global {
  interface Window {
    fuelradarDesktop?: {
      isDesktop: true;
      version: string;
      checkForUpdates: () => Promise<DesktopUpdateResult>;
      /** Появилось вместе с самопроверкой фида; в более старых сборках оболочки отсутствует. */
      feedStatus?: (options?: { force?: boolean }) => Promise<DesktopFeedStatus>;
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
