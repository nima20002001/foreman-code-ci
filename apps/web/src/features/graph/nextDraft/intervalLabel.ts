export const UNITS = [{ value: 'seconds', label: 'Seconds', seconds: 1 }, { value: 'minutes', label: 'Minutes', seconds: 60 },
  { value: 'hours', label: 'Hours', seconds: 3600 }] as const
export type Unit = typeof UNITS[number]['value']
export const unitSeconds = (unit: Unit) => UNITS.find(item => item.value === unit)!.seconds
export const largestUnit = (seconds: number): Unit => seconds % 3600 === 0 ? 'hours' : seconds % 60 === 0 ? 'minutes' : 'seconds'

/** "Every 5 min" for an interval in seconds. */
export function intervalLabel(seconds: number): string {
  const unit = largestUnit(seconds), count = seconds / unitSeconds(unit)
  return `Every ${count} ${unit === 'hours' ? 'h' : unit === 'minutes' ? 'min' : 's'}`
}
