/**
 * Вход через Telegram Login Widget (R66/R97i).
 *
 * Источник правды — `/meta` (`meta.telegram_login`): backend отдаёт публичное
 * имя бота только при настроенном `TELEGRAM_BOT_TOKEN`, поэтому виджет не
 * появляется, если вход реально не примется. Fallback на build-time
 * `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — только пока `/meta` не_answered или
 * недоступен (старые сборки backend); без обоих источников вкладка канала
 * честно скрыта, а не имитирует рабочий вход (R97i).
 */

export interface TelegramLoginMeta {
  enabled: boolean;
  bot_username: string | null;
}

/** Имя бота из build-time переменной (fallback; backend — источник правды). */
function envBotUsername(): string {
  return (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "").trim();
}

/** Имя бота для виджета: из /meta, если прислали; иначе build-time fallback. */
export function telegramBotUsername(meta: TelegramLoginMeta | null | undefined): string | null {
  // /meta ответил — доверяем только ему: enabled:false значит «токена нет на
  // сервере», и build-time имя не должно рисовать виджет, который отклонят.
  if (meta) return meta.enabled && meta.bot_username ? meta.bot_username : null;
  const fromEnv = envBotUsername();
  return fromEnv.length > 0 ? fromEnv : null;
}

/**
 * Показывать ли вкладку/виджет Telegram. Без /meta доверяем только
 * build-time переменной (как раньше); с /meta — только её решению.
 */
export function hasTelegramLoginWidget(meta: TelegramLoginMeta | null | undefined): boolean {
  return telegramBotUsername(meta) !== null;
}
