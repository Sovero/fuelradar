"use strict";

/**
 * afterPack (electron-builder): упаковка токена доступа к приватному фиду.
 *
 * Фид — Releases приватного репозитория GitHub (build.publish = github), поэтому
 * установленному приложению нужен токен (main.cjs читает
 * `resources/update-feed-token` и переключает фид на PrivateGitHubProvider).
 *
 * Откуда берётся токен — решает `scripts/feed-token.cjs`: переменная окружения
 * (путь CI), файл вне репозитория, хранилище учётных данных Windows; ручной файл
 * в рабочей копии продолжает работать, но помечен устаревшим. Токен не попадает
 * ни в asar, ни в логи: рядом с ним кладём только отпечаток и идентификатор
 * источника, чтобы по готовому установщику можно было понять, что внутри.
 *
 * Токена нет нигде → сборка собирается, автообновление в ней честно отключено
 * (R97i), а не «падает непонятно почему» — статус видно командой
 * `npm run feed:token:status`, а требуется токен там, где он обязателен (CI).
 */

const fs = require("node:fs");
const path = require("node:path");

const { describeResolution, resolveFeedToken } = require("./feed-token.cjs");

module.exports = async function patchFeedToken(context) {
  const resourcesDir = path.join(context.appOutDir, "resources");
  const resolution = resolveFeedToken();

  for (const warning of resolution.warnings) {
    console.warn(`[update-feed] ${warning}`);
  }

  if (!resolution.token) {
    console.warn(
      "[update-feed] токена фида нет — автообновление в этой сборке отключено (R97i).\n" +
        describeResolution(resolution),
    );
    return;
  }

  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, "update-feed-token"), resolution.token + "\n", "utf8");
  fs.writeFileSync(
    path.join(resourcesDir, "update-feed-token.source"),
    `${resolution.source} ${resolution.fingerprint}\n`,
    "utf8",
  );
  console.log(
    `[update-feed] токен фида упакован в resources/update-feed-token (источник: ${resolution.sourceLabel}, отпечаток ${resolution.fingerprint})`,
  );
};
