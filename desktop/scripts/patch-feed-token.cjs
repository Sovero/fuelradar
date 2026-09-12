"use strict";

/**
 * afterPack (electron-builder): токен доступа к приватному фиду обновлений.
 *
 * Фид — Releases приватного репозитория GitHub (build.publish = github).
 * Каждый запрос фида/загрузки из установленного приложения требует токен
 * (autoUpdater.addAuthHeader в main.cjs). Сам токен:
 *  - в git не хранится и в .env не пишется;
 *  - в asar не попадает: человек кладёт его в desktop/.update-feed-token
 *    (fine-grained PAT, единственное право — Contents: read) ПЕРЕД сборкой;
 *  - afterPack копирует его в resources/ пакета как update-feed-token.
 *
 * Файла нет → сборка работает, автообновление в ней честно отключено (R97i).
 */

const fs = require("node:fs");
const path = require("node:path");

const TOKEN_SOURCE = path.join(__dirname, "..", ".update-feed-token");

module.exports = async function patchFeedToken(context) {
  const resourcesDir = path.join(context.appOutDir, "resources");

  if (!fs.existsSync(TOKEN_SOURCE)) {
    console.warn(
      "[update-feed] desktop/.update-feed-token не найден — автообновление в этой сборке отключено (R97i).",
    );
    return;
  }

  const token = fs.readFileSync(TOKEN_SOURCE, "utf8").trim();
  if (!token) {
    console.warn("[update-feed] файл токена пуст — автообновление в этой сборке отключено (R97i).");
    return;
  }

  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, "update-feed-token"), token + "\n", "utf8");
  console.log("[update-feed] токен фида упакован в resources/update-feed-token");
};
