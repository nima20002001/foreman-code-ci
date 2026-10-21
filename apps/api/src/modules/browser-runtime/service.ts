import { DomainError } from '../errors.js'
import { browserInputHash } from '../browser-profiles/identity.js'
import type { BrowserBroker } from './broker.js'
import type { BrowserMediaService } from './media.js'
import type { BrowserFileStore, BrowserFileOwner } from './files.js'
import type { AgentSubject, BrowserSession, BrowserActor } from './types.js'

/** Existing principal/credential owners implement this at D composition; it must reauthorize every call. */
export interface BrowserSessionAuthority<Principal> {
  callerId(principal: Principal): string
  subject(principal: Principal, subject: AgentSubject, mutate: boolean): Promise<void>
  setup(principal: Principal, profileId: string, computerId: string, mutate: boolean): Promise<void>
  session(principal: Principal, session: BrowserSession, mutate: boolean): Promise<void>
  actor(principal: Principal, session: BrowserSession): Promise<'agent' | 'viewer'>
}

export type BrowserFileAction =
  | ({ intent: 'file'; phase: 'begin'; commandId: string; name: string; mimeType: string; byteLength: number } & BrowserFileOwner)
  | { intent: 'file'; phase: 'write'; sessionId: string; fileId: string; offset: number; bytes: Uint8Array }
  | { [Phase in 'finish' | 'cancel' | 'remove' | 'metadata']: {
    intent: 'file'; phase: Phase; sessionId: string; fileId: string; commandId?: string
  } }['finish' | 'cancel' | 'remove' | 'metadata']
  | { intent: 'file'; phase: 'read'; sessionId: string; fileId: string; offset: number; length: number }
  | ({ intent: 'file'; phase: 'attach' } & Parameters<BrowserBroker['attachFile']>[0])
export type BrowserSessionListInput = { subject?: AgentSubject; setupForProfileId?: string; computerId?: string; cursor?: string | undefined; limit?: number }

/** The same authenticated service is consumed by HTTP, Operator MCP and exact scoped agent adapters. */
export class BrowserSessionService<Principal> {
  private readonly viewerClaims = new Map<string, Promise<void>>()
  constructor(readonly broker: BrowserBroker, readonly media: BrowserMediaService,
    readonly files: BrowserFileStore, readonly authority: BrowserSessionAuthority<Principal>) {}

  async authorize(principal: Principal, sessionId: string, mutate: boolean) {
    const result = this.broker.read(sessionId)
    await this.authority.session(principal, result.session, mutate)
    return result
  }

  private claimViewer(principal: Principal, sessionId: string, viewerId: string): Promise<void> {
    if (!viewerId || viewerId.length > 200) throw new DomainError('BROWSER_VIEW_SCOPE', 'A valid viewer identity is required.', 400)
    const key = `viewer:${sessionId}:${viewerId}`, ownerId = this.authority.callerId(principal), hash = browserInputHash(ownerId)
    const previous = this.viewerClaims.get(key) ?? Promise.resolve()
    const task = previous.then(async () => {
      const claim = await this.broker.options.journal.read(key)
      if (claim && claim.inputHash !== hash) throw new DomainError('BROWSER_VIEW_SCOPE', 'This viewer belongs to another authenticated caller.', 403)
      if (!claim) await this.broker.options.journal.write(key, { inputHash: hash, state: 'completed' })
    }, async () => {
      const claim = await this.broker.options.journal.read(key)
      if (!claim || claim.inputHash !== hash) throw new DomainError('BROWSER_VIEW_SCOPE', 'This viewer belongs to another authenticated caller.', 403)
    })
    this.viewerClaims.set(key, task)
    return task
  }

  private async actor(principal: Principal, sessionId: string, actor: BrowserActor, mutate: boolean): Promise<void> {
    const { session } = await this.authorize(principal, sessionId, mutate)
    if (await this.authority.actor(principal, session) !== actor.kind) {
      throw new DomainError('BROWSER_ACTOR_SCOPE', 'This actor does not match the authenticated caller.', 403)
    }
    if (actor.kind === 'viewer') await this.claimViewer(principal, sessionId, actor.viewerId ?? '')
  }

