import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { newNextDraft, nextDraftKey } from './state'
import { storeEditSnapshot, readEditSnapshot, editSnapshotAcknowledged } from './editIntentStorage'
import { nextDraftApi } from './transport'
import { NextDraftEditor } from './NextDraftEditor'

const scope = nextDraftKey('workspace', 'workflow')
const ownerKey = protectedKey('ui', 'graph-edit-intent:tab')
const clients: QueryClient[] = []
const held = new Set<string>()
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  sessionStorage.clear()
  held.clear()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver))
    }
    unobserve() {}
    disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}),
  }))
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(fixture())
  vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue({ intent: null, current: [], canStop: false, affectedSetChanged: false })
  vi.stubGlobal('navigator', { ...navigator, locks: {
    request: async (name: string, options: unknown, callback?: (lock: unknown) => unknown) => {
      if (typeof options === 'function') return options({ name })
      if (held.has(name)) return callback!(null)
      held.add(name)
      try { return await callback!({ name }) }
      finally { held.delete(name) }
    },
  } })
})
afterEach(() => {
  cleanup()
  window.dispatchEvent(new Event('pagehide'))
  clients.splice(0).forEach(client => client.clear())
  useGraphDraftStore.getState().clearAllDrafts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" initialContext={fixture()} />
  </QueryClientProvider>)
}

it('claims separate ownership before recovering a copied sessionStorage form and preserves it on ordinary reload', async () => {
  sessionStorage.setItem(ownerKey, 'copied-owner')
  const original = newNextDraft(fixture(), 'opener')
  original.graph = { ...original.graph, name: 'Opener draft', description: 'Opener draft' }
  original.agentEdits = { 'agent-0': { ...original.context.agents[0]!.agent, name: 'Opener Agent' } }
  storeEditSnapshot(scope, original, 'opener-acknowledgement')
  const originalSnapshot = readEditSnapshot(scope)
  sessionStorage.setItem(ownerKey, 'other-owner')
  const other = newNextDraft(fixture(), 'other')
  other.graph = { ...other.graph, name: 'Other tab draft', description: 'Other tab draft' }
  other.agentEdits = { 'agent-0': { ...other.context.agents[0]!.agent, name: 'Other tab Agent' } }
  storeEditSnapshot(scope, other)
  sessionStorage.setItem(ownerKey, 'copied-owner')
  // The opener's lifetime lock remains held even while that document is suspended.
  held.add(protectedKey('ui', 'graph-edit-intent:owner:copied-owner'))
  const first = mount()
  await screen.findByRole('region', { name: 'Workflow authoring' })
  await waitFor(() => expect(sessionStorage.getItem(ownerKey)).not.toBe('copied-owner'))
  const clonedOwner = sessionStorage.getItem(ownerKey)!
  expect(screen.getByRole('button', { name: 'Opener draft' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Other tab draft' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Open Node 0 settings' }))
  expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Opener Agent')
  fireEvent.click(screen.getByRole('button', { name: 'Close Node 0' }))
  expect(editSnapshotAcknowledged(scope, original, 'opener-acknowledgement')).toBe(true)
  act(() => useGraphDraftStore.getState().changeNextDraft(scope, graph => ({ ...graph, description: 'Cloned draft' })))
  expect(readEditSnapshot(scope)?.graph.description).toBe('Cloned draft')
  first.unmount()
  window.dispatchEvent(new Event('pagehide'))
  await waitFor(() => expect(held.has(protectedKey('ui', `graph-edit-intent:owner:${clonedOwner}`))).toBe(false))
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  mount()
  await screen.findByRole('region', { name: 'Workflow authoring' })
  expect(sessionStorage.getItem(ownerKey)).toBe(clonedOwner)
  expect(readEditSnapshot(scope)?.graph.description).toBe('Cloned draft')
  sessionStorage.setItem(ownerKey, 'copied-owner')
  expect(readEditSnapshot(scope)).toEqual(originalSnapshot)
  expect(editSnapshotAcknowledged(scope, original, 'opener-acknowledgement')).toBe(true)
})
