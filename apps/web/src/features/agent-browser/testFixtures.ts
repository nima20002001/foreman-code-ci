import { vi } from 'vitest'
import type { AgentSubject, BrowserControl, BrowserSessionRead, BrowserUiPort, BrowserViewObserver, PageFrame } from './types'
import type { BrowserFilesPort, BrowserFileLabel } from './transferTypes'

export const subject: AgentSubject = { kind: 'execution', agent: { workspaceId: 'workspace', workflowId: 'workflow',
  workflowNodeId: 'node', agentId: 'agent', productRole: 'coder', displayName: 'Builder', configurationVersionId: 'configuration' },
execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', attempt: 1 } }

export function browserRead(id = 'session'): BrowserSessionRead {
  return { session: { id, subject, profileId: 'profile', computerId: 'main', browserGeneration: 1, state: 'ready', selectedTabId: 'tab' },
    control: { sessionId: id, state: 'agent', epoch: 0, controllingViewerId: null, reason: null },
    tabs: [{ id: 'lease', sessionId: id, tabId: 'tab', browserGeneration: 1, title: 'Fixture page', url: 'https://fixture.test/' }],
    uploadChooser: null, files: [], dialog: null }
}

export function frame(id = 'session', tabId = 'tab', sequence = 0): PageFrame {
  return { sessionId: id, tabId, browserGeneration: 1, sequence, width: 1280, height: 800,
    capturedAt: '2026-10-20T00:00:00.000Z', image: new Blob(['fixture image'], { type: 'image/png' }) }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function browserPortFake(initial = browserRead()) {
  let read = structuredClone(initial)
  let observer: BrowserViewObserver | undefined
  let control: BrowserControl = read.control
  const closeView = vi.fn(async () => undefined)
  const port: BrowserUiPort = {
    prepare: vi.fn(async () => ({ kind: 'ready' as const, session: read.session, control })),
    listSessions: vi.fn(async () => [read.session]), readSession: vi.fn(async () => ({ ...read, control })),
    reconnect: vi.fn(async () => ({ ...read, control })),
    listSetupSessions: vi.fn(async () => [read.session]),
    acquire: vi.fn(async (_session, viewerId) => { control = { ...control, epoch: control.epoch + 1, state: 'user', controllingViewerId: viewerId }; return control }),
    release: vi.fn(async () => { control = { ...control, epoch: control.epoch + 1, state: 'agent', controllingViewerId: null }; return control }),
    pause: vi.fn(async () => { control = { ...control, epoch: control.epoch + 1, state: 'paused' }; return control }),
    openView: vi.fn(async (_session, _tab, _viewer, value) => { observer = value; return { close: closeView } }),
    input: vi.fn(async () => undefined), releasePressed: vi.fn(async () => undefined),
    selectTab: vi.fn(async () => ({ ...read, control })), createTab: vi.fn(async () => ({ ...read, control, createdTabId: read.tabs[0]!.tabId })),
    closeTab: vi.fn(async () => ({ ...read, control })), navigate: vi.fn(async () => ({ ...read, control })),
    respondDialog: vi.fn(async () => ({ ...read, control, dialog: null })),
    openLocalBrowser: vi.fn(async () => control), closeSession: vi.fn(async () => 'closed' as const),
  }
  return { port, closeView, get observer() { return observer },
    setRead(value: BrowserSessionRead) { read = value; control = value.control } }
}

export function browserFilesFake(): BrowserFilesPort {
  const value: BrowserFileLabel = { id: 'file', name: 'download.txt', mimeType: 'text/plain', byteLength: 3,
    receivedBytes: 3, state: 'ready', purpose: 'download' }
  return { begin: vi.fn(async () => value), write: vi.fn(async () => undefined), finish: vi.fn(async () => value),
    attach: vi.fn(async () => ({ ...value, state: 'attached' as const })),
    cancel: vi.fn(async () => ({ ...value, state: 'canceled' as const })),
    read: vi.fn(async () => new Uint8Array([1, 2, 3])), remove: vi.fn(async () => undefined) }
}
