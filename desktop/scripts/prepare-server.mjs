"use strict";

/**
 * Готовит встроенный сервер интерфейса для Electron:
 *   1. `next build` с NEXT_OUTPUT=standalone (frontend).
 *   2. Копирует .next/standalone → desktop/server-dist,
 *      затем докладывает статику (.next/static, public) — как в доке Next.js
 *      «Self-hosting standalone»: server.js не запустится без этих двух папок.
 *
 * Запуск: `cd desktop && npm run prepare:server` (вызывается и из `npm run dist`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", ".."); // desktop/scripts → репозиторий
const FRONTEND = path.join(ROOT, "frontend");
const DEST = path.join(ROOT, "desktop", "server-dist");

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function runStep(name, command, args, cwd, extraEnv = {}) {
  console.log(`> ${name}`);
  // Без shell: Node ≥ 20 на Windows не запускает .cmd без shell (CVE-2024-27980),
  // поэтому зовём next напрямую через node — портируемо и без сюрпризов.
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`${name} failed with code ${result.status}`);
  }
}

function main() {
  // 1. Production-сборка Next.js в standalone-режиме.
  const nextBin = path.join(FRONTEND, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) {
    throw new Error(`Не найден Next.js: ${nextBin}. Выполните cd frontend && npm install`);
  }
  runStep("frontend: next build (standalone)", process.execPath, [nextBin, "build"], FRONTEND, {
    NEXT_OUTPUT: "standalone",
  });

  // 2. Свежий server-dist: standalone + статика + public.
  //    По документации Next.js «Self-hosting standalone» static и public
  //    кладутся рядом с server.js (в корень standalone, не во вложенную папку).
  rmrf(DEST);
  copy(path.join(FRONTEND, ".next", "standalone"), DEST);
  copy(path.join(FRONTEND, ".next", "static"), path.join(DEST, ".next", "static"));
  copy(path.join(FRONTEND, "public"), path.join(DEST, "public"));

  console.log("Готово: desktop/server-dist (запускается main.cjs на свободном порту).");
}

try {
  main();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
