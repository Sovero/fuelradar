"use client";

export interface SparklinePoint {
  x: number;
  y: number;
  color: string;
  label: string;
}

export interface SparklineEdgeLabels {
  min: string;
  max: string;
}

/** Простой линейный график без внешних зависимостей — инлайновый SVG (R46). */
export function Sparkline({
  points,
  height = 80,
  edgeLabels,
}: {
  points: SparklinePoint[];
  height?: number;
  /** Подписи у крайних точек (мин внизу, макс сверху); позиции считаются по данным. */
  edgeLabels?: SparklineEdgeLabels;
}) {
  const width = 320;
  if (points.length === 0) return null;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(...ys, 1);

  const scaleX = (x: number) => (maxX === minX ? width / 2 : ((x - minX) / (maxX - minX)) * (width - 16) + 8);
  const scaleY = (y: number) => height - 12 - ((y - minY) / (maxY - minY || 1)) * (height - 24);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(p.x).toFixed(1)},${scaleY(p.y).toFixed(1)}`).join(" ");

  // Крайние по y точки: минимальное значение рисуется у линии minY, максимальное — у maxY.
  const minPoint = points.reduce((a, b) => (b.y < a.y ? b : a));
  const maxPoint = points.reduce((a, b) => (b.y > a.y ? b : a));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="График истории">
      <path d={path} fill="none" stroke="#94a3b8" strokeWidth={1.5} />
      {points.map((p, i) => (
        <circle key={i} cx={scaleX(p.x)} cy={scaleY(p.y)} r={3.5} fill={p.color}>
          <title>{p.label}</title>
        </circle>
      ))}
      {edgeLabels && (
        <>
          <text
            x={Math.min(Math.max(scaleX(minPoint.x), 30), width - 30)}
            y={Math.min(scaleY(minPoint.y) + 14, height - 2)}
            textAnchor="middle"
            fontSize={10}
            fill="#64748b"
          >
            {edgeLabels.min}
          </text>
          <text
            x={Math.min(Math.max(scaleX(maxPoint.x), 30), width - 30)}
            y={Math.max(scaleY(maxPoint.y) - 6, 10)}
            textAnchor="middle"
            fontSize={10}
            fill="#64748b"
          >
            {edgeLabels.max}
          </text>
        </>
      )}
    </svg>
  );
}
