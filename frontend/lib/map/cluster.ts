/**
 * Формат подписи кластера на карте (R29: «близкие маркеры... cluster: 47 АЗС»).
 * Используется как контракт формата, который отражён в text-field слоя
 * `cluster-count` в maplibre-provider.tsx (тот же формат "<число> АЗС").
 */
export function clusterLabel(count: number): string {
  return `${count} АЗС`;
}
