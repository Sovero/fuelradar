"use client";

/**
 * Админские fetch-обёртки (M16): авторизация выполняется cookie-сессией
 * backend'а. Токены не хранятся в браузере и не передаются заголовком.
 */

import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";

export function adminGet<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  return apiGet<T>(`/admin${path}`, params);
}

export function adminPost<T>(path: string, body?: unknown): Promise<T> {
  return apiPost<T>(`/admin${path}`, body);
}

export function adminPut<T>(path: string, body?: unknown): Promise<T> {
  return apiPut<T>(`/admin${path}`, body);
}

export function adminPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiPatch<T>(`/admin${path}`, body);
}

export function adminDelete<T>(path: string): Promise<T> {
  return apiDelete<T>(`/admin${path}`);
}
