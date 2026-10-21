import { browserAccessDenied, browserErrorMessage, browserRequestUncertain } from './errors'
import { ownsTab } from './identity'
import type { BrowserControl, BrowserControllerSnapshot, BrowserSessionRead, BrowserTabLease,
  BrowserUiPort, BrowserViewConnection, PageFrame, PageGesture } from './types'

type PendingGesture = { gesture: PageGesture; width: number; height: number; viewportOffsetTop: number; bytes: number }
const computerInputs = new Map<string, Promise<void>>()
const inputSequences = new Map<string, { epoch: number; next: number }>()

/** Serializes only browser input, never control, media or the Run Stop path. */
async function serialInput(computerId: string, input: () => Promise<void>): Promise<void> {
  const prior = computerInputs.get(computerId)
  const next = (prior ?? Promise.resolve()).then(input, input)
  computerInputs.set(computerId, next)
  try { await next } finally { if (computerInputs.get(computerId) === next) computerInputs.delete(computerId) }
}

/** Ephemeral view/input admission. Durable session data stays in Query/the host. */
export class BrowserController {
  private readonly listeners = new Set<() => void>()
  private snapshot: BrowserControllerSnapshot
  private view: BrowserViewConnection | undefined
  private viewAbort = new AbortController()
  private inputAbort = new AbortController()
  private queue: PendingGesture[] = []
  private queuedBytes = 0
  private flushing = false
  private taking: Promise<BrowserControl> | undefined
  private acquireCommand: string | undefined
  private releaseCommand: string | undefined
  private operation = 0
  private closed = false
  private deliberateClose = false
  private active = false
  private lossLatched = false
  private pausing: Promise<void> | undefined
  private pauseCommand: string | undefined
  private pauseEpoch: number | undefined
  private pauseFailed = false

  constructor(private readonly port: BrowserUiPort, readonly initial: BrowserSessionRead,
    readonly tab: BrowserTabLease, readonly viewerId: string, private readonly onDenied: () => void) {
    if (!ownsTab(initial.session, tab) || initial.control.sessionId !== initial.session.id) {
      throw new Error('The selected browser tab no longer belongs to this session.')
    }
    this.snapshot = { notice: initial.control.state === 'paused' || initial.control.state === 'recovering'
      ? 'paused' : 'watching', control: initial.control, error: null, frame: null,
      stale: true, pendingInputs: 0 }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): BrowserControllerSnapshot => this.snapshot

  private publish(patch: Partial<BrowserControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  async start(): Promise<void> {
    if (this.closed || this.active || this.snapshot.notice === 'denied') return
    this.active = true
    const signal = this.viewAbort.signal
    try {
      const connection = await this.port.openView(this.initial.session, this.tab, this.viewerId, {
        frame: frame => { if (!signal.aborted) this.receiveFrame(frame) },
        control: control => { if (!signal.aborted) this.receiveControl(control) },
        disconnected: error => { if (!signal.aborted) this.pause(error) },
      }, signal)
      if (signal.aborted || this.closed) await connection.close()
      else this.view = connection
    } catch (error) { if (!signal.aborted) this.pause(error) }
  }

  private receiveFrame(frame: PageFrame): void {
    if (this.closed || this.lossLatched || this.snapshot.notice === 'denied' || frame.sessionId !== this.initial.session.id
      || frame.browserGeneration !== this.initial.session.browserGeneration || frame.tabId !== this.tab.tabId
      || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0
      || frame.sequence <= (this.snapshot.frame?.sequence ?? -1)) return
    if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0
      || !Number.isFinite(frame.viewportOffsetTop ?? 0) || (frame.viewportOffsetTop ?? 0) < 0 || (frame.viewportOffsetTop ?? 0) >= frame.height
      || frame.image.size > 2 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(frame.image.type)) {
      this.pause(new Error('The browser sent an unsupported or oversized image. Reconnect the view.'))
      return
    }
    this.publish({ frame, stale: false })
  }

  private receiveControl(control: BrowserControl): void {
    if (this.closed || this.snapshot.notice === 'denied' || control.sessionId !== this.initial.session.id
      || control.epoch < this.snapshot.control.epoch) return
    const changed = control.epoch !== this.snapshot.control.epoch
    if (this.lossLatched) { this.publish({ control, notice: 'paused', stale: true }); return }
    const pendingTakeover = this.snapshot.notice === 'taking' && ['quiescing', 'user'].includes(control.state)
      && (control.controllingViewerId === null || control.controllingViewerId === this.viewerId)
    if (changed && !pendingTakeover) this.clearInput()
    this.publish({ control, notice: control.state === 'user' && control.controllingViewerId === this.viewerId
      ? 'user' : control.state === 'quiescing' ? 'taking' : control.state === 'resuming' ? 'returning'
        : control.state === 'paused' || control.state === 'recovering' ? 'paused' : 'watching' })
  }

