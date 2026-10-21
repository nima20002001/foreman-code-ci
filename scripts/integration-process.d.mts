export function groupUsed(pgid: number | undefined): boolean
export function stopGroup(pgid: number | undefined, options?: {
  signal?: NodeJS.Signals
  graceMs?: number
}): Promise<void>
