"use strict";

/**
 * Диагностический пробник геолокации внутри настоящего Electron (T-geo).
 * Отвечает на вопрос машины: «даёт ли этот ПК позицию через Chromium-стек
 * Electron вообще» — coarse сначала (GPS-чипа на ПК нет, Wi-Fi/провайдер),
 * затем precise. Результат — строки GEO_RESULT и код выхода:
 *   0 — хотя бы одна попытка успешна; 4 — обе неудачны (тогда причины).
 *
 * Запуск: cd desktop && npx electron scripts/geo-probe.cjs
 * Пробник ничего не сохраняет и никуда не отправляет координаты.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const html = [
  "<!doctype html><html><head><meta charset='utf-8'>",
  "<title>geo probe</title></head>",
  "<body>probe</body></html>",
].join("");

function stage(win, label, options) {
  return win.webContents
    .executeJavaScript(
      `new Promise((resolve) => {
        if (!navigator.geolocation) { resolve({ stage: ${JSON.stringify(label)}, ok: false, code: "unsupported", message: "navigator.geolocation undefined" }); return; }
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ stage: ${JSON.stringify(label)}, ok: true, lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, age: p.timestamp }),
          (e) => resolve({ stage: ${JSON.stringify(label)}, ok: false, code: e.code, message: e.message }),
          ${JSON.stringify(options)}
        );
      })`,
      true,
    )
    .then((r) => {
      console.log("GEO_RESULT " + JSON.stringify(r));
      return r;
    })
    .catch((err) => {
      const r = { stage: label, ok: false, code: "exec-error", message: String(err) };
      console.log("GEO_RESULT " + JSON.stringify(r));
      return r;
    });
}

app.whenReady().then(async () => {
  console.log(
    "GEO_ENV " +
      JSON.stringify({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        secure: true,
        platform: os.platform(),
      }),
  );

  // Пробник разрешает всё сам: нам важен источник координат, а не диалог.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "geolocation");
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  const tmpFile = path.join(os.tmpdir(), "fuelradar-geo-probe.html");
  fs.writeFileSync(tmpFile, html, "utf8");

  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadFile(tmpFile);

  // Как в планируемом фиксе useGeolocation: сначала coarse (быстрый ответ
  // от Wi-Fi/провайдера), затем precise. На ПК без GPS precise часто
  // и не отвечает — это норма, если coarse уже дал позицию.
  const coarse = await stage(win, "coarse", {
    enableHighAccuracy: false,
    timeout: 15000,
    maximumAge: 30000,
  });
  let precise = { stage: "precise", ok: false, code: "skipped", message: "coarse ok" };
  if (!coarse.ok) {
    precise = await stage(win, "precise", {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0,
    });
  }

  fs.unlinkSync(tmpFile);
  app.exit(coarse.ok || precise.ok ? 0 : 4);
});

// Страховка: пробник не должен висеть дольше 45 секунд ни при каких обстоятельствах.
setTimeout(() => {
  console.log("GEO_RESULT " + JSON.stringify({ stage: "hard-timeout", ok: false, code: "timeout" }));
  app.exit(4);
}, 45000).unref();
