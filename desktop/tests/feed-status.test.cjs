"use strict";

/**
 * Тесты самопроверки фида (desktop/feed-status.cjs).
 *
 * Главное, что проверяется: разные причины «обновлений нет» различаются явно
 * (нет токена / токен не принят / доступ есть, релизов нет / нет сети), и в
 * диагностику не попадает сам токен — только отпечаток.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { STATE, compareVersions, parseFeedConfig, probeFeed, tokenFingerprint } = require("../feed-status.cjs");

const TOKEN = "github_pat_STATUS_TEST_1234567890";
const CONFIG = { owner: "Sovero", repo: "fuelradar" };

function response(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** fetch-заглушка: путь → ответ. Неизвестный путь — 500 (тест такого не ждёт). */
function fetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [fragment, handler] of Object.entries(routes)) {
      if (url.includes(fragment)) return typeof handler === "function" ? handler(url) : handler;
    }
    return response(500, {});
  };
  return { fetchImpl, calls };
}

const LATEST = "/releases/latest";

test("ok: релиз новее установленной версии", async () => {
  const { fetchImpl, calls } = fetchStub({
    [LATEST]: response(200, { tag_name: "v0.2.0", name: "FuelRadar 0.2.0", published_at: "2026-09-19T10:00:00Z" }),
  });
  const result = await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.OK);
  assert.equal(result.release.tag, "v0.2.0");
  assert.equal(result.updateAvailable, true);
  assert.match(result.message, /новее установленной/);
  assert.equal(result.fingerprint, tokenFingerprint(TOKEN));
  assert.equal(calls.length, 1);
});

test("ok: тот же релиз — обновляться не с чего, но фид доступен", async () => {
  const { fetchImpl } = fetchStub({ [LATEST]: response(200, { tag_name: "v0.1.1" }) });
  const result = await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.OK);
  assert.equal(result.updateAvailable, false);
  assert.match(result.message, /обновляться не с чего/);
});

test("no-token: без токена сеть не трогаем", async () => {
  const { fetchImpl, calls } = fetchStub({});
  const result = await probeFeed({ token: null, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.NO_TOKEN);
  assert.equal(result.fingerprint, null);
  assert.equal(calls.length, 0, "без токена запрос к фиду бессмысленен");
});

test("no-config: фид не настроен", async () => {
  const { fetchImpl, calls } = fetchStub({});
  const result = await probeFeed({ token: TOKEN, config: null, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.NO_CONFIG);
  assert.equal(result.fingerprint, tokenFingerprint(TOKEN));
  assert.equal(calls.length, 0);
});

test("no-access: 401 — токен не принят", async () => {
  const { fetchImpl } = fetchStub({ [LATEST]: response(401, { message: "Bad credentials" }) });
  const result = await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.NO_ACCESS);
  assert.match(result.message, /не принят/);
  assert.equal(result.detail, "HTTP 401");
});

test("rate-limited: 403 с исчерпанным лимитом отличается от запрета", async () => {
  const limited = await probeFeed({
    token: TOKEN,
    config: CONFIG,
    currentVersion: "0.1.1",
    fetchImpl: fetchStub({ [LATEST]: response(403, {}, { "x-ratelimit-remaining": "0" }) }).fetchImpl,
  });
  assert.equal(limited.state, STATE.RATE_LIMITED);
  assert.match(limited.message, /лимит/);

  const forbidden = await probeFeed({
    token: TOKEN,
    config: CONFIG,
    currentVersion: "0.1.1",
    fetchImpl: fetchStub({ [LATEST]: response(403, {}, { "x-ratelimit-remaining": "57" }) }).fetchImpl,
  });
  assert.equal(forbidden.state, STATE.NO_ACCESS);
  assert.match(forbidden.message, /запрещён/);
});

test("no-release: 404 на latest, но список релизов доступен", async () => {
  const { fetchImpl, calls } = fetchStub({
    [LATEST]: response(404, { message: "Not Found" }),
    "/releases?per_page=1": response(200, []),
  });
  const result = await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.NO_RELEASE);
  assert.match(result.message, /релизов нет/);
  assert.equal(calls.length, 2, "404 уточняется вторым запросом");
});

test("no-access: 404 и на списке релизов — приватный фид без прав", async () => {
  const { fetchImpl } = fetchStub({
    [LATEST]: response(404, { message: "Not Found" }),
    "/releases?per_page=1": response(404, { message: "Not Found" }),
  });
  const result = await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.NO_ACCESS);
  assert.match(result.message, /не даёт доступа к приватному фиду/);
  assert.match(result.detail, /список релизов → 404/);
});

test("network: нет сети — честная причина вместо «обновлений нет»", async () => {
  const offline = async () => {
    throw new Error("ENOTFOUND api.github.com");
  };
  const result = await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl: offline });

  assert.equal(result.state, STATE.NETWORK);
  assert.match(result.detail, /ENOTFOUND/);
});

test("http-error: прочие коды не выдаются за успех", async () => {
  const { fetchImpl } = fetchStub({ [LATEST]: response(500, {}) });
  const result = await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(result.state, STATE.HTTP_ERROR);
  assert.match(result.message, /HTTP 500/);
});

test("ни одно состояние не раскрывает токен", async () => {
  const scenarios = [
    { token: TOKEN, config: CONFIG },
    { token: TOKEN, config: null },
    { token: null, config: CONFIG },
  ];
  for (const scenario of scenarios) {
    const { fetchImpl } = fetchStub({ [LATEST]: response(401, {}) });
    const result = await probeFeed({ ...scenario, currentVersion: "0.1.1", fetchImpl });
    const dump = JSON.stringify(result);
    assert.ok(!dump.includes(TOKEN), `токен утёк в состояние ${result.state}`);
  }
});

test("заголовки запроса подписаны токеном и версией приложения", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return response(200, { tag_name: "v0.1.1" });
  };
  await probeFeed({ token: TOKEN, config: CONFIG, currentVersion: "0.1.1", fetchImpl });

  assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].headers["User-Agent"], "FuelRadar-Desktop/0.1.1");
  assert.equal(seen[0].url, "https://api.github.com/repos/Sovero/fuelradar/releases/latest");
});

test("parseFeedConfig: github-провайдер с owner/repo, иначе null", () => {
  assert.deepEqual(
    parseFeedConfig("provider: github\nowner: Sovero\nrepo: fuelradar\nupdaterCacheDirName: x\n"),
    { owner: "Sovero", repo: "fuelradar" },
  );
  assert.equal(parseFeedConfig("provider: s3\nbucket: x\n"), null);
  assert.equal(parseFeedConfig("provider: github\nowner: Sovero\n"), null);
  assert.equal(parseFeedConfig(""), null);
  assert.equal(parseFeedConfig("provider: [broken"), null);
});

test("compareVersions: числовые части, префикс v и мусор", () => {
  assert.equal(compareVersions("v0.2.0", "0.1.11"), 1);
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1, "10 новее 9, а не наоборот");
  assert.equal(compareVersions("0.1.1", "0.1.1"), 0);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), 0);
  assert.equal(compareVersions("", "0.1.0"), -1);
});
