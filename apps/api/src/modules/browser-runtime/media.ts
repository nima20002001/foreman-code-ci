import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors.js'
import { browserInputHash } from '../browser-profiles/identity.js'
import type { BrowserBroker } from './broker.js'
import type { BrowserHostFrame, BrowserRuntimeView } from './types.js'

interface Viewer {
  descriptor: BrowserRuntimeView; ownerId: string; viewerId: string
  latest: (BrowserHostFrame & { sequence: number }) | null
  stop: () => Promise<void>; closed: boolean; sequence: number; lastFrameAt: number
  listeners: Set<() => void>
  receiptKey: string; inputHash: string; idleTimer?: ReturnType<typeof setTimeout>; closing?: Promise<void>
  capture?: Promise<() => Promise<void>>
}
interface ViewReceipt { descriptor: BrowserRuntimeView; closed: boolean }
interface ViewOpenInput { ownerId: string; viewerId: string; sessionId: string; tabId: string; browserGeneration: number; commandId?: string }

/** Dedicated browser media: one replaceable frame per viewer, independent of ordinary device RPC slots. */
export class BrowserMediaService {
  private readonly viewers = new Map<string, Viewer>()
  private readonly openings = new Map<string, { hash: string; task: Promise<BrowserRuntimeView> }>()
  constructor(private readonly broker: BrowserBroker, private readonly reportFailure: (error: unknown) => void = () => {
    process.emitWarning('A browser view could not finish its private capture cleanup.')
  }) {}

  open(input: ViewOpenInput): Promise<BrowserRuntimeView> {
    const commandId = input.commandId ?? randomUUID(), receiptKey = `view:${browserInputHash(input.ownerId)}:${commandId}`
    const inputHash = browserInputHash({ ...input, commandId }), pending = this.openings.get(receiptKey)
    if (pending) {
      if (pending.hash !== inputHash) return Promise.reject(new DomainError('COMMAND_ID_CONFLICT', 'This view command belongs to a different target.', 409))
      return pending.task
    }
    const task = this.allocate(input, receiptKey, inputHash).finally(() => {
      if (this.openings.get(receiptKey)?.task === task) this.openings.delete(receiptKey)
    })
    this.openings.set(receiptKey, { hash: inputHash, task }); return task
  }

  private async allocate(input: ViewOpenInput, receiptKey: string, inputHash: string): Promise<BrowserRuntimeView> {
    const previous = await this.broker.options.journal.read(receiptKey)
    if (previous) {
      if (previous.inputHash !== inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This view command belongs to a different target.', 409)
      const receipt = previous.value as ViewReceipt
      if (receipt?.descriptor && !receipt.closed && this.viewers.has(receipt.descriptor.id)) return this.describe(receipt.descriptor.id, input.ownerId)
      throw new DomainError('BROWSER_VIEW_CLOSED', 'The original view has ended. Open a new view with a new command.', 409)
    }
    const id = randomUUID(), descriptor: BrowserRuntimeView = { id, sessionId: input.sessionId,
      tabId: input.tabId, browserGeneration: input.browserGeneration }
    const viewer: Viewer = { descriptor, ownerId: input.ownerId, viewerId: input.viewerId, latest: null,
      stop: () => this.broker.retireCapture(input.sessionId, input.tabId, input.browserGeneration),
      closed: false, sequence: 0, lastFrameAt: 0, listeners: new Set(), receiptKey, inputHash }
    await this.broker.options.journal.write(receiptKey, { inputHash, state: 'reserved', value: { descriptor, closed: false } satisfies ViewReceipt })
    this.viewers.set(id, viewer)
    try {
      viewer.capture = this.broker.capture(input.sessionId, input.tabId, input.browserGeneration, frame => {
        if (frame.data.byteLength > 2 * 1024 * 1024 || viewer.closed || performance.now() - viewer.lastFrameAt < 100) return
        viewer.lastFrameAt = performance.now()
        viewer.latest = { ...frame, sequence: ++viewer.sequence }
        for (const listener of viewer.listeners) listener()
      })
      viewer.stop = await viewer.capture
      if (viewer.closed) throw new DomainError('BROWSER_VIEW_CLOSED', 'The view ended while its capture was opening.', 409)
      await this.broker.options.journal.write(receiptKey, { inputHash, state: 'completed', value: { descriptor, closed: false } satisfies ViewReceipt })
      this.retireUnobserved(viewer)
      return descriptor
    } catch (error) { await this.close(id, input.ownerId); throw error }
  }

  private retireUnobserved(viewer: Viewer): void {
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer)
    if (viewer.closed || viewer.listeners.size) return
    // A lost HTTP acknowledgement or detached viewer must not leave hidden capture running indefinitely.
    viewer.idleTimer = setTimeout(() => { void this.close(viewer.descriptor.id, viewer.ownerId, true).catch(this.reportFailure) }, 30_000)
    viewer.idleTimer.unref?.()
  }

