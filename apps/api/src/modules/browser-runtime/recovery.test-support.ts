import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import { DomainError } from '../errors.js'
import { BrowserBroker } from './broker.js'
import { BrowserFileStore } from './files.js'
import { BrowserMediaService } from './media.js'
import { createBrowserSessionCleanup } from './sessionCleanup.js'
import { BrowserSessionService, type BrowserSessionAuthority } from './service.js'
import type { AgentSubject, BrowserNativeDriver, BrowserRuntimeJournal, BrowserRuntimeReceipt,
  BrowserRuntimeSessionRecord, NativeBrowserTab } from './types.js'

export function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

export interface RecoveryPrincipal { id: string; role: 'agent' | 'viewer'; readOnly?: boolean; sessionId?: string }

/** Typed private peers; canonical C0 envelopes are deliberately not reimplemented by this fixture. */
export async function runtimeRecoveryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'browser-recovery-'))
  const receipts = new Map<string, BrowserRuntimeReceipt>(), records = new Map<string, BrowserRuntimeSessionRecord>()
  const journal: BrowserRuntimeJournal = {
    read: async key => structuredClone(receipts.get(key)),
    write: async (key, value) => { receipts.set(key, structuredClone(value)) },
    saveSession: async value => { records.set(value.session.id, structuredClone(value)) },
    loadSessions: async () => structuredClone([...records.values()]),
  }
  const subject: AgentSubject = { kind: 'execution', agent: { workspaceId: 'workspace', workflowId: 'workflow',
    workflowNodeId: 'node', agentId: 'agent', productRole: 'coder', displayName: 'Fixture worker', configurationVersionId: 'configuration' },
  execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', attempt: 1 } }
  const tabs = new Map<string, NativeBrowserTab>(), screenshots = { bytes: Buffer.from('fixture screenshot') }
  const driver: BrowserNativeDriver = {
    closeProfile: vi.fn(async () => undefined), settlePopups: vi.fn(async () => undefined),
    openProfile: vi.fn(async () => ({ generation: 1 })), reconnectProfile: vi.fn(async () => ({ generation: 1 })),
    restoreTab: vi.fn(async (_profile, _generation, target) => tabs.get(target) ?? null),
    createTab: vi.fn(async () => {
      const tab = { targetId: randomUUID(), title: 'Owned fixture', url: 'about:blank' }
      tabs.set(tab.targetId, tab); return tab
    }),
    closeTab: vi.fn(async (_profile, _generation, target) => { tabs.delete(target) }),
    dispatch: vi.fn(async (_profile, _generation, target, method) => {
      if (!tabs.has(target)) throw new Error('The fixture received an unowned native target')
      return method === 'Page.captureScreenshot' ? { data: screenshots.bytes.toString('base64') } : {}
    }),
    action: vi.fn(async (action, dispatch) => dispatch('Fixture.action', { action })),
    observe: vi.fn(async () => ({ title: 'Owned fixture', url: 'about:blank', text: 'owned page', dialog: null })),
    input: vi.fn(async (_input, dispatch) => { await dispatch('Fixture.input') }),
    releasePressed: vi.fn(async dispatch => { await dispatch('Fixture.releasePressed') }),
    capture: vi.fn(async () => async () => undefined), openLocal: vi.fn(async () => undefined),
    facts: () => ({ dialog: null, uploadChooser: null }), onTabClosed: () => () => undefined, onPopup: () => () => undefined,
  }
  const reportFailure: Mock<(error: unknown) => void> = vi.fn()
  const broker: BrowserBroker = new BrowserBroker({ computerId: 'worker', driver, journal,
    closeSessionResources: sessionId => createBrowserSessionCleanup(media, files, reportFailure)(sessionId), authority: {
    resolve: async candidate => ({ subject: candidate, browser: { enabled: true, profileId: 'profile' },
      computerId: 'worker', readOnly: false, availability: 'ready' }), assertCurrent: async () => undefined,
  } })
  const authority: BrowserSessionAuthority<RecoveryPrincipal> = {
    callerId: principal => principal.id,
    subject: async () => undefined, setup: async () => undefined,
    session: async (principal, session, mutate) => {
      if (principal.sessionId && principal.sessionId !== session.id) throw new DomainError('BROWSER_SCOPE_MISMATCH', 'Another owned session.', 403)
      if (mutate && principal.readOnly) throw new DomainError('BROWSER_READ_ONLY', 'This fixture principal is read-only.', 403)
    },
    actor: async principal => principal.role,
  }
  const files: BrowserFileStore = new BrowserFileStore(join(directory, 'files'), async owner => { broker.read(owner.sessionId) })
  const media: BrowserMediaService = new BrowserMediaService(broker, reportFailure)
  const sessions = new BrowserSessionService(broker, media, files, authority)
  const prepare = async () => {
    const result = await broker.prepare({ subject, browser: { enabled: true, profileId: 'profile' },
      computerId: 'worker', commandId: 'prepare' })
    if (result.kind !== 'ready') throw new Error(`Fixture browser was unavailable: ${result.reason}`)
    return result.session
  }
  return { directory, broker, driver, journal, subject, authority, files, media, sessions, screenshots, reportFailure, prepare,
    cleanup: async () => {
      for (const session of broker.list()) await media.closeSession(session.id)
      await rm(directory, { recursive: true, force: true })
    } }
}