  async acquire(): Promise<BrowserControl> {
    if (this.closed || this.snapshot.notice === 'denied' || !this.active || this.snapshot.stale) {
      throw new Error('Reconnect the browser view before taking control.')
    }
    const current = this.snapshot.control
    if (current.state === 'user' && current.controllingViewerId === this.viewerId && this.snapshot.notice === 'user') return current
    if (current.state === 'user' && current.controllingViewerId !== this.viewerId) {
      throw new Error('Another viewer has control. You can keep watching.')
    }
    if (this.taking) return this.taking
    const operation = this.operation
    this.acquireCommand ??= crypto.randomUUID()
    this.publish({ notice: 'taking', error: null })
    const request = this.take(operation, this.acquireCommand)
    this.taking = request
    try { return await request } finally { if (this.taking === request) this.taking = undefined }
  }

  private async take(operation: number, commandId: string): Promise<BrowserControl> {
    try {
      const control = await this.port.acquire(this.initial.session, this.viewerId, commandId)
      this.validateControl(control)
      if (operation !== this.operation || this.closed) {
        if (this.deliberateClose && control.state === 'user' && control.controllingViewerId === this.viewerId) {
          const released = await this.port.release(this.initial.session, this.viewerId, control.epoch, crypto.randomUUID())
          if (!this.closed) this.receiveControl(released)
          return released
        }
        if (control.state === 'user' && control.controllingViewerId === this.viewerId) {
          const paused = await this.port.pause(this.initial.session, this.viewerId, control.epoch, crypto.randomUUID())
          this.snapshot = { ...this.snapshot, control: paused }
        }
        throw new Error('The browser selection changed before control was granted. The opening input was discarded.')
      }
      this.publish({ control })
      if (control.state !== 'user' || control.controllingViewerId !== this.viewerId) {
        this.publish({ notice: 'paused', error: 'Control is not confirmed. Reconnect before sending input.' })
        throw new Error('User control has not been confirmed by the computer.')
      }
      this.acquireCommand = undefined
      this.publish({ notice: 'user', error: null })
      return control
    } catch (error) {
      if (!browserRequestUncertain(error)) this.acquireCommand = undefined
      if (!this.closed) {
        if (browserRequestUncertain(error) || browserAccessDenied(error)) this.pause(error)
        else { this.clearInput(); this.publish({ notice: 'watching', error: browserErrorMessage(error) }) }
      }
      throw error
    }
  }

  private validateControl(control: BrowserControl): void {
    if (control.sessionId !== this.initial.session.id || control.epoch < this.snapshot.control.epoch) {
      throw new Error('The computer returned control for a different or older browser session.')
    }
  }

