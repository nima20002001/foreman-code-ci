import type { ServerResponse } from 'node:http'

/** write(false) has accepted the frame. Only later frames wait for drain. */
export function createSseWriter(
  response: Pick<ServerResponse, 'write' | 'once' | 'removeListener' | 'destroyed' | 'writableEnded'>,
  allowed: () => boolean,
  onStopped: () => void,
  limits = { frameBytes: 8 * 1024 * 1024, queuedBytes: 256 * 1024, queuedFrames: 128, drainTimeoutMs: 15_000 },
) {
  const queue: { frame: string; bytes: number }[] = []
  let queuedBytes = 0
  let blocked = false
  let closed = false
  let timer: NodeJS.Timeout | undefined
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    response.removeListener('drain', drain)
    queue.length = 0
    queuedBytes = 0
  }
  const stop = () => { if (!closed) { close(); onStopped() } }
  const ready = () => {
    if (closed) return false
    if (response.destroyed || response.writableEnded || !allowed()) { stop(); return false }
    return true
  }
  const send = (frame: string) => {
    if (!ready()) return
    try {
      if (!response.write(frame)) {
        blocked = true
        response.once('drain', drain)
        timer = setTimeout(stop, limits.drainTimeoutMs)
        timer.unref()
      }
    } catch { stop() }
  }
  function drain() {
    clearTimeout(timer)
    timer = undefined
    blocked = false
    while (ready() && !blocked && queue.length) {
      const next = queue.shift()!
      queuedBytes -= next.bytes
      send(next.frame)
    }
  }
  return {
    write(frame: string) {
      if (!ready()) return
      const bytes = Buffer.byteLength(frame)
      if (bytes > limits.frameBytes) { stop(); return }
      if (!blocked) { send(frame); return }
      if (queue.length >= limits.queuedFrames || queuedBytes + bytes > limits.queuedBytes) { stop(); return }
      queue.push({ frame, bytes })
      queuedBytes += bytes
    },
    close,
  }
}
