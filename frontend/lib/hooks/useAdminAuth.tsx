"use client";

/**
 * RBAC-состояние админ-раздела (M16). Backend проверяет httpOnly-cookie и роль
 * User; статический X-Admin-Token не является способом авторизации.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/hooks/useAuth";

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
  const { user, logout: authLogout } = useAuth();
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A new login must not inherit a failed request from the previous account.
    setVerified(false);
    setError(null);
  }, [user?.id, user?.role]);

  const markVerified = useCallback(() => {
    setVerified(true);
    setError(null);
  }, []);

  const markInvalid = useCallback((message: string) => {
    setVerified(false);
    setError(message);
  }, []);

  const logout = useCallback(async () => {
    await authLogout();
    setVerified(false);
    setError(null);
  }, [authLogout]);

  const value = useMemo<AdminAuthState>(
    () => ({
      verified,
      isAdmin: user?.role === "ADMIN",
      isOperator: user?.role === "OPERATOR" || user?.role === "ADMIN",
      markVerified,
      markInvalid,
      error,
      logout,
    }),
    [user, verified, markVerified, markInvalid, error, logout],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAdminAuth должен использоваться внутри AdminAuthProvider");
  return ctx;
}
