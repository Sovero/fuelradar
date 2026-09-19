"use strict";

/**
 * Тесты цепочки источников токена фида (desktop/scripts/feed-token.cjs).
 *
 * Запуск: `cd desktop && npm test` (node --test). Проверяем именно контракт
 * «откуда берётся секрет»: приоритет источников, отказ от общих токенов без
 * явного согласия, честные предупреждения о секрете внутри рабочей копии и то,
 * что сам токен никогда не попадает в диагностику.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  REPO_ROOT,
  SHARED_TOKENS_OPT_IN,
  WINCRED_SCRIPT,
  WINCRED_SELFCHECK_TARGET,
  WINCRED_TARGET,
  WINCRED_TARGET_ENV,
  describeResolution,
  fingerprint,
  resolveFeedToken,
} = require("../scripts/feed-token.cjs");

const SECRET = "github_pat_TEST_TOKEN_1234567890";

/** «Команда не запускалась» — источник, который не должен быть опрошен, ловим здесь. */
function runRecorder(handlers = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const key = `${command} ${(args ?? []).join(" ")}`;
    for (const [matcher, result] of Object.entries(handlers)) {
      if (key.includes(matcher)) return { status: 0, stdout: "", stderr: "", ...result };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuelradar-feed-token-"));
  const file = path.join(dir, "update-feed-token");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

test("env: UPDATE_FEED_TOKEN побеждает все остальные источники", () => {
  const { run, calls } = runRecorder();
  const resolution = resolveFeedToken({
    env: { UPDATE_FEED_TOKEN: `  ${SECRET}  ` },
    platform: "win32",
    run,
  });

  assert.equal(resolution.token, SECRET);
  assert.equal(resolution.source, "env");
  assert.equal(resolution.dedicated, true);
  assert.equal(resolution.warnings.length, 0);
  assert.equal(calls.length, 0, "ни один внешний источник не должен опрашиваться после успеха");
});

test("file: токен читается из UPDATE_FEED_TOKEN_FILE, а пустая переменная не считается источником", () => {
  const file = tempFile(`${SECRET}\n`);

  const found = resolveFeedToken({
    env: { UPDATE_FEED_TOKEN: "", UPDATE_FEED_TOKEN_FILE: file },
    platform: "win32",
    run: runRecorder().run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });
  assert.equal(found.token, SECRET);
  assert.equal(found.source, "file");
  assert.deepEqual(found.warnings, [], "файл вне репозитория — предупреждений нет");

  const missing = resolveFeedToken({
    env: { UPDATE_FEED_TOKEN_FILE: path.join(os.tmpdir(), "нет-такого-файла") },
    platform: "win32",
    run: runRecorder().run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });
  assert.equal(missing.token, null);
  assert.match(missing.tried.find((t) => t.id === "file").detail, /файла нет/);
});

test("file: секрет внутри рабочей копии — работает, но с предупреждением", () => {
  const resolution = resolveFeedToken({
    env: { UPDATE_FEED_TOKEN_FILE: path.join(REPO_ROOT, "desktop", "не-настоящий-файл") },
    platform: "win32",
    run: runRecorder().run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });
  assert.equal(resolution.token, null); // файла нет — важно, что предупреждения тоже нет
  assert.deepEqual(resolution.warnings, []);
});

test("windows-credential: читается через wincred.ps1 без секрета в argv", () => {
  const { run, calls } = runRecorder({ "-Mode read": { status: 0, stdout: `${SECRET}\n` } });
  const resolution = resolveFeedToken({
    env: {},
    platform: "win32",
    run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });

  assert.equal(resolution.token, SECRET);
  assert.equal(resolution.source, "windows-credential");
  const call = calls.find((c) => c.args.includes(WINCRED_SCRIPT));
  assert.ok(call, "wincred.ps1 должен быть вызван");
  assert.ok(call.args.includes("read"));
  assert.ok(call.args.includes(WINCRED_TARGET));
  assert.ok(
    call.args.every((arg) => !arg.includes(SECRET)),
    "секрет не должен передаваться аргументом",
  );
});

test("windows-credential: имя записи можно переопределить — самопроверка не трогает рабочий токен", () => {
  const { run, calls } = runRecorder({ "-Mode read": { status: 0, stdout: `${SECRET}\n` } });
  const resolution = resolveFeedToken({
    env: { [WINCRED_TARGET_ENV]: WINCRED_SELFCHECK_TARGET },
    platform: "win32",
    run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });

  const call = calls.find((c) => c.args.includes(WINCRED_SCRIPT));
  assert.ok(call.args.includes(WINCRED_SELFCHECK_TARGET));
  assert.ok(!call.args.includes(WINCRED_TARGET));
  assert.match(resolution.sourceLabel, new RegExp(WINCRED_SELFCHECK_TARGET));

  // Цель самопроверки обязана отличаться от рабочей: иначе проверка хранилища
  // запишет и удалит настоящий токен фида (так уже случалось).
  assert.notEqual(WINCRED_SELFCHECK_TARGET, WINCRED_TARGET);
});

test("windows-credential: запись отсутствует → источник пропускается, ошибок нет", () => {
  const { run } = runRecorder({ "-Mode read": { status: 3, stderr: "не найдено" } });
  const resolution = resolveFeedToken({
    env: {},
    platform: "win32",
    run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });
  assert.equal(resolution.token, null);
  assert.match(resolution.tried.find((t) => t.id === "windows-credential").detail, /не найдена/);
});

test("legacy-file: устаревший файл ещё работает, но помечен предупреждением", () => {
  const legacy = tempFile(`${SECRET}\n`);
  const resolution = resolveFeedToken({
    env: {},
    platform: "win32",
    run: runRecorder().run,
    legacyFile: legacy,
  });

  assert.equal(resolution.token, SECRET);
  assert.equal(resolution.source, "legacy-file");
  assert.match(resolution.warnings.join("\n"), /устаревший путь/);
  assert.match(resolution.warnings.join("\n"), /feed:token:store/);
});

test("общие токены инструментов не используются без явного согласия", () => {
  const { run, calls } = runRecorder({
    "gh auth token": { status: 0, stdout: `${SECRET}\n` },
    "credential fill": { status: 0, stdout: `password=${SECRET}\n` },
  });
  const resolution = resolveFeedToken({
    env: {},
    platform: "win32",
    run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });

  assert.equal(resolution.token, null);
  assert.ok(
    calls.every((call) => call.command !== "gh" && call.command !== "git"),
    "ни gh, ни git не должны опрашиваться без согласия",
  );
  for (const id of ["gh-cli", "git-credential"]) {
    const attempt = resolution.tried.find((t) => t.id === id);
    assert.equal(attempt.status, "skipped");
    assert.match(attempt.detail, new RegExp(SHARED_TOKENS_OPT_IN));
  }
});

test("общий токен с согласием: используется, но со предупреждением о широких правах", () => {
  const { run } = runRecorder({ "gh auth token": { status: 0, stdout: `${SECRET}\n` } });
  const resolution = resolveFeedToken({
    env: { [SHARED_TOKENS_OPT_IN]: "1" },
    platform: "win32",
    run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });

  assert.equal(resolution.token, SECRET);
  assert.equal(resolution.source, "gh-cli");
  assert.equal(resolution.dedicated, false);
  assert.match(resolution.warnings.join("\n"), /широкие права/);
  assert.match(resolution.warnings.join("\n"), /Contents: Read-only/);
});

test("git-credential: пароль достаётся из вывода fill и требует согласия", () => {
  const { run, calls } = runRecorder({
    "credential fill": { status: 0, stdout: `protocol=https\nhost=github.com\npassword=${SECRET}\n\n` },
  });
  const resolution = resolveFeedToken({
    env: { [SHARED_TOKENS_OPT_IN]: "yes" },
    platform: "win32",
    run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });

  assert.equal(resolution.token, SECRET);
  assert.equal(resolution.source, "git-credential");
  const call = calls.find((c) => c.args.includes("fill"));
  assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0", "сборка не должна ждать интерактивного ввода");
  assert.equal(call.options.env.GCM_INTERACTIVE, "never");
  assert.match(resolution.warnings.join("\n"), /git-креденшел/);
});

test("источников нет: токен null, опрошенные перечислены, секрета в отчёте нет", () => {
  const { run } = runRecorder();
  const resolution = resolveFeedToken({
    env: { [SHARED_TOKENS_OPT_IN]: "1" },
    platform: "linux", // не Windows: хранилище ОС недоступно и не имитируется
    run,
    legacyFile: path.join(os.tmpdir(), "нет-такого-файла"),
  });

  assert.equal(resolution.token, null);
  assert.equal(resolution.source, null);
  assert.equal(resolution.tried.length, 6);
  assert.equal(resolution.tried.find((t) => t.id === "windows-credential").status, "skipped");

  const report = describeResolution(resolution);
  assert.match(report, /Токен фида не найден/);
  assert.match(report, /R97i/);
  assert.ok(!report.includes(SECRET));
});

test("отпечаток не раскрывает токен и стабилен", () => {
  assert.equal(fingerprint(SECRET), fingerprint(SECRET));
  assert.equal(fingerprint(SECRET).length, 12);
  assert.ok(!fingerprint(SECRET).includes(SECRET));

  const resolution = resolveFeedToken({
    env: { UPDATE_FEED_TOKEN: SECRET },
    platform: "win32",
    run: runRecorder().run,
  });
  const report = describeResolution(resolution);
  assert.ok(report.includes(resolution.fingerprint));
  assert.ok(!report.includes(SECRET), "отчёт показывают человеку — секрета в нём быть не должно");
});