  /** The exact initial gesture is held until the host confirms user control. */
  async send(gesture: PageGesture): Promise<void> {
    const frame = this.snapshot.frame
    if (!frame || this.snapshot.stale || this.closed || this.snapshot.notice === 'denied') return
    const bytes = new TextEncoder().encode(JSON.stringify(gesture)).byteLength
    if (this.queue.length >= 128 || this.queuedBytes + bytes > 32768 || bytes > 16384) {
      this.pause(new Error('Input paused — connection is catching up. Reconnect before continuing.'))
      return
    }
    this.queue.push({ gesture, width: frame.width, height: frame.height, viewportOffsetTop: frame.viewportOffsetTop ?? 0, bytes })
    this.queuedBytes += bytes
    this.publish({ pendingInputs: this.queue.length })
    try {
      const taking = this.snapshot.notice !== 'user'
      await this.acquire()
      if (taking && this.queue.some(item => item.width !== this.snapshot.frame?.width || item.height !== this.snapshot.frame?.height
        || item.viewportOffsetTop !== (this.snapshot.frame?.viewportOffsetTop ?? 0))) {
        this.clearInput()
        this.publish({ error: 'The page changed while taking control. Click the page again.' })
        return
      }
      await this.flush()
    } catch (error) {
      if (!this.closed && (browserRequestUncertain(error) || browserAccessDenied(error))) this.pause(error)
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length && !this.closed && this.snapshot.notice === 'user') {
        const batch: PendingGesture[] = []
        let bytes = 0
        while (this.queue.length && batch.length < 64 && bytes + this.queue[0]!.bytes <= 16384) {
          const next = this.queue.shift()!
          batch.push(next); bytes += next.bytes
        }
        this.queuedBytes -= bytes
        const signal = this.inputAbort.signal, epoch = this.snapshot.control.epoch
        this.publish({ pendingInputs: this.queue.length })
        await serialInput(this.initial.session.computerId, async () => {
          if (signal.aborted || this.closed || epoch !== this.snapshot.control.epoch || this.snapshot.notice !== 'user') return
          const key = `${encodeURIComponent(this.viewerId)}:${encodeURIComponent(this.initial.session.id)}:${this.initial.session.browserGeneration}`
          const retained = inputSequences.get(key)
          const sequence = retained?.epoch === epoch ? retained.next : 1
          inputSequences.set(key, { epoch, next: sequence + batch.length })
          await this.port.input(this.initial.session, this.tab, this.viewerId, epoch, sequence,
            batch.map(item => item.gesture), signal)
        })
      }
    } finally { this.flushing = false }
  }

  private clearInput(): void {
    this.queue = []; this.queuedBytes = 0
    this.inputAbort.abort(); this.inputAbort = new AbortController()
    this.publish({ pendingInputs: 0 })
  }

  /** OS blur/loss never releases ownership to an agent. */
  pause(error: unknown): void {
    if (this.closed || this.snapshot.notice === 'denied') return
    this.operation += 1
    this.lossLatched = true
    this.clearInput()
    const denied = browserAccessDenied(error)
    this.publish({ notice: denied ? 'denied' : 'paused', stale: true,
      error: browserErrorMessage(error), ...(denied ? { frame: null } : {}) })
    if (denied) { this.viewAbort.abort(); this.onDenied() }
    if (!denied && this.snapshot.control.controllingViewerId === this.viewerId && !this.pausing) {
      this.pauseCommand ??= crypto.randomUUID()
      this.pauseEpoch ??= this.snapshot.control.epoch
      this.pausing = this.port.pause(this.initial.session, this.viewerId, this.pauseEpoch, this.pauseCommand)
        .then(control => { this.validateControl(control); this.snapshot = { ...this.snapshot, control } })
        .catch(failure => { this.pauseFailed = true; if (!this.closed) this.publish({ error: browserErrorMessage(failure) }) })
    }
  }

  private async settlePause(): Promise<void> {
    if (this.pausing) await this.pausing
    if (this.pauseFailed && this.pauseCommand && this.pauseEpoch !== undefined) {
      const control = await this.port.pause(this.initial.session, this.viewerId, this.pauseEpoch, this.pauseCommand)
      this.validateControl(control); this.snapshot = { ...this.snapshot, control }; this.pauseFailed = false
    }
  }

  async release(): Promise<void> {
    if (this.closed || this.snapshot.notice === 'denied') return
    if (!this.taking && this.snapshot.control.controllingViewerId !== this.viewerId) return
    this.operation += 1
    this.deliberateClose = true
    this.clearInput()
    this.publish({ notice: 'returning', error: null })
    try {
      if (this.taking) await this.taking
      await this.settlePause()
      const control = this.snapshot.control
      if (control.controllingViewerId !== this.viewerId) {
        this.publish({ notice: 'watching' }); return
      }
      this.releaseCommand ??= crypto.randomUUID()
      const released = await this.port.release(this.initial.session, this.viewerId, control.epoch, this.releaseCommand)
      this.validateControl(released)
      this.releaseCommand = undefined
      this.lossLatched = false
      this.pausing = undefined; this.pauseCommand = undefined; this.pauseEpoch = undefined; this.pauseFailed = false
      this.receiveControl(released)
      if (released.state !== 'agent' && this.initial.session.subject) {
        this.publish({ notice: 'paused', error: released.reason ?? 'Return of control is not confirmed.' })
      }
    } catch (error) { if (!this.closed) this.pause(error) }
  }

  async close(deliberate = true): Promise<void> {
    if (this.closed) return
    this.deliberateClose = deliberate
    this.operation += 1
    this.active = false
    this.clearInput()
    this.closed = true
    this.publish({ notice: 'closed', frame: null })
    let failure: unknown
    try {
      if (this.taking) await this.taking
      await this.settlePause()
      const control = this.snapshot.control
      if (deliberate && control.controllingViewerId === this.viewerId) {
        await this.port.release(this.initial.session, this.viewerId, control.epoch, crypto.randomUUID())
      } else await this.port.releasePressed(this.initial.session, this.viewerId, control.epoch)
    } catch (error) { failure = error }
    this.viewAbort.abort()
    try { await this.view?.close() } catch (error) { failure ??= error }
    if (deliberate) inputSequences.delete(`${encodeURIComponent(this.viewerId)}:${encodeURIComponent(this.initial.session.id)}:${this.initial.session.browserGeneration}`)
    if (failure) throw failure
  }
}
