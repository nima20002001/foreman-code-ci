export class CiWaitTimeout extends Error {}

export async function waitForCi<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean,
  options: { deadline: number; intervalMs?: number }) {
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    const remaining = options.deadline - Date.now()
    if (remaining <= 0) throw new CiWaitTimeout(`Timed out waiting for ${label}.`)
    await new Promise(resolve => setTimeout(resolve, Math.min(options.intervalMs ?? 1000, remaining)))
  }
}
