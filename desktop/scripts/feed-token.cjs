"use strict";

/**
 * Токен доступа к приватному фиду автообновления: откуда его берёт сборка.
 *
 * Фид — Releases приватного репозитория GitHub (build.publish = github), поэтому
 * каждый запрос фида и загрузка обновления из установленного приложения требуют
 * токена (main.cjs → setFeedURL({provider:"github", private:true, token})).
 * Этот модуль решает одну задачу: получить токен из **надёжного места**, а не из
 * файла, который человек руками положил в рабочую копию репозитория.
 *
 * Порядок источников (первый найденный побеждает):
 *   1. `UPDATE_FEED_TOKEN` — переменная окружения. Основной путь CI (секрет
 *      репозитория) и любой внешний секрет-менеджер, отдающий значение в env.
 *   2. `UPDATE_FEED_TOKEN_FILE` — путь к файлу с токеном. Файл может лежать где
 *      угодно (например, `%USERPROFILE%\.fuelradar\update-feed-token`); если он
 *      внутри рабочей копии — об этом честно предупреждаем: смысл настройки в
 *      том, чтобы секрет не лежал рядом с кодом.
 *   3. Хранилище учётных данных Windows (цель `FuelRadar/update-feed-token`) —
 *      шифрование на диске, привязка к пользователю, ничего в репозитории.
 *      Записывается командой `npm run feed:token:store` (секрет читается из
 *      stdin и не попадает в argv/историю команд).
 *   4. `desktop/.update-feed-token` — прежний путь. Продолжает работать, чтобы
 *      не ломать уже настроенные машины и CI до обновления, но помечен
 *      устаревшим: это ровно тот случай «секрет в рабочей копии».
 *   5. Токены уже авторизованного инструментария — `gh auth token` и
 *      сохранённый git-креденшел для github.com. Они **широкие** (у gh —
 *      скоупы `repo`/`workflow`, т.е. права на запись), а приложению нужно
 *      только чтение релизов, поэтому такие источники включаются лишь по
 *      явному согласию `FUELRADAR_ALLOW_SHARED_FEED_TOKEN=1` и с предупреждением.
 *
 * Токена нет нигде → сборка собирается, автообновление в ней честно отключено
 * (R97i): `patch-feed-token.cjs` пишет предупреждение, приложение на старте
 * сообщает «токен фида не упакован».
 *
 * Сам токен нигде не логируется: в отчётах только идентификатор источника и
 * отпечаток (SHA-256 первых 12 символов) — его достаточно, чтобы сверить, что в
 * сборку попал именно ожидаемый секрет.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, "..", "..");
const LEGACY_FILE = path.join(HERE, "..", ".update-feed-token");
const WINCRED_SCRIPT = path.join(HERE, "wincred.ps1");
// Рабочая запись с токеном фида. Переопределяется FUELRADAR_WINCRED_TARGET — так
// самопроверки и тесты работают на отдельной цели и физически не могут затёрть
// или удалить рабочий токен (см. `npm run feed:token:selfcheck`).
const WINCRED_TARGET = "FuelRadar/update-feed-token";
const WINCRED_TARGET_ENV = "FUELRADAR_WINCRED_TARGET";
const WINCRED_SELFCHECK_TARGET = "FuelRadar/update-feed-token--selfcheck";
const SHARED_TOKENS_OPT_IN = "FUELRADAR_ALLOW_SHARED_FEED_TOKEN";

/** Порядок опроса. `dedicated` — токен создан для фида; иначе — общий токен инструмента. */
const SOURCES = [
  { id: "env", label: "переменная окружения UPDATE_FEED_TOKEN", dedicated: true },
  { id: "file", label: "файл из UPDATE_FEED_TOKEN_FILE", dedicated: true },
  { id: "windows-credential", label: "хранилище учётных данных Windows", dedicated: true },
  { id: "legacy-file", label: "desktop/.update-feed-token (устаревший путь, в рабочей копии)", dedicated: true },
  { id: "gh-cli", label: "токен GitHub CLI (gh auth token)", dedicated: false },
  { id: "git-credential", label: "сохранённый git-креденшел для github.com", dedicated: false },
];

