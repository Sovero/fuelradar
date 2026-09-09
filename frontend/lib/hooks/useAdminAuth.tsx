"use client";

/**
 * Состояние admin-токена на экране /admin (R95i). Токен вводит человек —
 * владелец ADMIN_TOKEN из backend `.env` — в простой форме-промпте; здесь
 * только хранение на время вкладки (sessionStorage, см. `lib/adminApi.ts`)
 * и общий признак «токен подтверждён рабочим запросом», чтобы не спрашивать
 * заново при переключении вкладок админки.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { clearAdminToken, getAdminToken, setAdminToken } from "@/lib/adminApi";

interface AdminAuthState {
  token: string | null;
  verified: boolean;
  submit: (token: string) => void;
  markVerified: () => void;
  markInvalid: (message: string) => void;
  error: string | null;
  logout: () => void;
}

const Ctx = createContext<AdminAuthState | null>(null);

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(getAdminToken());
  }, []);

  const submit = useCallback((next: string) => {
    setAdminToken(next);
    setToken(next);
    setVerified(false);
    setError(null);
  }, []);

  const markVerified = useCallback(() => {
    setVerified(true);
    setError(null);
  }, []);

  const markInvalid = useCallback((message: string) => {
    setVerified(false);
    setError(message);
  }, []);

  const logout = useCallback(() => {
    clearAdminToken();
    setToken(null);
    setVerified(false);
    setError(null);
  }, []);

  const value = useMemo<AdminAuthState>(
    () => ({ token, verified, submit, markVerified, markInvalid, error, logout }),
    [token, verified, submit, markVerified, markInvalid, error, logout],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAdminAuth должен использоваться внутри AdminAuthProvider");
  return ctx;
}
