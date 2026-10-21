import { randomUUID } from 'node:crypto'
import { BrowserSessionSchema, BrowserControlSchema, BrowserTabLeaseSchema } from '@foreman-code/contracts/browser-sessions'
import { browserInputHash } from '../browser-profiles/identity.js'
import { DomainError } from '../errors.js'
import type { BrowserLifecyclePort } from '../collaboration/ports.js'
import { BrowserDispatchGate } from './dispatchGate.js'
import type { AgentSubject, BrowserActor, BrowserControl, BrowserHostAction, BrowserNativeDispatch,
  BrowserNativeDriver, BrowserPageInput, BrowserPrepareResult, BrowserReleaseResult, BrowserRuntimeJournal,
  BrowserRuntimeSessionRecord, BrowserSession, BrowserSubjectAuthority, BrowserTabLease, NodeBrowserSettings } from './types.js'

interface BrowserAllocation {
  sessionId: string; tabId: string; leaseId: string; token: string; generation?: number
}

interface LiveSession {
  record: BrowserRuntimeSessionRecord
  gate: BrowserDispatchGate
  lastInput: Map<string, number>
  inputTail: Promise<void>
  dialogBarrier?: boolean
}

export interface BrowserBrokerOptions {
  computerId: string; driver: BrowserNativeDriver; journal: BrowserRuntimeJournal; authority: BrowserSubjectAuthority
  closeSessionResources?(sessionId: string): Promise<void>
  id?: () => string
}

/** One instance is the authoritative browser owner for one computer. D composes the existing host lock. */
export class BrowserBroker implements BrowserLifecyclePort {
  private readonly sessions = new Map<string, LiveSession>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly controlTails = new Map<string, Promise<unknown>>()
  private readonly commandHashes = new Map<string, string>()
  private readonly maintenanceProfiles = new Set<string>()
  private readonly allocatingProfiles = new Map<string, number>()
  private readonly listeners = new Map<string, Set<(value: ReturnType<BrowserBroker['read']>) => void>>()
  private readonly id: () => string
  private admission = true

  constructor(readonly options: BrowserBrokerOptions) {
    this.id = options.id ?? randomUUID
    options.driver.onTabClosed((profileId, generation, targetId) => {
      const owner = this.ownerForTarget(profileId, generation, targetId)
      if (!owner) return
      const live = this.requireSession(owner.sessionId)
      live.record.leases = live.record.leases.filter(value => value.targetId !== targetId)
      if (live.record.session.selectedTabId === owner.tabId) live.record.session.selectedTabId = live.record.leases[0]?.lease.tabId ?? null
      void this.persist(live).catch(() => { live.gate.fence(); live.record.session.state = 'recovering' })
    })
    options.driver.onPopup(async (profileId, generation, openerTargetId, tab) => {
      const owner = [...this.sessions.values()].find(value => value.record.session.profileId === profileId
        && value.record.session.browserGeneration === generation
        && value.record.leases.some(lease => lease.targetId === openerTargetId))
      if (!owner || owner.record.closing || owner.record.session.state === 'closed') {
        await options.driver.closeTab(profileId, generation, tab.targetId)
        return
      }
      const opener = owner.record.leases.find(value => value.targetId === openerTargetId)!
      const lease = BrowserTabLeaseSchema.parse({ id: this.id(), sessionId: owner.record.session.id,
        tabId: this.id(), browserGeneration: generation, openerTabId: opener.lease.tabId, title: tab.title, url: tab.url })
      owner.record.leases.push({ lease, targetId: tab.targetId })
      await this.persist(owner).catch(error => {
        owner.gate.fence(); owner.record.control.state = 'paused'
        owner.record.control.reason = 'Browser ownership could not be saved. Reconnect before continuing.'
        throw error
      })
    })
  }

  async recover(): Promise<void> {
    for (const record of await this.options.journal.loadSessions()) {
      BrowserSessionSchema.parse(record.session); BrowserControlSchema.parse(record.control)
      for (const value of record.leases) BrowserTabLeaseSchema.parse(value.lease)
      const live: LiveSession = { record, gate: new BrowserDispatchGate(), lastInput: new Map(), inputTail: Promise.resolve() }
      live.gate.fence()
      if (record.session.state !== 'closed') {
        record.session.state = 'recovering'; record.control.state = 'paused'; record.control.epoch++
        record.viewerDisconnected = true
        record.control.reason = 'The browser host reconnected. Check the current page before returning control.'
      } else live.gate.close()
      this.sessions.set(record.session.id, live)
      if (record.session.state !== 'closed') await this.restoreOwnedSession(live)
      await this.persist(live)
    }
  }

  accepting(): boolean { return this.admission }

  stopAdmission(): void { this.admission = false }

  resumeAdmission(): void { this.admission = true }

  private async restoreOwnedSession(live: LiveSession): Promise<void> {
    const { record } = live
    try {
      const native = await this.options.driver.reconnectProfile(record.session.profileId)
      if (!native || native.generation !== record.session.browserGeneration) {
        // A verified new process proves the old generation's leases are gone. Never adopt restored/global tabs.
        record.leases = []; record.session.state = 'closed'; record.session.selectedTabId = null
        record.control.controllingViewerId = null; record.control.reason = 'The previous browser process ended. Open a new browser session.'
        live.gate.close(); return
      }
      const restored: BrowserRuntimeSessionRecord['leases'] = []
      for (const owned of record.leases) {
        const nativeTab = await this.options.driver.restoreTab(record.session.profileId, native.generation, owned.targetId)
        if (nativeTab) restored.push({ ...owned, lease: { ...owned.lease, title: nativeTab.title, url: nativeTab.url } })
      }
      record.leases = restored
      if (!restored.some(value => value.lease.tabId === record.session.selectedTabId)) record.session.selectedTabId = restored[0]?.lease.tabId ?? null
      record.session.state = restored.length ? 'paused' : 'closed'
      if (!restored.length) record.control.controllingViewerId = null
      if (!restored.length) live.gate.close()
    } catch {
      record.session.state = 'recovering'; record.control.state = 'paused'
      record.control.reason = 'The owned browser process is unavailable. Reconnect or close this session to reconcile it.'
    }
  }

