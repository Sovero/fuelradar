"use client";

/**
 * Состояние админ-раздела. Пользователей в приложении нет: всё, что умеет
 * система, доступно тому, кто её запустил, поэтому здесь нет ни RBAC, ни
 * гейта — только флаги совместимости для существующих компонентов (все true)
 * и приём сообщений об ошибках запросов.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";

interface AdminAuthState {
  verified: boolean;
  isAdmin: boolean;
  isOperator: boolean;
  markVerified: () => void;
  markInvalid: (message: string) => void;
  error: string | null;
  logout: () => Promise<void>;
}

const Ctx = createContext<AdminAuthState | null>(null);

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<string | null>(null);

  const markVerified = useCallback(() => setError(null), []);
  const markInvalid = useCallback((message: string) => setError(message), []);
  const logout = useCallback(async () => setError(null), []);

  const value = useMemo<AdminAuthState>(
    () => ({
      verified: true,
      isAdmin: true,
      isOperator: true,
      markVerified,
      markInvalid,
      error,
      logout,
    }),
    [markVerified, markInvalid, error, logout],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAdminAuth должен использоваться внутри AdminAuthProvider");
  return ctx;
}
