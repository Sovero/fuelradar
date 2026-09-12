"use client";

/**
 * Профиль пользователя. JWT лежит в httpOnly-cookie backend'а — фронт НЕ хранит
 * токен сам, только спрашивает `/auth/me` (credentials: 'include' в lib/api.ts).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { AuthUser } from "@/lib/types";

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** dev-вход (см. backend/app/api/login.py) — для пилота, пока не настроены SMTP/Telegram. */
  devLogin: (email: string) => Promise<void>;
  /** R66: письмо со ссылкой (POST /auth/magic-link) — активно только при заданном SMTP_URL. */
  requestMagicLink: (email: string) => Promise<void>;
  /** Обмен токена из ссылки на cookie-сессию (POST /auth/verify) — вызывается со страницы /auth/verify. */
  verifyMagicLink: (token: string) => Promise<void>;
  /** R66: вход через Telegram Login Widget (POST /auth/telegram) — активен только при TELEGRAM_BOT_TOKEN. */
  telegramLogin: (payload: Record<string, string | number>) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const GUEST_EMAIL_KEY = "fr_guest_email";

/** Персистентный «гостевой» email для dev-входа — генерируется один раз на устройство. */
export function getOrCreateGuestEmail(): string {
  if (typeof window === "undefined") return "guest@fuelradar.local";
  try {
    const existing = window.localStorage.getItem(GUEST_EMAIL_KEY);
    if (existing) return existing;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
    const email = `guest-${id}@fuelradar.local`;
    window.localStorage.setItem(GUEST_EMAIL_KEY, email);
    return email;
  } catch {
    return "guest@fuelradar.local";
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      // Анонимный гость — 200 + {user: null} (не 401): probe не шумит ошибкой в консоли.
      const res = await apiGet<{ user: AuthUser | null }>("/auth/me");
      setUser(res.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const devLogin = useCallback(
    async (email: string) => {
      const res = await apiPost<{ user: AuthUser }>("/auth/dev-login", { email });
      setUser(res.user);
    },
    [],
  );

  const requestMagicLink = useCallback(async (email: string) => {
    await apiPost("/auth/magic-link", { email });
  }, []);

  const verifyMagicLink = useCallback(async (token: string) => {
    const res = await apiPost<{ user: AuthUser }>("/auth/verify", { token });
    setUser(res.user);
  }, []);

  const telegramLogin = useCallback(async (payload: Record<string, string | number>) => {
    const res = await apiPost<{ user: AuthUser }>("/auth/telegram", payload);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    await apiPost("/auth/logout");
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, devLogin, requestMagicLink, verifyMagicLink, telegramLogin, logout, refresh }),
    [user, loading, devLogin, requestMagicLink, verifyMagicLink, telegramLogin, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth должен использоваться внутри AuthProvider");
  return ctx;
}
