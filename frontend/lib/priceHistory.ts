import { formatPrice, parseUtcIso } from "./format";
import type { HistoryItem } from "./types";
import type { SparklinePoint } from "@/components/station/Sparkline";

/** Цена не имеет статусного цвета — палитру статусов не трогаем (spec §7). */
const PRICE_LINE_COLOR = "#2563eb";

/** Родительный падеж после «после»: 1 записи, 2 записей, 5 записей. */
function gapLabel(skipped: number): string {
  const word = skipped === 1 ? "записи" : "записей";
  return ` · после ${skipped} ${word} без цены`;
}

function formatTime(iso: string): string {
  const at = parseUtcIso(iso);
  return at
    ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at)
    : "";
}

/**
 * Точки спарклайна цены (spec: «История цены графиком»): только наблюдения с
 * ненулевой ценой, в хронологическом порядке. Пропуски честны: записи без
 * цены МЕЖДУ ценовыми видны в подписи точки («после N записей без цены»);
 * записи до первой цены разрыва не создают.
 */
export function buildPricePoints(history: HistoryItem[]): SparklinePoint[] {
  const chronological = [...history].sort(
    (a, b) => (parseUtcIso(a.observed_at)?.getTime() ?? 0) - (parseUtcIso(b.observed_at)?.getTime() ?? 0),
  );

  let skipped = 0;
  let seenPrice = false;
  const points: SparklinePoint[] = [];
  for (const item of chronological) {
    if (item.price === null || item.price === undefined) {
      if (seenPrice) skipped += 1;
      continue;
    }
    points.push({
      x: parseUtcIso(item.observed_at)?.getTime() ?? 0,
      y: item.price,
      color: PRICE_LINE_COLOR,
      label: `${formatPrice(item.price, item.price_currency ?? "RUB")} — ${item.source}, ${formatTime(item.observed_at)}${
        seenPrice && skipped > 0 ? gapLabel(skipped) : ""
      }`,
    });
    seenPrice = true;
    skipped = 0;
  }
  return points;
}
