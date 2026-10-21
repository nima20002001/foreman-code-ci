import { DeviceApplicationAdmissionError, DeviceApplicationError } from './deviceApplicationError.js'
import { DeviceConnectionError } from './deviceWire.js'

export const deviceRequestTimeoutMs = 120_000

export async function waitForDeviceRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let cancel: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, ms)
      cancel = () => reject(signal!.reason)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  } finally {
    clearTimeout(timer)
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}

/** Only journaled operations may replay a request whose outcome is unknown. */
export async function retryDeviceRequest<T>(request: () => Promise<T>, options: {
  retry: 'idempotent' | 'admission'
  signal?: AbortSignal | undefined
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted()
    try {
      return await request()
    } catch (error) {
      // A Main read that hit a statement or lock timeout rolled back before any effect, so it is
      // replayable like an admission refusal.
      const readTimeout = error instanceof DeviceApplicationError && error.code === 'DATABASE_READ_TIMEOUT'
      const transient = readTimeout || (error instanceof DeviceApplicationError || error instanceof DeviceConnectionError)
        && (error.code === 'backpressure' || error.code === 'timeout')
      const safe = options.retry === 'idempotent' || error instanceof DeviceApplicationAdmissionError || readTimeout
      if (!transient || !safe || attempt >= 4) throw error
      options.signal?.throwIfAborted()
      await waitForDeviceRetry(Math.min(2_000, 250 * 2 ** attempt), options.signal)
    }
  }
}