const SOURCE_BY_ID = new Map(SOURCES.map((source) => [source.id, source]));

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    input: options.input,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status === null ? -1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function cleanToken(value) {
  const token = String(value ?? "").trim();
  return token ? token : null;
}

/** Отпечаток токена для логов: сверить можно, восстановить секрет — нет. */
function fingerprint(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function isInsideRepo(targetPath, repoRoot) {
  const relative = path.relative(repoRoot, path.resolve(targetPath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readEnvToken(env) {
  const token = cleanToken(env.UPDATE_FEED_TOKEN);
  return token ? { token } : { problem: "missing", detail: "переменная не задана" };
}

function readFileToken(env, warnings) {
  const configured = cleanToken(env.UPDATE_FEED_TOKEN_FILE);
  if (!configured) return { problem: "missing", detail: "переменная не задана" };
  const target = path.resolve(configured);
  if (!fs.existsSync(target)) return { problem: "missing", detail: `файла нет: ${target}` };
  let token = null;
  try {
    token = cleanToken(fs.readFileSync(target, "utf8"));
  } catch (error) {
    return { problem: "missing", detail: `файл не прочитан: ${error?.message ?? error}` };
  }
  if (!token) return { problem: "empty", detail: `файл пуст: ${target}` };
  if (isInsideRepo(target, REPO_ROOT)) {
    warnings.push(
      `Токен фида берётся из файла внутри рабочей копии репозитория (${path.relative(REPO_ROOT, target)}). ` +
        "Смысл настройки — держать секрет вне репозитория: перенесите файл наружу (например, " +
        `${path.join(os.homedir(), ".fuelradar", "update-feed-token")}) и укажите его в UPDATE_FEED_TOKEN_FILE.`,
    );
  }
  return { token };
}

function readWindowsCredential(run, platform, env, target) {
  if (platform !== "win32") return { problem: "skipped", detail: "не Windows" };
  const powershell = env.FUELRADAR_POWERSHELL || "powershell";
  const result = run(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    WINCRED_SCRIPT,
    "-Mode",
    "read",
    "-Target",
    target,
  ]);
  if (result.status === 3) {
    return { problem: "missing", detail: "запись не найдена в хранилище учётных данных" };
  }
  if (result.status !== 0) {
    // Не путать «нет токена» с «хранилище недоступно»: вторая причина требует
    // вмешательства человека, и оператор должен видеть именно её.
    const detail = String(result.stderr ?? "").trim() || `код ${result.status}`;
    return { problem: "error", detail: `хранилище недоступно: ${detail}` };
  }
  const token = cleanToken(result.stdout);
  return token ? { token } : { problem: "empty", detail: "запись пуста" };
}

function readLegacyFile(warnings, legacyFile) {
  if (!fs.existsSync(legacyFile)) return { problem: "missing", detail: "файла нет" };
  const token = cleanToken(fs.readFileSync(legacyFile, "utf8"));
  if (!token) return { problem: "empty", detail: "файл пуст" };
  warnings.push(
    "Токен взят из desktop/.update-feed-token — устаревший путь (файл в рабочей копии). " +
      "Положите его в переменную окружения UPDATE_FEED_TOKEN, файл вне репозитория " +
      "(UPDATE_FEED_TOKEN_FILE) или в хранилище учётных данных Windows: npm run feed:token:store",
  );
  return { token };
}

function readGhToken(run, warnings) {
  const result = run("gh", ["auth", "token"]);
  if (result.status !== 0) return { problem: "missing", detail: "gh не авторизован или не установлен" };
  const token = cleanToken(result.stdout);
  if (!token) return { problem: "empty", detail: "gh не отдал токен" };
  warnings.push(
    "В сборку упакован токен GitHub CLI: у него широкие права (скоупы repo/workflow, включая запись). " +
      "Приложению нужно только чтение релизов — замените его fine-grained PAT с единственным правом " +
      "Contents: Read-only (npm run feed:token:store).",
  );
  return { token };
}

function readGitCredential(run, warnings) {
  const host = "github.com";
  const result = run("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    // Без интерактивных подсказок: сборка не должна открывать окно ввода пароля.
    env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  if (result.status !== 0) {
    return { problem: "missing", detail: `git credential fill не сработал для ${host}` };
  }
  const line = result.stdout.split(/\r?\n/).find((row) => row.startsWith("password="));
  const token = cleanToken(line ? line.slice("password=".length) : "");
  if (!token) return { problem: "missing", detail: `сохранённого креденшела для ${host} нет` };
  warnings.push(
    "В сборку упакован сохранённый git-креденшел для github.com: его назначение — доступ к git, " +
      "а не чтение релизов. Замените его fine-grained PAT с правом Contents: Read-only " +
      "(npm run feed:token:store).",
  );
  return { token };
}

/**
 * Найти токен фида.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] окружение (в тестах — своё)
 * @param {string} [options.platform] `process.platform` (в тестах — win32 для чужой ОС)
 * @param {Function} [options.run] запуск команды, подменяется в тестах
 * @param {string} [options.legacyFile] путь устаревшего файла-источника (в тестах — свой)
 * @param {string} [options.wincredTarget] имя записи в хранилище Windows (по умолчанию рабочее)
 * @returns {{token: string|null, source: string|null, sourceLabel: string|null, dedicated: boolean,
 *            fingerprint: string|null, warnings: string[], tried: Array<{id: string, label: string, status: string, detail: string}>}}
 */
function resolveFeedToken(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const legacyFile = options.legacyFile ?? LEGACY_FILE;
  const wincredTarget = options.wincredTarget ?? cleanToken(env[WINCRED_TARGET_ENV]) ?? WINCRED_TARGET;
  const warnings = [];
  const tried = [];
  const allowShared = /^(1|true|yes)$/i.test(String(env[SHARED_TOKENS_OPT_IN] ?? "").trim());

  const readers = {
    env: () => readEnvToken(env),
    file: () => readFileToken(env, warnings),
    "windows-credential": () => readWindowsCredential(run, platform, env, wincredTarget),
    "legacy-file": () => readLegacyFile(warnings, legacyFile),
    "gh-cli": () => readGhToken(run, warnings),
    "git-credential": () => readGitCredential(run, warnings),
  };

  for (const source of SOURCES) {
    // Имя записи в хранилище известно только на этом уровне, поэтому подпись
    // источника собираем здесь: иначе человек не поймёт, какую запись смотреть.
    const label =
      source.id === "windows-credential" ? `${source.label} (${wincredTarget})` : source.label;
    if (!source.dedicated && !allowShared) {
      tried.push({
        id: source.id,
        label,
        status: "skipped",
        detail: `общий токен не используется без ${SHARED_TOKENS_OPT_IN}=1`,
      });
      continue;
    }
    const outcome = readers[source.id]();
    if (outcome.token) {
      tried.push({ id: source.id, label, status: "found", detail: "" });
      return {
        token: outcome.token,
        source: source.id,
        sourceLabel: label,
        dedicated: source.dedicated,
        fingerprint: fingerprint(outcome.token),
        warnings,
        tried,
      };
    }
    tried.push({
      id: source.id,
      label,
      status: outcome.problem ?? "missing",
      detail: outcome.detail ?? "",
    });
  }

  return { token: null, source: null, sourceLabel: null, dedicated: false, fingerprint: null, warnings, tried };
}

/** Текст для человека: что опрошено и почему источника нет (без значений секретов). */
function describeResolution(resolution) {
  const lines = [];
  if (resolution.token) {
    lines.push(`Токен фида найден: ${resolution.sourceLabel} (отпечаток ${resolution.fingerprint}).`);
  } else {
    lines.push("Токен фида не найден — автообновление в сборке будет отключено (R97i). Опрошено:");
  }
  for (const attempt of resolution.tried) {
    const mark = attempt.status === "found" ? "✓" : attempt.status === "skipped" ? "–" : "·";
    lines.push(`  ${mark} ${attempt.label}${attempt.detail ? ` — ${attempt.detail}` : ""}`);
  }
  for (const warning of resolution.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

module.exports = {
  LEGACY_FILE,
  REPO_ROOT,
  SHARED_TOKENS_OPT_IN,
  SOURCE_BY_ID,
  SOURCES,
  WINCRED_SCRIPT,
  WINCRED_SELFCHECK_TARGET,
  WINCRED_TARGET,
  WINCRED_TARGET_ENV,
  describeResolution,
  fingerprint,
  resolveFeedToken,
};
