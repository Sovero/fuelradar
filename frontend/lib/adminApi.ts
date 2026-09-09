/**
 * Админ-доступ (R95i): заголовок `X-Admin-Token`, который ВВОДИТ человек-администратор
 * на экране /admin — это не секрет, придуманный кодом, а runtime-значение, которое
 * знает только владелец ADMIN_TOKEN в backend `.env`. Хранится в sessionStorage
 * (не localStorage — не переживает закрытие вкладки, не в .env фронтенда, не в коде).
 */

import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

const ADMIN_TOKEN_KEY = "fr_admin_token";

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    // sessionStorage недоступен — токен просто не переживёт следующий рендер вкладки
  }
}

export function clearAdminToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // не критично
  }
}

function authHeaders(): HeadersInit {
  const token = getAdminToken();
  return token ? { "X-Admin-Token": token } : {};
}

export function adminGet<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  return apiGet<T>(`/admin${path}`, params, { headers: authHeaders() });
}

export function adminPost<T>(path: string, body?: unknown): Promise<T> {
  return apiPost<T>(`/admin${path}`, body, { headers: authHeaders() });
}

export function adminPut<T>(path: string, body?: unknown): Promise<T> {
  return apiPut<T>(`/admin${path}`, body, { headers: authHeaders() });
}

export function adminDelete<T>(path: string): Promise<T> {
  return apiDelete<T>(`/admin${path}`, { headers: authHeaders() });
}
