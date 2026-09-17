"use client";

/**
 * Global first-run gate (M16). The public dashboard remains readable, but the
 * one-time administrator setup is shown until the backend reports completion.
 */

import { BootstrapAdminPanel } from "@/components/auth/BootstrapAdminPanel";
import { useAuth } from "@/lib/hooks/useAuth";

export function BootstrapGate({ children }: { children: React.ReactNode }) {
  const { user, loading, bootstrapRequired } = useAuth();

  return (
    <>
      {children}
      {!loading && !user && bootstrapRequired === true && <BootstrapAdminPanel />}
    </>
  );
}
