import { vi } from 'vitest'

export function mockDeviceTimezone(timeZone: string): void {
  const dateTimeFormat = new Proxy(Intl.DateTimeFormat, {
    apply: (target, _thisArg, args) => new target(args[0], { timeZone, ...args[1] }),
    construct: (target, args) => new target(args[0], { timeZone, ...args[1] }),
  })
  vi.stubGlobal('Intl', Object.assign(Object.create(Intl), { DateTimeFormat: dateTimeFormat }))
}
