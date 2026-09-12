"use strict";

/**
 * Делает desktop/build/icon.ico из frontend/public/icon.svg:
 * PNG 256/128/64/48/32/16 (через resvg-js) → ICO-контейнер (сборка вручную,
 * без сторонних конвертеров). Запуск: `cd desktop && npm run icon`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", ".."); // desktop/scripts → репозиторий
const SVG = path.join(ROOT, "frontend", "public", "icon.svg");
const OUT_DIR = path.join(ROOT, "desktop", "build");

const SIZES = [256, 128, 64, 48, 32, 16];

function buildIco(entries) {
  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const directory = [];
  for (const entry of entries) {
    const size = entry.png.length;
    const width = entry.size >= 256 ? 0 : entry.size; // 256 кодируется как 0
    directory.push({ width, height: width, size, offset });
    offset += size;
  }
  const buffer = Buffer.alloc(offset);
  // ICONDIR
  buffer.writeUInt16LE(0, 0); // reserved
  buffer.writeUInt16LE(1, 2); // type: icon
  buffer.writeUInt16LE(entries.length, 4); // count
  entries.forEach((entry, index) => {
    const base = 6 + index * 16;
    const dir = directory[index];
    buffer.writeUInt8(dir.width, base);
    buffer.writeUInt8(dir.height, base + 1);
    buffer.writeUInt8(0, base + 2); // palette
    buffer.writeUInt8(0, base + 3); // reserved
    buffer.writeUInt16LE(1, base + 4); // planes
    buffer.writeUInt16LE(32, base + 6); // bpp
    buffer.writeUInt32LE(dir.size, base + 8);
    buffer.writeUInt32LE(dir.offset, base + 12);
  });
  entries.forEach((entry, index) => {
    entry.png.copy(buffer, directory[index].offset);
  });
  return buffer;
}

function main() {
  const svg = fs.readFileSync(SVG, "utf8");
  const entries = SIZES.map((size) => {
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
    return { size, png: Buffer.from(resvg.render().asPng()) };
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), buildIco(entries));
  console.log(`Готово: build/icon.ico (${SIZES.join("/")})`);
}

try {
  main();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
