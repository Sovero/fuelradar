"use strict";

/**
 * Самопроверка фида обновлений (R97i): доступен ли он **именно этим токеном**.
 *
 * Зачем отдельно от electron-updater: `checkForUpdates` сообщает «обновлений нет»
 * и на 401, и на 404, и когда релизов действительно нет — три разные причины,
 * требующие разных действий («токен не упакован», «токен не принят», «доступ есть,
 * релизов нет»). Эта проверка разбирает их явно, пишет результат в лог оболочки и
 * отдаёт его в интерфейс (вкладка «Обновления»), не выдумывая успех.
 *
 * Модуль не зависит от Electron: `fetch` и конфиг передаются снаружи, поэтому
 * разбор ответов покрыт юнит-тестами без сети (desktop/tests/feed-status.test.cjs).
 * Токен наружу не отдаётся — только отпечаток SHA-256[:12] (сверить можно,
 * восстановить нельзя).
 *
 * Состояния:
 *   ok            — фид доступен, релиз найден (может быть новее или совпадать);
 *   no-token      — токен фида не упакован в сборку;
 *   no-config     — не прочитан/не настроен app-update.yml (owner/repo);
 *   no-access     — токен не принят или нет доступа к приватному репозиторию;
 *   no-release    — доступ есть, но опубликованных релизов нет;
 *   rate-limited  — GitHub отклонил запрос по лимиту (403 + X-RateLimit-Remaining: 0);
 *   network       — фид недоступен (нет сети/DNS/таймаут);
 *   http-error    — фид ответил иной ошибкой (код в detail).
 */

const crypto = require("node:crypto");

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

const STATE = {
  OK: "ok",
  NO_TOKEN: "no-token",
  NO_CONFIG: "no-config",
  NO_ACCESS: "no-access",
  NO_RELEASE: "no-release",
  RATE_LIMITED: "rate-limited",
  NETWORK: "network",
  HTTP_ERROR: "http-error",
};

/** Отпечаток токена для логов и интерфейса: сверить — да, восстановить — нет. */
function tokenFingerprint(token) {
  if (!token) return null;
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
}

/**
 * Сравнение версий вида 0.1.10 vs 0.1.9 (числовые части по порядку).
 *
 * Пре-релиз и сборка (`1.0.0-beta.1`, `1.0.0+abc`) отбрасываются: считать их
 * «новее» стабильной версии нельзя, а апдейтер всё равно ходит по своему каналу.
 * Возвращает >0, если `left` новее `right`; <0 — старее; 0 — равны.
 */
function compareVersions(left, right) {
  const parse = (value) =>
    String(value ?? "")
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** `app-update.yml` → {owner, repo} или null (не github-провайдер/нет полей). */
function parseFeedConfig(text) {
  if (!text) return null;
  let config = null;
  try {
    // js-yaml — prod-зависимость electron-updater, доступна и в asar пакета.
    // eslint-disable-next-line global-require
    config = require("js-yaml").load(text);
  } catch {
    return null;
  }
  if (!config || config.provider !== "github" || !config.owner || !config.repo) return null;
  return { owner: String(config.owner), repo: String(config.repo) };
}

function result(state, message, extra = {}) {
  return { state, message, release: null, updateAvailable: false, detail: null, ...extra };
}

function requestHeaders(token, currentVersion) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": `FuelRadar-Desktop/${currentVersion || "0.0.0"}`,
  };
}

/**
 * Проверить фид.
 *
 * @param {object} options
 * @param {string|null} options.token токен фида (уже прочитанный из сборки)
 * @param {{owner: string, repo: string}|null} options.config результат parseFeedConfig
 * @param {string} [options.currentVersion] версия приложения (для «новее?»)
 * @param {typeof fetch} [options.fetchImpl] подмена в тестах
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{state: string, message: string, release: {tag: string, name: string|null, publishedAt: string|null}|null,
 *   updateAvailable: boolean, detail: string|null, fingerprint: string|null}>}
 */
