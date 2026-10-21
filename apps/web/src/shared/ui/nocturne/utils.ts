/** Small presentation helpers. No API state, permissions or domain models live here. */
export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum
}

export function nextEnabledIndex(
  current: number,
  direction: 1 | -1,
  disabled: readonly boolean[],
): number {
  if (disabled.length === 0 || disabled.every(Boolean)) return -1
  for (let step = 1; step <= disabled.length; step += 1) {
    const index = ((current + direction * step) % disabled.length + disabled.length) % disabled.length
    if (!disabled[index]) return index
  }
  return -1
}

export function pageWindow(page: number, totalPages: number): number[] {
  const total = Number.isFinite(totalPages) ? Math.max(1, Math.floor(totalPages)) : 1
  const current = clamp(Math.floor(page), 1, total)
  return [...new Set([1, current - 1, current, current + 1, total])]
    .filter((value) => value >= 1 && value <= total)
    .sort((a, b) => a - b)
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
