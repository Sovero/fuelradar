"use client";

export interface SparklinePoint {
  x: number;
  y: number;
  color: string;
  label: string;
}

/** Простой линейный график без внешних зависимостей — инлайновый SVG (R46). */
export function Sparkline({ points, height = 80 }: { points: SparklinePoint[]; height?: number }) {
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

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="График истории">
      <path d={path} fill="none" stroke="#94a3b8" strokeWidth={1.5} />
      {points.map((p, i) => (
        <circle key={i} cx={scaleX(p.x)} cy={scaleY(p.y)} r={3.5} fill={p.color}>
          <title>{p.label}</title>
        </circle>
      ))}
    </svg>
  );
}
