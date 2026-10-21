import { vi } from 'vitest'

/** Compare transports at the same observation time while keeping asynchronous timers real. */
export async function withChatReadClock<T>(read: () => Promise<T>): Promise<T> {
  if (vi.isFakeTimers()) return read()
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    return await read()
  } finally {
    vi.useRealTimers()
  }
}
