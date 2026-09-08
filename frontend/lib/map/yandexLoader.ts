/**
 * Загрузчик Яндекс.Карт JS API 2.1 (R102) — единственное место, где скрипт
 * добавляется в документ. Кэширует промис, чтобы повторные монтирования карты
 * не грузили API повторно.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type YMapsNamespace = any;

declare global {
  interface Window {
    ymaps?: YMapsNamespace;
  }
}

let loadPromise: Promise<YMapsNamespace> | null = null;
const SCRIPT_MARKER = "data-fr-yandex-maps";

export function loadYmaps(apiKey: string): Promise<YMapsNamespace> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Яндекс.Карты доступны только в браузере"));
  }
  if (window.ymaps && window.ymaps.Map) {
    return Promise.resolve(window.ymaps);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<YMapsNamespace>((resolve, reject) => {
    const finish = () => {
      if (!window.ymaps) {
        reject(new Error("Яндекс.Карты не инициализировались"));
        return;
      }
      window.ymaps.ready(() => resolve(window.ymaps as YMapsNamespace));
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[${SCRIPT_MARKER}]`);
    if (existing) {
      if (window.ymaps) finish();
      else existing.addEventListener("load", finish);
      existing.addEventListener("error", () => reject(new Error("Не удалось загрузить Яндекс.Карты")));
      return;
    }

    const script = document.createElement("script");
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    script.async = true;
    script.setAttribute(SCRIPT_MARKER, "1");
    script.onload = finish;
    script.onerror = () => {
      loadPromise = null;
      reject(new Error("Не удалось загрузить Яндекс.Карты — проверьте сеть/ключ API"));
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}