async function probeFeed(options = {}) {
  const { token, config, currentVersion = null, fetchImpl = fetch, timeoutMs = 8000 } = options;

  if (!token) {
    return result(STATE.NO_TOKEN, "Токен фида не упакован в эту сборку — автономное обновление отключено.", {
      fingerprint: null,
    });
  }
  if (!config?.owner || !config?.repo) {
    return result(STATE.NO_CONFIG, "Не настроен фид обновлений (owner/repo в app-update.yml).", {
      fingerprint: tokenFingerprint(token),
    });
  }

  const fingerprint = tokenFingerprint(token);
  const headers = requestHeaders(token, currentVersion);
  const get = async (path) => {
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  };

  let latest;
  try {
    latest = await get(`/repos/${config.owner}/${config.repo}/releases/latest`);
  } catch (error) {
    return result(STATE.NETWORK, "Фид недоступен: нет сети или GitHub не ответил.", {
      detail: String(error?.message ?? error),
      fingerprint,
    });
  }

  if (latest.status === 200) {
    let release = null;
    try {
      release = await latest.json();
    } catch {
      return result(STATE.HTTP_ERROR, "Фид ответил, но релиз не разобран.", {
        detail: "HTTP 200 без тела JSON",
        fingerprint,
      });
    }
    const tag = String(release?.tag_name ?? "").trim();
    const updateAvailable = Boolean(tag) && compareVersions(tag, currentVersion ?? "0.0.0") > 0;
    return result(
      STATE.OK,
      updateAvailable
        ? `Фид доступен: опубликован релиз ${tag} — новее установленной версии.`
        : `Фид доступен: последний релиз ${tag || "без тега"}, обновляться не с чего.`,
      {
        release: {
          tag,
          name: release?.name ?? null,
          publishedAt: release?.published_at ?? null,
        },
        updateAvailable,
        fingerprint,
      },
    );
  }

  if (latest.status === 401) {
    return result(STATE.NO_ACCESS, "Токен фида не принят GitHub (HTTP 401) — сборку надо пересобрать с рабочим токеном.", {
      detail: "HTTP 401",
      fingerprint,
    });
  }

  if (latest.status === 403) {
    const remaining = latest.headers?.get?.("x-ratelimit-remaining");
    if (remaining === "0") {
      return result(STATE.RATE_LIMITED, "GitHub ограничил лимит запросов к API — проверьте позже.", {
        detail: "HTTP 403, X-RateLimit-Remaining: 0",
        fingerprint,
      });
    }
    return result(STATE.NO_ACCESS, "Доступ к фиду запрещён (HTTP 403).", {
      detail: "HTTP 403",
      fingerprint,
    });
  }

  if (latest.status === 404) {
    // GitHub отдаёт 404 и «нет релизов», и «нет доступа к приватному репозиторию».
    // Различаем вторым запросом: список релизов доступен только с правами.
    let list;
    try {
      list = await get(`/repos/${config.owner}/${config.repo}/releases?per_page=1`);
    } catch (error) {
      return result(STATE.NETWORK, "Фид недоступен: нет сети или GitHub не ответил.", {
        detail: String(error?.message ?? error),
        fingerprint,
      });
    }
    if (list.status === 200) {
      return result(
        STATE.NO_RELEASE,
        "Доступ к фиду есть, но опубликованных релизов нет — обновляться не с чего.",
        { detail: "HTTP 404 /releases/latest, список релизов доступен", fingerprint },
      );
    }
    return result(
      STATE.NO_ACCESS,
      "Токен не даёт доступа к приватному фиду (HTTP 404): нет релизов или нет прав Contents: Read-only.",
      { detail: `HTTP 404, список релизов → ${list.status}`, fingerprint },
    );
  }

  return result(STATE.HTTP_ERROR, `Фид ответил ошибкой HTTP ${latest.status}.`, {
    detail: `HTTP ${latest.status}`,
    fingerprint,
  });
}

module.exports = {
  GITHUB_API,
  STATE,
  compareVersions,
  parseFeedConfig,
  probeFeed,
  tokenFingerprint,
};
