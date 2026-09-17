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
const OUTLINE = "#ffffff";
const HALO = "#ffffff";
const DARK_DETAIL = "#334155";

/** Контур корпуса бензоколонки внутри иконки. */
function pumpBodyPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(10, 12);
  ctx.quadraticCurveTo(10, 9, 13, 9);
  ctx.lineTo(24, 9);
  ctx.quadraticCurveTo(27, 9, 27, 12);
  ctx.lineTo(27, 31);
  ctx.lineTo(10, 31);
  ctx.closePath();
}

/**
 * Рисует на карте понятную иконку бензоколонки: цветной корпус показывает статус
 * топлива, вертикальные сегменты — несколько выбранных видов топлива, а кольцо
 * сети остаётся отдельным внешним слоем (R27/R28/R103).
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

  // Светлый ореол сохраняет читаемость силуэта на любой подложке карты.
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.fillStyle = hasRing ? (ringColor as string) : HALO;
  ctx.fill();

  if (hasRing) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 4, 0, Math.PI * 2);
    ctx.fillStyle = HALO;
    ctx.fill();
  }

  // Шланг и пистолет — рисуем позади корпуса, чтобы силуэт считывался как колонка.
  ctx.strokeStyle = hasRing ? OUTLINE : DARK_DETAIL;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(26, 13);
  ctx.lineTo(31, 13);
  ctx.lineTo(31, 23);
  ctx.quadraticCurveTo(31, 26, 28, 26);
  ctx.lineTo(27, 26);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(31, 13);
  ctx.lineTo(34, 13);
  ctx.lineTo(34, 17);
  ctx.stroke();

  const bodyLeft = 10;
  const bodyTop = 9;
  const bodyWidth = 17;
  const bodyHeight = 22;
  const segmentColors = colors.length ? colors : ["#9ca3af"];
  const segmentWidth = bodyWidth / segmentColors.length;

  // Статусная заливка clipped по корпусу; несколько видов топлива получают полосы,
  // но общая форма иконки остаётся бензоколонкой, а не абстрактным кругом.
  ctx.save();
  pumpBodyPath(ctx);
  ctx.clip();
  for (let i = 0; i < segmentColors.length; i += 1) {
    ctx.fillStyle = segmentColors[i] ?? "#9ca3af";
    ctx.fillRect(bodyLeft + i * segmentWidth, bodyTop, segmentWidth + 1, bodyHeight);
  }
  ctx.restore();

  pumpBodyPath(ctx);
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();

  // Экран колонки. Для одного топлива в нём остаётся знакомый ✓/✕,
  // для нескольких экран просто помогает распознать пиктограмму.
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.fillRect(13, 14, 11, 6);
  if (segmentColors.length === 1) {
    ctx.strokeStyle = segmentColors[0] ?? DARK_DETAIL;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (oks[0]) {
      ctx.moveTo(15, 17);
      ctx.lineTo(17, 19);
      ctx.lineTo(22, 15);
    } else {
      ctx.moveTo(15, 15);
      ctx.lineTo(22, 19);
      ctx.moveTo(22, 15);
      ctx.lineTo(15, 19);
    }
    ctx.stroke();
  }

  // Основание делает пиктограмму устойчивой к визуальному шуму карты.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(8, 33);
  ctx.lineTo(29, 33);
  ctx.stroke();

  return canvas;
}

/** То же самое, но как data URL — нужно провайдерам без canvas-sprite API (например Яндекс.Карты). */
export function drawMarkerIconDataUrl(colors: string[], oks: boolean[], ringColor?: string | null): string {
  return drawMarkerIcon(colors, oks, ringColor).toDataURL("image/png");
}

export const MARKER_ICON_SIZE = SIZE;
