"use strict";

/**
 * CLI вокруг `feed-token.cjs`: показать, откуда возьмётся токен фида, и положить
 * его в надёжное место, не создавая файла в рабочей копии.
 *
 *   npm run feed:token:status            # что нашлось (источник + отпечаток)
 *   npm run feed:token:status -- --require   # то же, но код 1, если токена нет (CI)
 *   npm run feed:token:store             # сохранить токен в хранилище Windows
 *   npm run feed:token:forget            # удалить запись (ротация/отзыв токена)
 *   npm run feed:token:selfcheck         # проверить само хранилище на отдельной цели
 *
 * Везде можно указать `--target <имя записи>` — например, для самопроверки:
 * проверки обязаны работать на отдельной цели, иначе они затрут или удалят
 * рабочий токен.
 *
 * Секрет никогда не передаётся аргументом: `store` читает его из stdin, поэтому
 * значение не попадает ни в список процессов, ни в историю команд. В выводе —
 * только отпечаток (SHA-256[:12]), по нему можно сверить, что сохранился именно
 * ожидаемый токен.
 */

const { spawnSync } = require("node:child_process");

const {
  WINCRED_SCRIPT,
  WINCRED_SELFCHECK_TARGET,
  WINCRED_TARGET,
  WINCRED_TARGET_ENV,
  describeResolution,
  fingerprint,
  resolveFeedToken,
} = require("./feed-token.cjs");

/** `--target <имя>` из аргументов командной строки (по умолчанию — рабочая запись). */
function targetFrom(argv, fallback = WINCRED_TARGET) {
  const index = argv.indexOf("--target");
  const value = index === -1 ? "" : String(argv[index + 1] ?? "").trim();
  return value || fallback;
}

function status(requireToken, target = WINCRED_TARGET) {
  const resolution = resolveFeedToken({ env: { ...process.env, [WINCRED_TARGET_ENV]: target } });
  console.log(describeResolution(resolution));
  if (!resolution.token) {
    if (requireToken) {
      console.error("Токен фида обязателен (--require), но не найден ни в одном источнике.");
      return 1;
    }
    console.log("Сборка соберётся, но автообновление в ней будет отключено (R97i).");
    return 0;
  }
  if (!resolution.dedicated) {
    console.log("Внимание: используется общий токен инструмента, а не отдельный токен фида.");
  }
  return 0;
}

function runWincred(mode, input, target = WINCRED_TARGET) {
  return spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINCRED_SCRIPT, // абсолютный путь (scripts/wincred.ps1), склеивать с __dirname нельзя
      "-Mode",
      mode,
      "-Target",
      target,
    ],
    { input, encoding: "utf8", windowsHide: true },
  );
}

/**
 * Самопроверка хранилища на одноразовой цели.
 *
 * Отдельная запись нужна именно потому, что проверка пишет и удаляет секрет: на
 * рабочей цели она бы затёрла (или стёрла) настоящий токен фида.
 */
function selfcheck(target = WINCRED_SELFCHECK_TARGET) {
  if (process.platform !== "win32") {
    console.error("Хранилище учётных данных Windows доступно только на Windows.");
    return 1;
  }
  const probe = `selfcheck-${Date.now()}`;
  const written = runWincred("write", probe, target);
  if (written.status !== 0) {
    console.error(written.stderr?.trim() || `Запись не удалась (код ${written.status}).`);
    return 1;
  }
  const read = runWincred("read", undefined, target);
  const ok = read.status === 0 && read.stdout.trim() === probe;
  const removed = runWincred("delete", undefined, target);
  console.log(`Самопроверка на цели «${target}»: запись ${ok ? "ok" : "СБОЙ"}, удаление — ${removed.status === 0 ? "ok" : "СБОЙ"}.`);
  if (!ok || removed.status !== 0) {
    console.error("Хранилище учётных данных Windows работает нештатно — токен туда лучше не класть.");
    return 1;
  }
  console.log("Рабочая запись токена фида не затрагивалась.");
  return 0;
}

function forget(target = WINCRED_TARGET) {
  if (process.platform !== "win32") {
    console.error("Хранилище учётных данных Windows доступно только на Windows.");
    return 1;
  }
  const result = runWincred("delete", undefined, target);
  if (result.status === 3) {
    console.log(`Записи «${target}» в хранилище нет — удалять нечего.`);
    return 0;
  }
  if (result.status !== 0) {
    console.error(result.stderr?.trim() || `Не удалось удалить запись (код ${result.status}).`);
    return 1;
  }
  console.log(`Запись «${target}» удалена из хранилища Windows.`);
  return 0;
}

function store(target = WINCRED_TARGET) {
  if (process.platform !== "win32") {
    console.error("Хранилище учётных данных Windows доступно только на Windows; используйте UPDATE_FEED_TOKEN_FILE.");
    return 1;
  }
  if (process.stdin.isTTY) {
    console.log(`Токен фида → хранилище учётных данных Windows, цель «${target}» (Enter для подтверждения).`);
    console.log("Вставьте токен (fine-grained PAT, право Contents: Read-only) и нажмите Enter:");
  }

  const secret = require("node:fs").readFileSync(0, "utf8").trim();
  if (!secret) {
    console.error("Пустой ввод — запись не создана.");
    return 1;
  }

  const result = runWincred("write", secret, target);
  if (result.status !== 0) {
    console.error(result.stderr?.trim() || `Не удалось сохранить токен (код ${result.status}).`);
    return 1;
  }

  const stored = resolveFeedToken({
    env: { ...process.env, UPDATE_FEED_TOKEN: "", UPDATE_FEED_TOKEN_FILE: "", [WINCRED_TARGET_ENV]: target },
  });
  const fromCredential =
    stored.token && stored.source === "windows-credential" ? stored.fingerprint : fingerprint(secret);
  console.log(`Сохранено в хранилище Windows: цель «${target}», отпечаток ${fromCredential}.`);
  if (stored.token && stored.source !== "windows-credential") {
    console.log(
      `Замечание: сборка всё равно возьмёт токен из «${stored.sourceLabel}» — он приоритетнее хранилища, ` +
        "пока эти переменные окружения заданы.",
    );
  }
  return 0;
}

function main(argv) {
  const command = argv[0] || "status";
  if (command === "status") return status(argv.includes("--require"), targetFrom(argv));
  if (command === "store") return store(targetFrom(argv));
  if (command === "forget") return forget(targetFrom(argv));
  if (command === "selfcheck") return selfcheck(targetFrom(argv, WINCRED_SELFCHECK_TARGET));
  console.error(`Неизвестная команда: ${command}. Доступно: status [--require], store, forget, selfcheck.`);
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { forget, main, selfcheck, status, store };