  private owned(id: string, ownerId: string, closing = false): Viewer {
    const viewer = this.viewers.get(id)
    if (!viewer || viewer.closed && !closing) throw new DomainError('BROWSER_VIEW_CLOSED', 'This browser view is closed.', 404)
    if (viewer.ownerId !== ownerId) throw new DomainError('BROWSER_VIEW_SCOPE', 'This viewer belongs to another caller.', 403)
    return viewer
  }

  describe(id: string, ownerId: string, closing = false): BrowserRuntimeView { return structuredClone(this.owned(id, ownerId, closing).descriptor) }

  read(id: string, ownerId: string, after = 0): { view: BrowserRuntimeView; frame: (BrowserHostFrame & { sequence: number }) | null } {
    const viewer = this.owned(id, ownerId)
    this.retireUnobserved(viewer)
    if (!Number.isSafeInteger(after) || after < 0) throw new DomainError('INVALID_CURSOR', 'Invalid browser frame cursor.', 400)
    const { session, tabs } = this.broker.read(viewer.descriptor.sessionId)
    if (session.browserGeneration !== viewer.descriptor.browserGeneration || session.state === 'closed'
      || !tabs.some(tab => tab.tabId === viewer.descriptor.tabId && tab.browserGeneration === viewer.descriptor.browserGeneration)) {
      throw new DomainError('BROWSER_STALE_GENERATION', 'This browser view no longer has a live target.', 409)
    }
    return { view: structuredClone(viewer.descriptor), frame: viewer.latest && viewer.latest.sequence > after ? viewer.latest : null }
  }

  subscribe(id: string, ownerId: string, listener: () => void): () => void {
    const viewer = this.owned(id, ownerId)
    this.read(id, ownerId)
    viewer.listeners.add(listener)
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer)
    return () => { viewer.listeners.delete(listener); this.retireUnobserved(viewer) }
  }

  async close(id: string, ownerId: string, disconnected = false): Promise<void> {
    const viewer = this.viewers.get(id)
    if (!viewer) return
    if (viewer.ownerId !== ownerId) throw new DomainError('BROWSER_VIEW_SCOPE', 'This viewer belongs to another caller.', 403)
    if (viewer.closing) return viewer.closing
    viewer.closed = true; viewer.latest = null
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer)
    const task = (async () => {
      await this.broker.options.journal.write(viewer.receiptKey, { inputHash: viewer.inputHash, state: 'completed',
        value: { descriptor: viewer.descriptor, closed: true } satisfies ViewReceipt })
      for (const listener of viewer.listeners) listener()
      viewer.listeners.clear()
      try {
        if (viewer.capture) {
          try { viewer.stop = await viewer.capture } catch (error) { this.reportFailure(error) }
        }
        await viewer.stop(); this.viewers.delete(id)
      } finally {
        if (disconnected) await this.broker.disconnectViewer(viewer.descriptor.sessionId, viewer.viewerId)
      }
    })().finally(() => { if (viewer.closing === task) delete viewer.closing })
    viewer.closing = task; return task
  }

  async closeTab(sessionId: string, tabId: string): Promise<void> {
    for (const [id, viewer] of this.viewers) if (viewer.descriptor.sessionId === sessionId && viewer.descriptor.tabId === tabId) await this.close(id, viewer.ownerId)
  }

  async closeSession(sessionId: string): Promise<void> {
    for (const [id, viewer] of this.viewers) if (viewer.descriptor.sessionId === sessionId) await this.close(id, viewer.ownerId)
  }
}