  async list(principal: Principal, input: BrowserSessionListInput = {}) {
    if (input.subject) await this.authority.subject(principal, input.subject, false)
    if (input.setupForProfileId && input.computerId) await this.authority.setup(principal, input.setupForProfileId, input.computerId, false)
    const limit = Math.max(1, Math.min(100, input.limit ?? 100))
    if (!Number.isSafeInteger(limit)) throw new DomainError('BROWSER_PAGE_INVALID', 'Invalid browser session page size.', 400)
    const visible: BrowserSession[] = [], candidates = this.broker.list(input.subject)
      .filter(value => (!input.setupForProfileId || value.setupForProfileId === input.setupForProfileId)
        && (!input.computerId || value.computerId === input.computerId) && (!input.cursor || value.id > input.cursor)).sort((a, b) => a.id.localeCompare(b.id))
    for (const session of candidates) {
      try { await this.authority.session(principal, session, false); visible.push(session) } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 403) throw error
      }
      if (visible.length > limit) break
    }
    return { sessions: visible.slice(0, limit), nextCursor: visible.length > limit ? visible[limit - 1]!.id : null }
  }

  async get(principal: Principal, sessionId: string) {
    const read = await this.authorize(principal, sessionId, false)
    return { ...read, ...this.broker.nativeFacts(sessionId), files: await this.files.list(sessionId) }
  }

  async reconnect(principal: Principal, input: Parameters<BrowserBroker['reconnect']>[0]) {
    await this.authorize(principal, input.sessionId, true)
    await this.broker.reconnect(input)
    return this.get(principal, input.sessionId)
  }

  async open(principal: Principal, input: Parameters<BrowserBroker['prepare']>[0] | {
    profileId: string; computerId: string; commandId: string
  }) {
    if ('subject' in input) {
      await this.authority.subject(principal, input.subject, true)
      return this.broker.prepare(input)
    }
    await this.authority.setup(principal, input.profileId, input.computerId, true)
    if (input.computerId !== this.broker.options.computerId) throw new DomainError('BROWSER_COMPUTER_SCOPE', 'Route this setup to its selected computer.', 409)
    const session = await this.broker.openSetup(input.profileId, input.commandId)
    return { kind: 'ready' as const, ...this.broker.read(session.id) }
  }

  async close(principal: Principal, input: { sessionId: string; commandId: string }) {
    const { session } = await this.authorize(principal, input.sessionId, true)
    await this.media.closeSession(input.sessionId)
    const result = session.subject ? await this.broker.release({ ...input, subject: session.subject, reason: 'conversation_closed' })
      : await this.broker.closeSetup(input.sessionId)
    if (result.state !== 'pending') await this.files.closeSession(input.sessionId)
    return result
  }

  async action(principal: Principal, input: Parameters<BrowserBroker['action']>[0]) {
    await this.actor(principal, input.sessionId, input.actor, true)
    return this.broker.action(input)
  }

  async authorizeUpload(principal: Principal, sessionId: string, fileId: string): Promise<void> {
    const { session } = await this.authorize(principal, sessionId, true)
    this.broker.assertFileWrite(sessionId, await this.authority.actor(principal, session))
    await this.files.metadata(fileId, sessionId)
  }

  async perform(principal: Principal, input: ({ intent?: 'action' } & Parameters<BrowserBroker['action']>[0]) | BrowserFileAction) {
    if (input.intent !== 'file') return this.action(principal, input)
    const mutating = !['read', 'metadata'].includes(input.phase)
    const { session } = await this.authorize(principal, input.sessionId, mutating)
    const kind = await this.authority.actor(principal, session)
    if (mutating) this.broker.assertFileWrite(input.sessionId, kind)
    if (input.phase === 'begin') return this.files.begin(input)
    if (input.phase === 'write') return this.files.write(input)
    if (input.phase === 'finish') return this.files.finish(input.fileId, input.sessionId)
    if (input.phase === 'metadata') return this.files.metadata(input.fileId, input.sessionId)
    if (input.phase === 'read') return this.files.read(input.fileId, input.sessionId, input.offset, input.length)
    if (input.phase === 'cancel' || input.phase === 'remove') return this.files.cancel(input.fileId, input.sessionId)
    await this.actor(principal, input.sessionId, input.actor, true)
    return this.broker.attachFile(input, apply => this.files.attach(input.fileId, { sessionId: input.sessionId, tabId: input.tabId,
      browserGeneration: input.actor.browserGeneration }, input.commandId, apply))
  }

  async screenshot(principal: Principal, input: Parameters<BrowserBroker['screenshot']>[0]) {
    await this.actor(principal, input.sessionId, input.actor, false)
    return this.broker.screenshot(input)
  }

  async observe(principal: Principal, input: Parameters<BrowserBroker['observe']>[0]) {
    await this.actor(principal, input.sessionId, input.actor, false)
    return this.broker.observe(input)
  }

  async tabs(principal: Principal, sessionId: string) { return (await this.authorize(principal, sessionId, false)).tabs }

  async tab(principal: Principal, operation: 'create' | 'select' | 'close', input: {
    sessionId: string; tabId?: string; actor: BrowserActor; commandId: string
  }) {
    await this.actor(principal, input.sessionId, input.actor, operation !== 'select' || input.actor.kind === 'agent')
    if (operation === 'create') {
      const created = await this.broker.createTab(input)
      return { ...await this.get(principal, input.sessionId), createdTabId: created.createdTabId }
    }
    if (!input.tabId) throw new DomainError('BROWSER_TAB_REQUIRED', 'Select an owned browser tab.', 400)
    if (operation === 'select') {
      await this.broker.selectTab({ ...input, tabId: input.tabId })
      return this.get(principal, input.sessionId)
    }
    await this.broker.closeTab({ ...input, tabId: input.tabId })
    await this.media.closeTab(input.sessionId, input.tabId)
    return this.get(principal, input.sessionId)
  }

  async acquire(principal: Principal, input: Parameters<BrowserBroker['acquire']>[0]) {
    const { session } = await this.authorize(principal, input.sessionId, true)
    if (await this.authority.actor(principal, session) !== 'viewer') throw new DomainError('BROWSER_ACTOR_SCOPE', 'Only authenticated viewers may take interactive control.', 403)
    await this.claimViewer(principal, input.sessionId, input.viewerId)
    return this.broker.acquire(input)
  }

  async release(principal: Principal, input: Parameters<BrowserBroker['releaseControl']>[0]) {
    const { session } = await this.authorize(principal, input.sessionId, true)
    if (await this.authority.actor(principal, session) !== 'viewer') throw new DomainError('BROWSER_ACTOR_SCOPE', 'Only the authenticated viewer may release interactive control.', 403)
    await this.claimViewer(principal, input.sessionId, input.viewerId)
    return this.broker.releaseControl(input)
  }

  async pause(principal: Principal, input: Parameters<BrowserBroker['pause']>[0]) {
    const { session } = await this.authorize(principal, input.sessionId, true)
    if (await this.authority.actor(principal, session) !== 'viewer') throw new DomainError('BROWSER_ACTOR_SCOPE', 'Only authenticated viewers may pause interactive control.', 403)
    await this.claimViewer(principal, input.sessionId, input.viewerId)
    return this.broker.pause(input)
  }

  async input(principal: Principal, input: ({ intent?: 'gestures' } & Parameters<BrowserBroker['input']>[0])
    | ({ intent: 'release_pressed' } & Parameters<BrowserBroker['releasePressed']>[0])) {
    await this.actor(principal, input.sessionId, input.actor, true)
    return input.intent === 'release_pressed' ? this.broker.releasePressed(input) : this.broker.input(input)
  }

  async viewOpen(principal: Principal, input: Omit<Parameters<BrowserMediaService['open']>[0], 'ownerId'>) {
    const { session } = await this.authorize(principal, input.sessionId, false)
    if (await this.authority.actor(principal, session) !== 'viewer') throw new DomainError('BROWSER_ACTOR_SCOPE', 'Agent observations use the owned state and screenshot tools.', 403)
    await this.claimViewer(principal, input.sessionId, input.viewerId)
    return this.media.open({ ...input, ownerId: this.authority.callerId(principal) })
  }

  async viewRead(principal: Principal, input: { viewId: string; after?: number }) {
    const ownerId = this.authority.callerId(principal), view = this.media.describe(input.viewId, ownerId)
    await this.authorize(principal, view.sessionId, false)
    return this.media.read(input.viewId, ownerId, input.after)
  }

  async viewClose(principal: Principal, viewId: string) {
    const ownerId = this.authority.callerId(principal)
    let view
    try { view = this.media.describe(viewId, ownerId, true) } catch (error) {
      if (error instanceof DomainError && error.code === 'BROWSER_VIEW_CLOSED') return { closed: true }
      throw error
    }
    await this.authorize(principal, view.sessionId, false)
    await this.media.close(viewId, ownerId)
    return { closed: true }
  }

  async openLocal(principal: Principal, input: Parameters<BrowserBroker['openLocal']>[0]) {
    await this.actor(principal, input.sessionId, input.actor, true)
    return this.broker.openLocal(input)
  }
}

export type BrowserSessionPort<Principal> = Pick<BrowserSessionService<Principal>,
  'authorizeUpload' | 'open' | 'list' | 'get' | 'reconnect' | 'close' | 'action' | 'perform' | 'observe' | 'screenshot' | 'tabs' | 'tab'
  | 'acquire' | 'release' | 'pause' | 'input' | 'viewOpen' | 'viewRead' | 'viewClose' | 'openLocal'>
