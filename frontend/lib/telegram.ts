/**
 * Вход через Telegram Login Widget (R66/R97i). Виджету нужно публичное имя
 * бота — backend хранит секрет (`TELEGRAM_BOT_TOKEN`), а фронту нужно только
 * имя бота, чтобы отрисовать официальную кнопку telegram.org. Без переменной
 * виджет не создаёт видимость несуществующего входа — честный плейсхолдер,
 * тот же паттерн, что и `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` (T09, R102).
 */
export function telegramBotUsername(): string {
  return (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "").trim();
}

export function hasTelegramLoginWidget(): boolean {
  return telegramBotUsername().length > 0;
}
