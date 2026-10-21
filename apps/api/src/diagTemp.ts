// TEMPORARY diagnostic, removed before the fix.
export function ev(label: string): void {
  const g = globalThis as { __events?: string[] }
  const events = g.__events ??= []
  events.push(`${new Date().toISOString().slice(11, 23)} ${label}`)
  if (events.length > 400) events.splice(0, 100)
}
