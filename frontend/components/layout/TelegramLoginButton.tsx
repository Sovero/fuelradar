"use client";

import { useEffect, useRef } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { hasTelegramLoginWidget, telegramBotUsername } from "@/lib/telegram";

declare global {
  interface Window {
    onTelegramAuth?: (user: Record<string, string | number>) => void;
  }
}

/** Официальный виджет telegram.org — рендерится только при заданном имени бота (см. lib/telegram.ts). */
export function TelegramLoginButton({ onError, onSuccess }: { onError: (message: string) => void; onSuccess: () => void }) {
  const { telegramLogin } = useAuth();
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasTelegramLoginWidget() || !containerRef.current) return;
    window.onTelegramAuth = (user) => {
      telegramLogin(user)
        .then(onSuccess)
        .catch((err) => onError(err instanceof ApiError ? err.message : t("login.telegram.error")));
    };
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", telegramBotUsername());
    script.setAttribute("data-size", "large");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    const node = containerRef.current;
    node.appendChild(script);
    return () => {
      node.replaceChildren();
      delete window.onTelegramAuth;
    };
  }, [telegramLogin, onError, onSuccess, t]);

  if (!hasTelegramLoginWidget()) {
    return <p className="text-xs text-gray-400">{t("login.telegram.notConfigured")}</p>;
  }

  return <div ref={containerRef} />;
}
