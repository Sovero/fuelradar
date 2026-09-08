import type { MarkerBadge } from "@/lib/map/types";

/** Короткая подпись вида топлива для метки на карте — форматирование кода, не перевод (R98i:
 * список видов топлива не хардкодится, здесь лишь отображается код, пришедший из данных станции). */
export function shortFuelLabel(fuelCode: string): string {
  return fuelCode.replace(/^AI_/i, "").replace(/_/g, " ");
}

/** Стабильный ключ иконки по набору значков + кольцу сети (R103) — чтобы не перерисовывать одинаковые маркеры. */
export function markerIconKey(badges: MarkerBadge[], ringColor?: string | null): string {
  const base = badges.map((b) => `${b.fuelCode}:${b.status}`).join("|") || "empty";
  return ringColor ? `${base}#${ringColor}` : base;
}

const SIZE = 40;

/**
 * Рисует маркер станции на canvas: круг (или сектора при нескольких видах топлива,
 * заливка по статусу — R27/R28) + галочка/крестик, и, если задан `ringColor`,
 * дополнительное кольцо вокруг маркера цветом сети станции (R103) — отдельный
 * слой ПОВЕРХ заливки статуса, не подменяет её. Независимые станции (ringColor
 * не задан) выглядят как раньше, без кольца.
 */
export function drawMarkerIcon(colors: string[], oks: boolean[], ringColor?: string | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const outerR = SIZE / 2 - 2;
  const hasRing = Boolean(ringColor);
  const r = hasRing ? outerR - 5 : outerR - 1; // радиус заливки статуса

  if (hasRing) {
    // Кольцо сети (R103) — внешний ободок; между ним и заливкой статуса — белый зазор.
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fillStyle = ringColor as string;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }

  const n = Math.max(1, colors.length);
  const slice = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, i * slice - Math.PI / 2, (i + 1) * slice - Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = colors[i] ?? "#9ca3af";
    ctx.fill();
  }

  if (!hasRing) {
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Одна станция с одним видом топлива — рисуем галочку/крестик по центру.
  if (n === 1) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (oks[0]) {
      ctx.moveTo(cx - 7, cy);
      ctx.lineTo(cx - 2, cy + 6);
      ctx.lineTo(cx + 8, cy - 7);
    } else {
      ctx.moveTo(cx - 6, cy - 6);
      ctx.lineTo(cx + 6, cy + 6);
      ctx.moveTo(cx + 6, cy - 6);
      ctx.lineTo(cx - 6, cy + 6);
    }
    ctx.stroke();
  }

  return canvas;
}

/** То же самое, но как data URL — нужно провайдерам без canvas-sprite API (например Яндекс.Карты). */
export function drawMarkerIconDataUrl(colors: string[], oks: boolean[], ringColor?: string | null): string {
  return drawMarkerIcon(colors, oks, ringColor).toDataURL("image/png");
}

export const MARKER_ICON_SIZE = SIZE;
