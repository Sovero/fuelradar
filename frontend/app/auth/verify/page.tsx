"use client";

/**
 * Landing-страница ссылки из письма (R66): backend формирует ссылку как
 * `PUBLIC_APP_URL/auth/verify?token=...` (см. backend/app/auth/service.py::send_magic_link).
 * Обменивает токен на cookie-сессию (`POST /auth/verify`) и уводит на главную.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";

function VerifyBody() {
  const params = useSearchParams();
  const router = useRouter();
  const { verifyMagicLink } = useAuth();
  const { t } = useI18n();
  const [status, setStatus] = useState<"pending" | "ok" | "error">("pending");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setMessage(t("authVerify.missingToken"));
      return;
    }
    verifyMagicLink(token)
      .then(() => {
        setStatus("ok");
        setTimeout(() => router.replace("/"), 1200);
      })
      .catch((err) => {
        setStatus("error");
        setMessage(err instanceof ApiError ? err.message : t("authVerify.error"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-gray-50 p-6 text-center dark:bg-gray-950 dark:text-gray-100">
      {status === "pending" && <p className="text-gray-500 dark:text-gray-400">{t("authVerify.pending")}</p>}
      {status === "ok" && <p className="text-emerald-700 dark:text-emerald-400">{t("authVerify.ok")}</p>}
      {status === "error" && (
        <>
          <p className="text-red-600 dark:text-red-400">{message}</p>
          <button
            type="button"
            onClick={() => router.replace("/")}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t("authVerify.backHome")}
          </button>
        </>
      )}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center text-gray-400">…</div>}>
      <VerifyBody />
    </Suspense>
  );
}