  async reconnect(input: { sessionId: string; commandId: string }): Promise<ReturnType<BrowserBroker['read']>> {
    const live = this.requireSession(input.sessionId)
    return this.command(`${input.sessionId}:reconnect:${input.commandId}`, input, markEffect => this.controlOperation(input.sessionId, async () => {
      if (live.record.session.state !== 'recovering') return this.read(input.sessionId)
      markEffect(); live.gate.fence(); live.record.control.epoch++
      await this.restoreOwnedSession(live); await this.persist(live)
      return this.read(input.sessionId)
    }))
  }

  isProfileBusy(profileId: string): boolean {
    return Boolean(this.allocatingProfiles.get(profileId)) || [...this.sessions.values()].some(value =>
      value.record.session.profileId === profileId && value.record.session.state !== 'closed')
  }

  async withProfileMaintenance<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    if (!this.admission) throw new DomainError('BROWSER_RUNTIME_DRAINING', 'Browser runtime maintenance is paused for update.', 503)
    if (this.maintenanceProfiles.has(profileId) || this.isProfileBusy(profileId)) {
      throw new DomainError('PROFILE_BUSY', 'Close this profile’s browser sessions before changing its storage.', 409)
    }
    this.maintenanceProfiles.add(profileId)
    try { return await work() } finally { this.maintenanceProfiles.delete(profileId) }
  }

  async disconnected(profileId: string, generation: number): Promise<void> {
    for (const live of this.sessions.values()) {
      if (live.record.session.profileId !== profileId || live.record.session.browserGeneration !== generation
        || live.record.session.state === 'closed') continue
      live.gate.fence(); live.record.control.epoch++; live.record.control.state = 'paused'
      live.record.control.reason = 'The browser process disconnected. Reconnect before sending more input.'
      live.record.session.state = 'recovering'; live.lastInput.clear(); await this.persist(live)
    }
  }

  private requireSession(sessionId: string): LiveSession {
    const value = this.sessions.get(sessionId)
    if (!value) throw new DomainError('BROWSER_NOT_FOUND', 'The selected browser session is unavailable.', 404)
    return value
  }

  private async persist(live: LiveSession): Promise<void> {
    await this.options.journal.saveSession(structuredClone(live.record))
    for (const receive of this.listeners.get(live.record.session.id) ?? []) receive(this.read(live.record.session.id))
  }

  subscribe(sessionId: string, receive: (value: ReturnType<BrowserBroker['read']>) => void): () => void {
    this.requireSession(sessionId)
    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(receive); this.listeners.set(sessionId, listeners)
    return () => { listeners.delete(receive); if (!listeners.size) this.listeners.delete(sessionId) }
  }

  ownerForTarget(profileId: string, generation: number, targetId: string): { sessionId: string; tabId: string; browserGeneration: number } | null {
    for (const { record } of this.sessions.values()) {
      if (record.session.profileId !== profileId || record.session.browserGeneration !== generation || record.session.state === 'closed') continue
      const owned = record.leases.find(value => value.targetId === targetId)
      if (owned) return { sessionId: record.session.id, tabId: owned.lease.tabId, browserGeneration: generation }
    }
    return null
  }

  nativeFacts(sessionId: string) {
    const { record } = this.requireSession(sessionId)
    const facts = record.session.state === 'closed' || record.session.state === 'recovering' ? [] : record.leases.map(({ lease, targetId }) =>
      ({ tabId: lease.tabId, ...this.options.driver.facts(record.session.profileId, record.session.browserGeneration, targetId) }))
    const dialog = facts.find(value => value.dialog), chooser = facts.find(value => value.uploadChooser)
    return { dialog: dialog?.dialog ? { tabId: dialog.tabId, ...dialog.dialog } : null,
      uploadChooser: chooser?.uploadChooser ? { tabId: chooser.tabId, ...chooser.uploadChooser } : null }
  }

  activeSessionCount(): number { return this.list().filter(value => value.state !== 'closed').length + this.maintenanceProfiles.size
    + [...this.allocatingProfiles.values()].reduce((a, b) => a + b, 0) }

  private serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key)
    if (previous) return previous as Promise<T>
    const promise = work().finally(() => this.pending.delete(key))
    this.pending.set(key, promise)
    return promise
  }

  private async command<T>(key: string, input: unknown, work: (markEffect: () => void) => Promise<T>): Promise<T> {
    const inputHash = browserInputHash(input), runningHash = this.commandHashes.get(key)
    if (runningHash && runningHash !== inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This browser command ID belongs to different input.', 409)
    this.commandHashes.set(key, inputHash)
    return this.serialized(`command:${key}`, async () => {
      const prior = await this.options.journal.read(key)
      if (prior) {
        if (prior.inputHash !== inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This browser command ID belongs to different input.', 409)
        if (prior.state === 'completed') return prior.value as T
        if (prior.state === 'rejected' && prior.rejection) throw new DomainError(prior.rejection.code, prior.rejection.message, prior.rejection.status)
        throw new DomainError('BROWSER_RESULT_UNKNOWN', 'This browser action may already have happened. Observe the current page before sending a new action.', 409)
      }
      await this.options.journal.write(key, { inputHash, state: 'reserved' })
      let dispatched = false
      try {
        const value = await work(() => { dispatched = true })
        await this.options.journal.write(key, { inputHash, state: 'completed', value })
        return value
      } catch (error) {
        if (!dispatched && error instanceof DomainError && error.status < 500) {
          await this.options.journal.write(key, { inputHash, state: 'rejected',
            rejection: { code: error.code, message: error.message, status: error.status } })
        } else await this.options.journal.write(key, { inputHash, state: 'unknown' })
        throw error
      }
    }).finally(() => this.commandHashes.delete(key))
  }

  private openSubjectSession(key: string): LiveSession | undefined {
    return [...this.sessions.values()].find(value => value.record.session.subject
      && browserInputHash(value.record.session.subject) === key
      && (value.record.session.state !== 'closed' || value.record.closing))
  }

  async prepare(input: { subject: AgentSubject; browser: NodeBrowserSettings; computerId: string; commandId: string }): Promise<BrowserPrepareResult> {
    if (!input.browser.enabled && input.subject.kind !== 'conversation') {
      return { kind: 'unavailable', reason: 'disabled', retryable: false }
    }
    const binding = await this.options.authority.resolve(input.subject)
    if (browserInputHash(binding.subject) !== browserInputHash(input.subject)
      || browserInputHash(binding.browser) !== browserInputHash(input.browser)
      || binding.computerId !== input.computerId || input.computerId !== this.options.computerId) {
      throw new DomainError('BROWSER_SCOPE_MISMATCH', 'The browser assignment does not match this exact saved agent and computer.', 403)
    }
    const key = browserInputHash(input.subject)
    // Queue each admission rather than coalescing different inputs into the first caller's promise.
    return this.controlOperation(`prepare:${key}`, async () => {
      if (!binding.browser.enabled) {
        const existing = this.openSubjectSession(key)
        if (existing && (await this.closeOwned(existing)).state === 'pending') {
          return { kind: 'unavailable', reason: 'profile_busy', retryable: true }
        }
        return { kind: 'unavailable', reason: 'disabled', retryable: false }
      }
      const preparationKey = `preparation:${key}:${input.commandId}`
      const preparationHash = browserInputHash({ ...input, readOnly: binding.readOnly })
      const preparation = await this.options.journal.read(preparationKey)
      if (preparation && preparation.inputHash !== preparationHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This preparation command belongs to a different saved assignment.', 409)
      if (!preparation) await this.options.journal.write(preparationKey, { inputHash: preparationHash, state: 'reserved' })
      if (binding.availability !== 'ready') return { kind: 'unavailable', reason: binding.availability, retryable: true }
      await this.options.authority.assertCurrent(input.subject)
      if (!this.admission) return { kind: 'unavailable', reason: 'runtime_missing', retryable: true }
      const completed = [...this.sessions.values()].find(value => value.record.session.subject
        && browserInputHash(value.record.session.subject) === key && value.record.prepareCommandId === input.commandId)
      if (completed?.record.session.state === 'closed') return { kind: 'unavailable', reason: 'profile_busy', retryable: false }
      const existing = completed ?? this.openSubjectSession(key)
      if (existing) {
        if (existing.record.session.profileId !== input.browser.profileId || existing.record.readOnly !== binding.readOnly) {
          if (input.subject.kind !== 'conversation') throw new DomainError('BROWSER_SCOPE_MISMATCH',
            'Close the previous saved browser assignment before preparing this subject with a different profile or access mode.', 409)
          if ((await this.closeOwned(existing)).state === 'pending') {
            return { kind: 'unavailable', reason: 'profile_busy', retryable: true }
          }
        } else {
          if (existing.record.closing || !['ready', 'paused'].includes(existing.record.session.state)) {
            return { kind: 'unavailable', reason: 'profile_busy', retryable: true }
          }
          return { kind: 'ready', session: structuredClone(existing.record.session), control: structuredClone(existing.record.control) }
        }
      }
      if (!input.browser.profileId) return { kind: 'unavailable', reason: 'profile_missing', retryable: false }
      const live = await this.allocate(input.browser.profileId, input.commandId, binding.readOnly, input.subject)
      try { await this.options.authority.assertCurrent(input.subject) } catch (error) {
        await this.closeOwned(live); throw error
      }
      return { kind: 'ready', session: structuredClone(live.record.session), control: structuredClone(live.record.control) }
    })
  }

  async openSetup(profileId: string, commandId: string): Promise<BrowserSession> {
    return this.serialized(`setup:${profileId}`, async () => {
      if (!this.admission) throw new DomainError('BROWSER_RUNTIME_DRAINING', 'Browser runtime is updating.', 409)
      const previous = [...this.sessions.values()].find(value => value.record.session.setupForProfileId === profileId
        && value.record.prepareCommandId === commandId)
      if (previous?.record.session.state === 'closed') throw new DomainError('BROWSER_CLOSED', 'This setup request already completed and closed. Start a new explicit setup request.', 409)
      const existing = previous ?? [...this.sessions.values()].find(value => value.record.session.setupForProfileId === profileId
        && value.record.session.state !== 'closed')
      if (existing && (existing.record.closing || !['ready', 'paused'].includes(existing.record.session.state))) {
        throw new DomainError('PROFILE_BUSY', 'The existing setup session needs recovery or closure.', 409)
      }
      return structuredClone((existing ?? await this.allocate(profileId, commandId, false)).record.session)
    })
  }

  private async allocate(profileId: string, commandId: string, readOnly: boolean, subject?: AgentSubject): Promise<LiveSession> {
    return this.controlOperation(`profile:${profileId}`, async () => {
    if (this.maintenanceProfiles.has(profileId)) throw new DomainError('PROFILE_BUSY', 'This profile is being maintained.', 409)
    this.allocatingProfiles.set(profileId, (this.allocatingProfiles.get(profileId) ?? 0) + 1)
    try { return await this.allocateNative(profileId, commandId, readOnly, subject) } finally {
      const remaining = (this.allocatingProfiles.get(profileId) ?? 1) - 1
      if (remaining) this.allocatingProfiles.set(profileId, remaining); else this.allocatingProfiles.delete(profileId)
      if (!this.isProfileBusy(profileId)) await this.options.driver.closeProfile(profileId)
    }
    })
  }

  private retireIdleProfile(profileId: string): Promise<void> {
    return this.controlOperation(`profile:${profileId}`, async () => {
      if (this.isProfileBusy(profileId) || this.maintenanceProfiles.has(profileId)) return
      this.maintenanceProfiles.add(profileId)
      try { await this.options.driver.closeProfile(profileId) }
      finally { this.maintenanceProfiles.delete(profileId) }
    })
  }

  private async allocateNative(profileId: string, commandId: string, readOnly: boolean, subject?: AgentSubject): Promise<LiveSession> {
    const allocationKey = `allocation:${subject ? browserInputHash(subject) : `setup:${profileId}`}:${commandId}`
    const inputHash = browserInputHash({ profileId, computerId: this.options.computerId, readOnly, subject: subject ?? null, commandId })
    const previous = await this.options.journal.read(allocationKey)
    if (previous && previous.inputHash !== inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This preparation command belongs to a different browser assignment.', 409)
    const allocation: BrowserAllocation = previous?.value as BrowserAllocation | undefined
      ?? { sessionId: this.id(), tabId: this.id(), leaseId: this.id(), token: this.id() }
    const saved = this.sessions.get(allocation.sessionId)
    if (saved) return saved
    if (previous?.state === 'completed') throw new DomainError('BROWSER_ALLOCATION_RECOVERY', 'The prepared session must be reconciled from its durable ownership journal.', 503)
    // The exact subject/command/profile/computer admission exists durably before a process or target is allocated.
    await this.options.journal.write(allocationKey, { inputHash, state: 'reserved', value: allocation })
    if (subject) await this.options.authority.assertCurrent(subject)
    const native = await this.options.driver.openProfile(profileId)
    if (!Number.isSafeInteger(native.generation) || native.generation < 1) throw new DomainError('BROWSER_GENERATION_INVALID', 'Browser generation was not allocated.', 503)
    if (allocation.generation !== undefined && allocation.generation !== native.generation) {
      throw new DomainError('BROWSER_ALLOCATION_ENDED', 'The original browser preparation process ended; a new explicit request is required.', 409)
    }
    allocation.generation = native.generation
    await this.options.journal.write(allocationKey, { inputHash, state: 'reserved', value: allocation })
    if (subject) await this.options.authority.assertCurrent(subject)
    const tab = await this.options.driver.createTab(profileId, native.generation, allocation.token)
    const { sessionId: id, tabId } = allocation
    const session = BrowserSessionSchema.parse({ id, ...(subject ? { subject } : { setupForProfileId: profileId }),
      profileId, computerId: this.options.computerId, browserGeneration: native.generation, state: 'ready', selectedTabId: tabId })
    const control: BrowserControl = { sessionId: id, state: subject ? 'agent' : 'paused', epoch: 0,
      controllingViewerId: null, reason: subject ? null : 'Browser ready for you — click to continue.' }
    const lease: BrowserTabLease = { id: allocation.leaseId, sessionId: id, tabId, browserGeneration: native.generation, title: tab.title, url: tab.url }
    const live: LiveSession = { record: { session, control, readOnly, prepareCommandId: commandId, closing: false,
      leases: [{ lease, targetId: tab.targetId }] }, gate: new BrowserDispatchGate(), lastInput: new Map(), inputTail: Promise.resolve() }
    if (!subject) live.gate.fence()
    try { await this.persist(live) } catch (error) {
      await this.options.driver.closeTab(profileId, native.generation, tab.targetId); throw error
    }
    this.sessions.set(id, live)
    await this.options.journal.write(allocationKey, { inputHash, state: 'completed', value: allocation })
    return live
  }

  read(sessionId: string): { session: BrowserSession; control: BrowserControl; tabs: BrowserTabLease[] } {
    const { record } = this.requireSession(sessionId)
    return structuredClone({ session: record.session, control: record.control, tabs: record.leases.map(value => value.lease) })
  }

  list(subject?: AgentSubject): BrowserSession[] {
    return [...this.sessions.values()].map(value => value.record.session)
      .filter(session => !subject || session.subject && browserInputHash(session.subject) === browserInputHash(subject)).map(value => structuredClone(value))
  }

  private lease(live: LiveSession, tabId: string, generation: number) {
    if (live.record.session.browserGeneration !== generation) throw new DomainError('BROWSER_STALE_GENERATION', 'This browser generation is no longer current.', 409)
    const lease = live.record.leases.find(value => value.lease.tabId === tabId && value.lease.browserGeneration === generation)
    if (!lease) throw new DomainError('BROWSER_TAB_SCOPE', 'This tab does not belong to the selected browser session.', 403)
    return lease
  }

  private assertActor(live: LiveSession, actor: BrowserActor): void {
    const control = live.record.control
    if (live.record.closing || live.record.session.state === 'closed') throw new DomainError('BROWSER_CLOSED', 'The browser session is closing.', 409)
    if (actor.browserGeneration !== live.record.session.browserGeneration || actor.epoch !== control.epoch) {
      throw new DomainError('BROWSER_STALE_INPUT', 'Browser control changed. Refresh before sending input.', 409)
    }
    if (actor.kind === 'agent' && control.state !== 'agent'
      || actor.kind === 'viewer' && (control.state !== 'user' || control.controllingViewerId !== actor.viewerId)) {
      throw new DomainError('BROWSER_CONTROL_REQUIRED', 'This caller does not currently control the browser.', 409)
    }
  }

  checkedDispatch(sessionId: string, tabId: string, actor: BrowserActor, onDispatch?: () => void): BrowserNativeDispatch {
    const live = this.requireSession(sessionId)
    return async (method, params = {}) => {
      if (live.record.session.subject) await this.options.authority.assertCurrent(live.record.session.subject)
      const owned = this.lease(live, tabId, actor.browserGeneration)
      return live.gate.dispatch(actor.kind === 'agent', () => this.assertActor(live, actor), () => {
        if (live.dialogBarrier && method !== 'Page.handleJavaScriptDialog' && method !== 'Foreman.dialog') {
          throw new DomainError('BROWSER_DIALOG_REQUIRED', 'Resolve the active JavaScript dialog before sending page input.', 409)
        }
        onDispatch?.()
        return this.options.driver.dispatch(live.record.session.profileId, actor.browserGeneration, owned.targetId, method, params)
      }, tabId)
    }
  }

  async action(input: { sessionId: string; tabId: string; actor: BrowserActor; commandId: string; action: BrowserHostAction }): Promise<{ state: 'completed'; result: unknown }> {
    const live = this.requireSession(input.sessionId)
    if (live.record.readOnly && input.actor.kind === 'agent') throw new DomainError('READ_ONLY', 'This agent can observe the browser but cannot change it.', 403)
    if (live.record.session.subject) await this.options.authority.assertCurrent(live.record.session.subject)
    return this.command(`${input.sessionId}:action:${input.commandId}`, input, async markEffect => {
      if (input.actor.kind === 'agent') await live.gate.waitForAgent()
      this.assertActor(live, input.actor); this.lease(live, input.tabId, input.actor.browserGeneration)
      const dispatch = this.checkedDispatch(input.sessionId, input.tabId, input.actor, markEffect)
      const result = await this.options.driver.action(input.action, dispatch)
      if (input.action.kind === 'dialog' && live.dialogBarrier) {
        if (!await live.gate.settle()) {
          live.record.control.state = 'paused'; live.record.control.reason = 'The dialog closed; the interrupted browser action is still settling.'
          await this.persist(live)
        } else {
          for (const { lease } of live.record.leases) await this.options.driver.releasePressed(this.transitionDispatch(live, lease.tabId, input.actor.epoch))
          live.dialogBarrier = false; live.record.control.reason = null; await this.persist(live)
        }
      }
      return { state: 'completed' as const, result }
    })
  }

  private controlOperation<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const before = this.controlTails.get(sessionId) ?? Promise.resolve()
    const task = before.then(work, work)
    this.controlTails.set(sessionId, task)
    void task.finally(() => { if (this.controlTails.get(sessionId) === task) this.controlTails.delete(sessionId) })
      .catch(() => { /* ignore: the returned task carries the control failure to the caller. */ })
    return task
  }

  async acquire(input: { sessionId: string; viewerId: string; browserGeneration: number; commandId: string }): Promise<BrowserControl> {
    const live = this.requireSession(input.sessionId)
    if (input.browserGeneration !== live.record.session.browserGeneration) throw new DomainError('BROWSER_STALE_GENERATION', 'Refresh the browser view.', 409)
    return this.command(`${input.sessionId}:acquire:${input.commandId}`, input, markEffect => this.controlOperation(input.sessionId, async () => {
      const control = live.record.control
      if (live.record.closing || live.record.session.state === 'closed') throw new DomainError('BROWSER_CLOSED', 'The browser session is closing.', 409)
      if (control.controllingViewerId && control.controllingViewerId !== input.viewerId && !live.record.viewerDisconnected) {
        throw new DomainError('BROWSER_CONTROL_BUSY', 'Another viewer controls this browser.', 409)
      }
      if (control.state === 'user') return structuredClone(control)
      markEffect(); live.gate.fence()
      live.record.viewerDisconnected = false
      control.epoch++; control.state = 'quiescing'; control.controllingViewerId = input.viewerId; control.reason = null
      const transitionEpoch = control.epoch
      await this.persist(live)
      const dialogTabs = new Set(live.record.leases.filter(({ targetId }) =>
        this.options.driver.facts(live.record.session.profileId, live.record.session.browserGeneration, targetId).dialog).map(value => value.lease.tabId))
      if (control.epoch !== transitionEpoch || live.record.closing) return structuredClone(control)
      if (live.gate.atDialogBoundary(dialogTabs)) {
        // The admitted command is stopped by this exact tab's modal. Only its dialog response is admitted
        // until the old command settles and pressed state is released; the old helper cannot continue.
        live.dialogBarrier = true; control.state = 'user'; control.reason = 'Resolve the current dialog to continue.'
        live.record.session.state = 'ready'; live.lastInput.clear()
      } else if (!await live.gate.settle()) {
        if (control.epoch === transitionEpoch && !live.record.closing) {
          control.state = 'paused'; control.reason = 'An in-flight browser action has not settled.'
        }
      } else {
        for (const { lease } of live.record.leases) {
          await this.options.driver.releasePressed(this.transitionDispatch(live, lease.tabId, transitionEpoch))
        }
        if (control.epoch === transitionEpoch && !live.record.closing) {
          live.dialogBarrier = false; control.state = 'user'; live.record.session.state = 'ready'; live.lastInput.clear()
        }
      }
      await this.persist(live)
      return structuredClone(control)
    }))
  }

  async input(input: { sessionId: string; tabId: string; actor: BrowserActor; firstSequence: number; gestures: readonly BrowserPageInput[] }): Promise<void> {
    const live = this.requireSession(input.sessionId)
    if (input.actor.kind !== 'viewer') throw new DomainError('READ_ONLY', 'Page input is not available to this caller.', 403)
    const run = async () => {
      this.assertActor(live, input.actor); this.lease(live, input.tabId, input.actor.browserGeneration)
      if (!Number.isSafeInteger(input.firstSequence) || input.firstSequence < 1 || input.gestures.length > 256) {
        throw new DomainError('BROWSER_INPUT_SEQUENCE', 'Invalid browser input sequence.', 400)
      }
      const viewer = input.actor.viewerId!, previous = live.lastInput.get(viewer) ?? 0
      if (input.firstSequence !== previous + 1) throw new DomainError('BROWSER_INPUT_SEQUENCE', 'Browser input arrived out of order. Refresh control.', 409)
      for (const [index, gesture] of input.gestures.entries()) {
        // Reserve before dispatch: a lost response never replays a key or pointer action.
        live.lastInput.set(viewer, input.firstSequence + index)
        await this.options.driver.input(gesture, this.checkedDispatch(input.sessionId, input.tabId, input.actor))
      }
    }
    const pending = live.inputTail.then(run)
    live.inputTail = pending.catch(() => { /* ignore: return the input failure; later requests still get an ordered admission check. */ })
    return pending
  }

  async releaseControl(input: { sessionId: string; viewerId: string; epoch: number; commandId: string }): Promise<BrowserControl> {
    const live = this.requireSession(input.sessionId)
    return this.command(`${input.sessionId}:release-control:${input.commandId}`, input, markEffect => this.controlOperation(input.sessionId, async () => {
      const control = live.record.control
      if (control.controllingViewerId !== input.viewerId || control.epoch !== input.epoch) {
        throw new DomainError('BROWSER_STALE_INPUT', 'This viewer no longer owns the browser.', 409)
      }
      if (live.record.closing) return structuredClone(control)
      markEffect(); live.gate.fence()
      control.state = 'resuming'; control.epoch++
      const transitionEpoch = control.epoch
      await this.persist(live)
      await live.inputTail
      if (!await live.gate.settle()) {
        if (control.epoch === transitionEpoch && !live.record.closing) {
          control.state = 'paused'; control.reason = 'Browser input is still settling.'
        }
        await this.persist(live); return structuredClone(control)
      }
      try {
        for (const { lease } of live.record.leases) {
          const dispatch = this.transitionDispatch(live, lease.tabId, transitionEpoch)
          await this.options.driver.releasePressed(dispatch)
          await dispatch('Foreman.resumeManagedDialogs')
          const observed = await this.options.driver.observe(dispatch)
          lease.title = observed.title; lease.url = observed.url
        }
        if (control.epoch !== transitionEpoch || live.record.closing) return structuredClone(control)
        control.state = live.record.session.subject ? 'agent' : 'paused'; control.controllingViewerId = null
        control.reason = live.record.session.subject ? null : 'Browser ready for you — click to continue.'
        live.record.session.state = 'ready'; live.lastInput.clear(); await this.persist(live)
        if (live.record.session.subject) live.gate.open()
      } catch {
        if (control.epoch === transitionEpoch && !live.record.closing) {
          control.state = 'paused'; control.reason = 'Could not refresh the browser state. Reconnect before returning control.'
        }
        await this.persist(live)
      }
      return structuredClone(control)
    }))
  }

  private transitionDispatch(live: LiveSession, tabId: string, epoch: number): BrowserNativeDispatch {
    return async (method, params = {}) => {
      if (live.record.control.epoch !== epoch || live.record.closing) {
        throw new DomainError('BROWSER_STALE_INPUT', 'Browser control changed during this transition.', 409)
      }
      const owned = this.lease(live, tabId, live.record.session.browserGeneration)
      return this.options.driver.dispatch(live.record.session.profileId, live.record.session.browserGeneration, owned.targetId, method, params)
    }
  }

  async pause(input: { sessionId: string; viewerId: string; epoch: number; commandId: string }): Promise<BrowserControl> {
    const live = this.requireSession(input.sessionId)
    return this.command(`${input.sessionId}:pause:${input.commandId}`, input, async markEffect => {
      if (live.record.control.controllingViewerId !== input.viewerId || live.record.control.epoch !== input.epoch) {
        throw new DomainError('BROWSER_STALE_INPUT', 'This viewer no longer owns the browser.', 409)
      }
      markEffect(); await this.disconnectViewer(input.sessionId, input.viewerId)
      return structuredClone(live.record.control)
    })
  }

  async disconnectViewer(sessionId: string, viewerId: string): Promise<void> {
    const live = this.requireSession(sessionId)
    if (live.record.control.controllingViewerId !== viewerId) return
    live.gate.fence(); live.record.control.epoch++; live.record.control.state = 'paused'
    live.record.viewerDisconnected = true
    live.record.control.reason = 'The controlling viewer disconnected. Browser actions are paused.'
    live.record.session.state = 'paused'; live.lastInput.clear(); await this.persist(live)
    const epoch = live.record.control.epoch
    if (await live.gate.settle()) {
      try {
        for (const { lease } of live.record.leases) await this.options.driver.releasePressed(this.transitionDispatch(live, lease.tabId, epoch))
      } catch { /* ignore: pause remains fenced and a later takeover must reconcile pressed state before acknowledgement. */ }
    }
  }

  async screenshot(input: { sessionId: string; tabId: string; actor: BrowserActor }) {
    const live = this.requireSession(input.sessionId)
    if (input.actor.kind === 'agent') await live.gate.waitForAgent()
    const owned = this.lease(live, input.tabId, input.actor.browserGeneration)
    const result = input.actor.kind === 'agent'
      ? await this.checkedDispatch(input.sessionId, input.tabId, input.actor)('Page.captureScreenshot', { format: 'png' })
      : await live.gate.dispatch(false, () => {
        this.lease(live, input.tabId, input.actor.browserGeneration)
        if (live.record.closing || live.record.session.state === 'closed') throw new DomainError('BROWSER_CLOSED', 'This browser session is closed.', 409)
      }, () => this.options.driver.dispatch(live.record.session.profileId, input.actor.browserGeneration, owned.targetId, 'Page.captureScreenshot', { format: 'png' }), input.tabId)
    const data = result && typeof result === 'object' && 'data' in result && typeof result.data === 'string' ? Buffer.from(result.data, 'base64') : null
    if (!data || data.byteLength > 2 * 1024 * 1024) throw new DomainError('BROWSER_SCREENSHOT_BOUND', 'The browser screenshot exceeds its bounded response. Open a view instead.', 413)
    return { sessionId: input.sessionId, tabId: input.tabId, browserGeneration: input.actor.browserGeneration, mimeType: 'image/png' as const, bytes: data }
  }

  assertFileWrite(sessionId: string, kind: BrowserActor['kind']): void {
    const live = this.requireSession(sessionId)
    if (live.record.closing || live.record.session.state === 'closed') throw new DomainError('BROWSER_CLOSED', 'The browser session is closing.', 409)
    if (kind === 'agent' && live.record.readOnly) throw new DomainError('READ_ONLY', 'This agent cannot change browser files.', 403)
  }

  async releasePressed(input: { sessionId: string; actor: BrowserActor }): Promise<void> {
    const live = this.requireSession(input.sessionId)
    this.assertActor(live, input.actor)
    for (const { lease } of live.record.leases) await this.options.driver.releasePressed(this.checkedDispatch(input.sessionId, lease.tabId, input.actor))
  }

  async attachFile(input: { sessionId: string; tabId: string; actor: BrowserActor; commandId: string; fileId: string; selector: string },
    attach: (apply: (privatePath: string) => Promise<void>) => Promise<unknown>) {
    const live = this.requireSession(input.sessionId)
    if (live.record.readOnly && input.actor.kind === 'agent') throw new DomainError('READ_ONLY', 'This agent cannot attach files.', 403)
    if (live.record.session.subject) await this.options.authority.assertCurrent(live.record.session.subject)
    return this.command(`${input.sessionId}:file-attach:${input.commandId}`, input, async markEffect => {
      if (input.actor.kind === 'agent') await live.gate.waitForAgent()
      this.assertActor(live, input.actor); this.lease(live, input.tabId, input.actor.browserGeneration)
      const dispatch = this.checkedDispatch(input.sessionId, input.tabId, input.actor, markEffect)
      return attach(async privatePath => {
        const node = await dispatch('Foreman.chooserNode', { selector: input.selector }) as { backendNodeId: number }
        await dispatch('DOM.setFileInputFiles', { backendNodeId: node.backendNodeId, files: [privatePath] })
      })
    })
  }

  async observe(input: { sessionId: string; tabId: string; actor: BrowserActor }) {
    const live = this.requireSession(input.sessionId)
    if (input.actor.kind === 'agent') {
      await live.gate.waitForAgent()
      return this.options.driver.observe(this.checkedDispatch(input.sessionId, input.tabId, input.actor))
    }
    const owned = this.lease(live, input.tabId, input.actor.browserGeneration)
    return this.options.driver.observe((method, params = {}) => live.gate.dispatch(false, () => {
      this.lease(live, input.tabId, input.actor.browserGeneration)
      if (live.record.closing) throw new DomainError('BROWSER_CLOSED', 'The browser session is closing.', 409)
    }, () => this.options.driver.dispatch(live.record.session.profileId, input.actor.browserGeneration, owned.targetId, method, params)))
  }

  async createTab(input: { sessionId: string; actor: BrowserActor; commandId: string }) {
    const live = this.requireSession(input.sessionId)
    if (live.record.readOnly && input.actor.kind === 'agent') throw new DomainError('READ_ONLY', 'This agent cannot create browser tabs.', 403)
    if (live.record.session.subject) await this.options.authority.assertCurrent(live.record.session.subject)
    const created = await this.command(`${input.sessionId}:tab-create:${input.commandId}`, input, async markEffect => {
      const tab = await live.gate.dispatch(input.actor.kind === 'agent', () => this.assertActor(live, input.actor),
        () => { markEffect(); return this.options.driver.createTab(live.record.session.profileId, input.actor.browserGeneration) })
      const lease: BrowserTabLease = { id: this.id(), sessionId: input.sessionId, tabId: this.id(),
        browserGeneration: input.actor.browserGeneration, title: tab.title, url: tab.url }
      live.record.leases.push({ lease, targetId: tab.targetId })
      if (input.actor.kind === 'agent' || live.record.session.selectedTabId === null) live.record.session.selectedTabId = lease.tabId
      await this.persist(live); return { tabId: lease.tabId }
    })
    return { ...this.read(input.sessionId), createdTabId: created.tabId }
  }

  async selectTab(input: { sessionId: string; tabId: string; actor: BrowserActor; commandId: string }) {
    const live = this.requireSession(input.sessionId)
    if (live.record.session.subject) await this.options.authority.assertCurrent(live.record.session.subject)
    return this.command(`${input.sessionId}:tab-select:${input.commandId}`, input, async markEffect => {
      this.lease(live, input.tabId, input.actor.browserGeneration)
      this.assertActor(live, input.actor)
      // Viewer selection belongs to the URL and never changes the agent's logical selected tab.
      if (input.actor.kind === 'agent' && live.record.session.selectedTabId !== input.tabId) {
        markEffect(); live.record.session.selectedTabId = input.tabId; await this.persist(live)
      }
      return this.read(input.sessionId)
    })
  }

  async closeTab(input: { sessionId: string; tabId: string; actor: BrowserActor; commandId: string }) {
    const live = this.requireSession(input.sessionId)
    if (live.record.readOnly && input.actor.kind === 'agent') throw new DomainError('READ_ONLY', 'This agent cannot close browser tabs.', 403)
    if (live.record.session.subject) await this.options.authority.assertCurrent(live.record.session.subject)
    await this.command(`${input.sessionId}:tab-close:${input.commandId}`, input, async markEffect => {
      const owned = this.lease(live, input.tabId, input.actor.browserGeneration)
      await live.gate.dispatch(input.actor.kind === 'agent', () => this.assertActor(live, input.actor),
        () => { markEffect(); return this.options.driver.closeTab(live.record.session.profileId, input.actor.browserGeneration, owned.targetId) })
      live.record.leases = live.record.leases.filter(value => value.lease.tabId !== input.tabId)
      if (live.record.session.selectedTabId === input.tabId) live.record.session.selectedTabId = live.record.leases[0]?.lease.tabId ?? null
      await this.persist(live); return { state: 'closed' }
    })
    return this.read(input.sessionId)
  }

  async openLocal(input: { sessionId: string; tabId: string; actor: BrowserActor; commandId: string }): Promise<BrowserControl> {
    const live = this.requireSession(input.sessionId)
    return this.command(`${input.sessionId}:native-window:${input.commandId}`, input, markEffect => this.controlOperation(input.sessionId, async () => {
      this.assertActor(live, input.actor)
      const owned = this.lease(live, input.tabId, input.actor.browserGeneration)
      if (input.actor.kind !== 'viewer') throw new DomainError('BROWSER_CONTROL_REQUIRED', 'Take control before opening this computer’s browser window.', 409)
      markEffect()
      await this.options.driver.openLocal(live.record.session.profileId, input.actor.browserGeneration, owned.targetId)
      await this.disconnectViewer(input.sessionId, input.actor.viewerId!)
      live.record.control.reason = 'Continue on this computer. Return control explicitly when finished.'
      await this.persist(live)
      return structuredClone(live.record.control)
    }))
  }

  async capture(sessionId: string, tabId: string, generation: number,
    frame: Parameters<BrowserNativeDriver['capture']>[3]): Promise<() => Promise<void>> {
    const live = this.requireSession(sessionId), owned = this.lease(live, tabId, generation)
    if (live.record.session.state === 'closed') throw new DomainError('BROWSER_CLOSED', 'This browser is no longer live.', 409)
    return this.options.driver.capture(live.record.session.profileId, generation, owned.targetId, value => {
      if (!live.record.closing && live.record.session.browserGeneration === generation) frame(value)
    })
  }

  async retireCapture(sessionId: string, tabId: string, generation: number): Promise<void> {
    const live = this.requireSession(sessionId)
    const owned = live.record.leases.find(value => value.lease.tabId === tabId && value.lease.browserGeneration === generation)
    if (!owned || live.record.session.browserGeneration !== generation) return
    const native = await this.options.driver.reconnectProfile(live.record.session.profileId)
    if (!native || native.generation !== generation) return
    if (await this.options.driver.restoreTab(live.record.session.profileId, generation, owned.targetId)) {
      await this.options.driver.dispatch(live.record.session.profileId, generation, owned.targetId, 'Foreman.stopCapture', {})
    }
  }

  async release(input: { sessionId: string; subject: AgentSubject; commandId: string;
    reason: 'terminal' | 'stop' | 'conversation_closed' | 'runtime_update' }): Promise<BrowserReleaseResult> {
    const live = this.requireSession(input.sessionId)
    if (!live.record.session.subject || browserInputHash(live.record.session.subject) !== browserInputHash(input.subject)) {
      throw new DomainError('BROWSER_SCOPE_MISMATCH', 'This browser belongs to another agent subject.', 403)
    }
    return this.closeOwned(live)
  }

  closeSetup(sessionId: string): Promise<BrowserReleaseResult> {
    const live = this.requireSession(sessionId)
    if (!live.record.session.setupForProfileId) throw new DomainError('BROWSER_SCOPE_MISMATCH', 'This is not a profile setup session.', 403)
    return this.closeOwned(live)
  }

  private async closeOwned(live: LiveSession): Promise<BrowserReleaseResult> {
    const sessionId = live.record.session.id
    if (live.record.session.state === 'recovering') { await this.restoreOwnedSession(live); await this.persist(live) }
    if (live.record.session.state === 'closed') {
      try {
        await this.options.closeSessionResources?.(sessionId)
        await this.retireIdleProfile(live.record.session.profileId)
      } catch {
        return { sessionId, state: 'pending', reason: 'Browser media or file cleanup is not yet confirmed.' }
      }
      live.record.closing = false
      await this.persist(live)
      return { sessionId, state: 'already_closed', reason: null }
    }
    live.record.closing = true; live.gate.fence(); live.record.control.epoch++
    live.record.control.state = 'paused'; live.record.control.reason = 'Closing browser session.'
    await this.persist(live)
    if (!await live.gate.settle()) return { sessionId, state: 'pending', reason: 'Waiting for browser actions to settle.' }
    try { await this.options.closeSessionResources?.(sessionId) } catch {
      return { sessionId, state: 'pending', reason: 'Browser media or file cleanup is not yet confirmed.' }
    }
    for (const { lease, targetId } of [...live.record.leases]) {
      try {
        await this.options.driver.settlePopups(live.record.session.profileId, live.record.session.browserGeneration)
        await this.options.driver.closeTab(live.record.session.profileId, live.record.session.browserGeneration, targetId)
        await this.options.driver.settlePopups(live.record.session.profileId, live.record.session.browserGeneration)
      } catch {
        return { sessionId, state: 'pending', reason: 'Native tab closure is not yet confirmed.' }
      }
      live.record.leases = live.record.leases.filter(value => value.lease.id !== lease.id)
      await this.persist(live)
    }
    live.record.session.state = 'closed'; live.record.session.selectedTabId = null
    live.record.control.controllingViewerId = null
    live.record.control.reason = 'Browser session closed.'
    live.gate.close()
    await this.persist(live)
    try { await this.retireIdleProfile(live.record.session.profileId) }
    catch { return { sessionId, state: 'pending', reason: 'Idle browser process closure is not yet confirmed.' } }
    live.record.closing = false
    await this.persist(live)
    return { sessionId, state: 'closed', reason: null }
  }
}
