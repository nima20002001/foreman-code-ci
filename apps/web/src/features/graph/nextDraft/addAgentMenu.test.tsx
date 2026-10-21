import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS } from '@foreman-code/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '../../../mocks/server'
import { queryKeys } from '../../../shared/api/query'
import { definition } from '../../jobs/fixtures'
import { useGraphDraftStore } from '../store'
import { nextDraftKey } from './state'
import { stageAgentEdits } from './agentEdits'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'

// Toolbar test with a stubbed canvas whose buttons stand for pane and node clicks (both go through the editor's `inspect`).
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ inspect }: { inspect(action: () => void): void }) => <>
  <button onClick={() => inspect(() => undefined)}>Canvas fixture</button>
  <button onClick={() => inspect(() => undefined)}>Select fixture node</button></> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
const saved = { ...definition, workspaceId: 'workspace' }
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, work: (() => unknown) | LockOptions, claim?: (lock: { name: string }) => unknown) => {
    if (typeof work !== 'function') return claim!({ name: name })
    const result = (queues.get(name) ?? Promise.resolve()).then(work)
    queues.set(name, result.catch(() => { /* ignore: a failed lock holder must not block the next one */ }))
    return result
  } } })
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/definitions', () => HttpResponse.json({ definitions: [saved] })))
})
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  client.setQueryData(queryKeys.agentDefaults, { value: DEFAULT_AGENT_DEFAULTS, revision: 1, versionId: 'defaults-version' })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}

const draft = () => useGraphDraftStore.getState().nextDrafts[key]!
async function choose(user: ReturnType<typeof userEvent.setup>, role: string) {
  await user.click(screen.getByRole('button', { name: 'Add agent' }))
  await user.click(within(screen.getByRole('menu', { name: 'Add agent' })).getByRole('menuitem', { name: role }))
}

it('offers the three roles and adds a Worker from its Settings profile in one click, with no panel', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const user = userEvent.setup(); mount()
  await user.click(screen.getByRole('button', { name: 'Add agent' }))
  expect(within(screen.getByRole('menu', { name: 'Add agent' })).getAllByRole('menuitem').map(item => item.getAttribute('aria-label')))
    .toEqual(['Master', 'Orchestrator', 'Worker'])
  await user.click(screen.getByRole('menuitem', { name: 'Worker' }))
  const [created] = stageAgentEdits(draft())
  expect(created).toMatchObject({ baseRevision: null, agent: { name: 'Worker 3', productRole: 'coder',
    harness: DEFAULT_AGENT_DEFAULTS.coder.harness.harness } })
  expect(created!.agent.configurationVersionId).toBeUndefined()
  expect(draft().graph.nodes.at(-1)).toMatchObject({ agentId: created!.agent.id, name: 'Worker 3' })
  expect(screen.queryByRole('complementary', { name: 'Add node' })).toBeNull()
  expect(screen.queryByRole('menu', { name: 'Add agent' })).toBeNull()
})

it('starts an empty Board without a first-agent prompt and lets the plus add its only Master', async () => {
  const context = fixture([]); context.draft.baseWorkflowVersionId = null
  useGraphDraftStore.getState().installNextDraft(key, context)
  const user = userEvent.setup(); mount()
  expect(screen.queryByText('Add your first agent')).toBeNull()
  await choose(user, 'Master')
  const [master] = stageAgentEdits(draft())
  expect(master).toMatchObject({ agent: { name: 'Master', productRole: 'master' } })
  expect(draft().graph.hierarchy?.masterNodeId).toBe(draft().graph.nodes[0]!.id)
  await user.click(screen.getByRole('button', { name: 'Add agent' }))
  expect(screen.getByRole('menuitem', { name: 'Master' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('menuitem', { name: 'Master' })).toHaveAccessibleDescription('This workflow already has a Master.')
})
