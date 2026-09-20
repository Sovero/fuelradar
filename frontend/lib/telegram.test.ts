import { describe, expect, it } from "vitest";
import { hasTelegramLoginWidget, telegramBotUsername, type TelegramLoginMeta } from "@/lib/telegram";

describe("telegram login channel (R97i)", () => {
  it("/meta с включённым каналом отдаёт имя бота", () => {
    const meta: TelegramLoginMeta = { enabled: true, bot_username: "fuelradar_bot" };
    expect(telegramBotUsername(meta)).toBe("fuelradar_bot");
    expect(hasTelegramLoginWidget(meta)).toBe(true);
  });

  it("/meta с выключенным каналом (токена нет) — виджет не показывается", () => {
    const meta: TelegramLoginMeta = { enabled: false, bot_username: null };
    expect(telegramBotUsername(meta)).toBeNull();
    expect(hasTelegramLoginWidget(meta)).toBe(false);
  });

  it("/meta прислал enabled:true, но имя пустое — не показываем (нечем рисовать виджет)", () => {
    const meta: TelegramLoginMeta = { enabled: true, bot_username: "" };
    expect(hasTelegramLoginWidget(meta)).toBe(false);
  });

  it("старый backend без telegram_login — fallback на build-time переменную", () => {
    const prev = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    try {
      process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = "legacy_bot";
      expect(telegramBotUsername(null)).toBe("legacy_bot");
      expect(hasTelegramLoginWidget(null)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
      else process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = prev;
    }
  });

  it("ни /meta, ни build-time переменной — канал скрыт, а не имитирует вход", () => {
    const prev = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    try {
      delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
      expect(telegramBotUsername(undefined)).toBeNull();
      expect(hasTelegramLoginWidget(undefined)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = prev;
    }
  });

  it("enabled:false в /meta сильнее build-time переменной (backend — источник правды)", () => {
    const prev = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    try {
      process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = "legacy_bot";
      const meta: TelegramLoginMeta = { enabled: false, bot_username: null };
      expect(hasTelegramLoginWidget(meta)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
      else process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = prev;
    }
  });
});
