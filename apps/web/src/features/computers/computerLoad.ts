export type ComputerLoadLevel = 'unknown' | 'offline' | 'calm' | 'busy' | 'heavy' | 'saturated'

export interface ComputerLoadInput {
  /** null when presence is not currently observed. */
  online: boolean | null
  cpuPercent: number | null
  memoryPercent: number | null
  diskUsedPercent: number | null
  /** Share of a cloud CI service's machines in use. */
  ciSlotsPercent?: number | null
  /** Running Agents plus running CI jobs. */
  workloads: number
}

/** Lowest value at which each signal reaches busy, heavy and saturated. */
export const LOAD_THRESHOLDS = {
  cpuPercent: [50, 75, 90],
  memoryPercent: [60, 80, 92],
  diskUsedPercent: [80, 90, 95],
  ciSlotsPercent: [50, 75, 100],
  // Agents mostly wait on models, so only a crowd of them counts as heavy on its own.
  workloads: [1, 8, Infinity],
} as const

const LEVELS = ['calm', 'busy', 'heavy', 'saturated'] as const

export const LOAD_LABELS: Record<ComputerLoadLevel, string> = {
  unknown: 'Status unknown',
  offline: 'Offline',
  calm: 'Plenty of capacity',
  busy: 'Some load',
  heavy: 'Heavy load',
  saturated: 'Near its limits',
}

/** The most loaded signal decides; unknown readings are ignored rather than read as idle or full. */
export function computerLoad(input: ComputerLoadInput): ComputerLoadLevel {
  if (input.online === null) return 'unknown'
  if (!input.online) return 'offline'
  let level = 0
  for (const key of Object.keys(LOAD_THRESHOLDS) as (keyof typeof LOAD_THRESHOLDS)[]) {
    const value = input[key]
    if (value === null || value === undefined) continue
    level = Math.max(level, LOAD_THRESHOLDS[key].filter(threshold => value >= threshold).length)
  }
  return LEVELS[level]!
}
