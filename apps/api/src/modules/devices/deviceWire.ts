import { DEVICE_BUFFER_BYTES, DEVICE_FRAME_BYTES, DEVICE_QUEUE_DEPTH, type DeviceFrame } from '@foreman-code/contracts/device-connection'

export class DeviceConnectionError extends Error {
  readonly code: import('@foreman-code/contracts/device-connection').DeviceFailureCode
  /** Diagnostic cause for logs, such as the socket close code; never a contract. */
  readonly detail: string | undefined

  constructor(code: import('@foreman-code/contracts/device-connection').DeviceFailureCode, detail?: string) {
    super(code)
    this.code = code
    this.detail = detail
  }
}
export interface DeviceMessageIterator extends AsyncIterator<string> {
  /** Hands the remaining stream to a synchronous reader, keeping coalesced frames out of the unread queue. */
  consume(onMessage: (text: string) => void, signal: AbortSignal): Promise<void>
}
/** Adapter must install message/error/close handlers synchronously, before returning. */
export interface DeviceSocket {
  readonly messages: { [Symbol.asyncIterator](): DeviceMessageIterator }
  readonly bufferedAmount: number
  /** Why the underlying socket ended, when it did (diagnostics only). */
  readonly closeDetail?: string | undefined
  send(frame: string): void
  close(): void
}
export function sendFrame(socket: DeviceSocket, frame: DeviceFrame) {
  const text = JSON.stringify(frame)
  if (Buffer.byteLength(text) > DEVICE_FRAME_BYTES || socket.bufferedAmount + Buffer.byteLength(text) > DEVICE_BUFFER_BYTES) throw new DeviceConnectionError('backpressure')
  socket.send(text)
}
export function readFrame(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > DEVICE_FRAME_BYTES) throw new DeviceConnectionError('malformed-frame')
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new DeviceConnectionError('malformed-frame') }
}
/** Structural ws boundary: no compression or server/listener ownership in the core. */
export interface RawDeviceSocket {
  bufferedAmount: number
  on(event: 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): void
  off(event: 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): void
  send(text: string): void
  close(): void
}
export function adaptDeviceSocket(raw: RawDeviceSocket): DeviceSocket {
  const queue: string[] = []
  let queuedBytes = 0
  let ended = false
  let failure: Error | undefined
  let terminalFailure: DeviceConnectionError | undefined
  let wake: (() => void) | undefined
  let closeDetail: string | undefined
  let consumer: ((text: string) => void) | undefined
  let onFinish: (() => void) | undefined
  const cleanup = () => { raw.off('message', message); raw.off('error', error); raw.off('close', close) }
  const finish = (cause?: Error) => { if (ended) return; ended = true; failure = cause; queue.length = 0; queuedBytes = 0; wake?.(); onFinish?.() }
  const close = (code?: unknown, reason?: unknown) => {
    closeDetail ??= `socket closed (${String(code ?? 'no code')}${reason && String(reason) ? `: ${String(reason)}` : ''})`
    finish(terminalFailure); cleanup()
  }
  const error = (cause?: unknown) => {
    closeDetail ??= `socket error: ${cause instanceof Error ? cause.message : String(cause)}`
    finish(new DeviceConnectionError('transport', closeDetail)); raw.close()
  }
  const message = (data: unknown, binary: unknown) => {
    if (ended) return
    if (binary === true || (!Buffer.isBuffer(data) && typeof data !== 'string')) { finish(new DeviceConnectionError('malformed-frame')); raw.close(); return }
    const text = String(data)
    const size = Buffer.byteLength(text)
    if (size > DEVICE_FRAME_BYTES || !consumer
      && (queue.length >= DEVICE_QUEUE_DEPTH || queuedBytes + size > DEVICE_BUFFER_BYTES)) {
      closeDetail ??= `inbound frames not read in time (${queue.length} queued, ${queuedBytes + size} bytes)`
      finish(new DeviceConnectionError('backpressure', closeDetail)); raw.close(); return
    }
    if (consumer) {
      try { consumer(text) }
      catch (cause) {
        finish(cause instanceof Error ? cause : new DeviceConnectionError('transport'))
        raw.close()
      }
      return
    }
    if (text.includes('blocked')) {
      try { const frame = JSON.parse(text) as { type?: string; code?: string }; if (frame.type === 'blocked') terminalFailure = new DeviceConnectionError(['authentication', 'revoked', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame', 'backpressure', 'timeout', 'transport'].includes(frame.code ?? '') ? frame.code as import('@foreman-code/contracts/device-connection').DeviceFailureCode : 'malformed-frame') } catch { /* ignore: parser reports malformed JSON at consumption */ }
    }
    queue.push(text); queuedBytes += Buffer.byteLength(text); wake?.()
  }
  raw.on('message', message); raw.on('error', error); raw.on('close', close)
  return {
    get bufferedAmount() { return raw.bufferedAmount },
    get closeDetail() { return closeDetail },
    send(text) { if (ended) throw new DeviceConnectionError('transport'); raw.send(text) },
    close() { closeDetail ??= 'closed by this side'; finish(); raw.close() },
    messages: { [Symbol.asyncIterator]() {
      const iterator = (async function* () {
        try {
          while (!ended) {
            if (queue.length) {
              const text = queue.shift()!
              queuedBytes -= Buffer.byteLength(text)
              yield text
              continue
            }
            await new Promise<void>((resolve) => { wake = resolve })
            wake = undefined
          }
          if (failure) throw failure
        } finally { finish(); raw.close() }
      })()
      return {
        next: () => iterator.next(),
        return: () => iterator.return(undefined),
        async consume(onMessage, signal) {
          const abort = () => finish()
          const finished = new Promise<void>(resolve => { onFinish = resolve })
          consumer = onMessage
          signal.addEventListener('abort', abort, { once: true })
          try {
            if (signal.aborted) abort()
            while (queue.length) {
              const text = queue.shift()!
              queuedBytes -= Buffer.byteLength(text)
              onMessage(text)
            }
            if (!ended) await finished
            if (failure) throw failure
          } finally {
            consumer = undefined
            onFinish = undefined
            signal.removeEventListener('abort', abort)
            finish()
            raw.close()
          }
        },
      }
    } },
  }
}
export async function nextFrame(iterator: AsyncIterator<string>, signal: AbortSignal, deadlineMs: number) {
  if (signal.aborted) throw new DeviceConnectionError('transport')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeviceConnectionError('timeout')), deadlineMs)
        abort = () => reject(new DeviceConnectionError('transport'))
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
}

export async function withDeviceDeadline<T>(operation: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  if (signal.aborted) throw new DeviceConnectionError('transport')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeviceConnectionError('timeout')), ms)
      abort = () => reject(new DeviceConnectionError('transport'))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
}
