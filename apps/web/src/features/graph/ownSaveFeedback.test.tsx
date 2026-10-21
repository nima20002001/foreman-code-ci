import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { LocalHumanAccessSchema, ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { CurrentManagedWorkflowSchema, GraphEditReadResultV3Schema, makeCurrentWorkflowFixture,
  type GraphEditReadResultV3 } from '@foreman-code/contracts/wave25'
import { PersistedWorkflowBoundary } from './PersistedWorkflowBoundary'
import { fixture } from './nextDraft/core.cases'
import { journalIntent, savedJournal } from './nextDraft/nim2644Journal.fixture'
import { nextDraftApi, type AuthoringContext } from './nextDraft/transport'
import { nextDraftKey } from './nextDraft/state'
import { clearEditIntentStorage } from './nextDraft/editIntentStorage'
import { graphEditIntentKey } from './nextDraft/useGraphEditIntent'
import { useGraphDraftStore } from './store'
import { boardDraftContextKey } from '../workflow-board/keys'
import { boardStartClient } from '../workflow-board/startClient'
import { useBoardStartPreflight, readBoardStartPreflight, type BoardStartPreflight } from '../workflow-board/startPreflight'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { bindMockInstallation } from '../../shared/mocks/handlers'
import { server } from '../../mocks/server'

// The editor, Agent form and edit journal are real; canvas and server boundaries are fixtures.
vi.mock('./nextDraft/DraftCanvas', () => ({ DraftCanvas: ({ open, setOpen, panels }: {
  open?: { nodeId: string; panel: 'settings' }
  setOpen(value?: { nodeId: string; panel: 'settings' }): void
  panels(nodeId: string): { settings: ReactNode }
}) => <><button onClick={() => setOpen({ nodeId: 'node-0', panel: 'settings' })}>Open fixture settings</button>
  {open ? <section role="dialog" aria-label="Agent settings">{panels(open.nodeId).settings}
    <button onClick={() => setOpen(undefined)}>Close fixture settings</button></section> : null}</> }))
vi.mock('../workflow-board/startPreflight', async (original) => ({
  ...await original<typeof import('../workflow-board/startPreflight')>(),
  useBoardStartPreflight: vi.fn(), readBoardStartPreflight: vi.fn(),
}))

const key = nextDraftKey('workspace', 'workflow')
const clients: QueryClient[] = []
const empty: GraphEditReadResultV3 = { intent: null, current: [], canStop: false, affectedSetChanged: false }
const warning = /The shared draft changed elsewhere|You made more edits after saving started|Draft updates unavailable/

function startFacts(context: AuthoringContext, read: GraphEditReadResultV3): BoardStartPreflight {
  const draft = context.draft
  return {
    workflow: CurrentManagedWorkflowSchema.parse({ workflow: draft.graph, revision: draft.revision,
      currentVersionId: draft.baseWorkflowVersionId, archivedAt: null }),
    workspace: ManagedWorkspaceSchema.parse({ workspace: { id: draft.workspaceId, name: 'Workspace' },
      revision: 1, archivedAt: null, locationRevision: 1,
      executionLocation: { runnerId: 'main', rootPath: '/tmp/project' },
      locationValidation: { status: 'ready', checkedAt: '2026-10-08T00:00:00Z' } }),
    capabilities: createCurrentBoardMock({ workspaceId: draft.workspaceId, allowSimulatedStart: true }).capabilities(),
    version: read.intent?.result?.version,
  }
}

beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  sessionStorage.clear()
  bindMockInstallation()
  server.use(http.get('*/api/management/workspaces/workspace/jobs/definitions',
    () => HttpResponse.json({ definitions: [] })))
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (
    name: string, optionsOrWork: LockOptions | ((lock: Lock) => Promise<unknown>),
    work?: (lock: Lock) => Promise<unknown>,
  ) => {
    const callback = typeof optionsOrWork === 'function' ? optionsOrWork : work!
    return callback({ name, mode: 'exclusive' })
  } } })
})
afterEach(() => {
  cleanup()
  clearEditIntentStorage()
  clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['Agent settings Save', 'Agent settings Save and run'] as const)(
  'acknowledges its own %s without warnings and leaves the saved version usable', async (path) => {
    let accessReads = 0
    server.use(http.get('*/api/local-human', () => {
      accessReads++
      return HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
        id: 'local-principal', name: 'Operator', expiresAt: '2099-01-01T00:00:00Z',
        grants: [{ actions: ['runs:start'], scope: {
          workspaceIds: ['workspace'], workflowIds: ['workflow'],
        } }],
      } }))
    }))
    let source: AuthoringContext = fixture()
    source.agents = source.agents.map((item) => ({ ...item, agent: { ...item.agent,
      harness: 'codex', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex } }))
    let journal = empty
    let release!: () => void
    const reply = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(nextDraftApi, 'context').mockImplementation(async () => source)
    vi.spyOn(nextDraftApi, 'editRead').mockImplementation(async () => journal)
    vi.spyOn(nextDraftApi, 'pins').mockImplementation(async () => ({
      expectedAgentConfigurationVersionIds: Object.fromEntries(source.agents.map(({ agent }) =>
        [agent.id, agent.configurationVersionId!])), agents: source.agents,
    }))
    vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
      journal = GraphEditReadResultV3Schema.parse({ ...empty, intent: journalIntent(input, source) })
      return journal
    })
    vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
      journal = { ...empty, intent: savedJournal(journal.intent!) }
      const saved = journal.intent!.result!
      source = { ...source, draft: { ...source.draft, graph: saved.version.definition,
        revision: saved.revision, publishedRevision: saved.revision, baseWorkflowVersionId: saved.currentVersionId },
      agents: [...new Map([...source.agents, ...(saved.agents ?? [])].map((item) => [item.agent.id, item])).values()] }
      source.savedDraft = source.draft
      await reply
      return journal
    })
    vi.mocked(useBoardStartPreflight).mockImplementation(() => ({ data: startFacts(source, journal),
      isError: false }) as ReturnType<typeof useBoardStartPreflight>)
    vi.mocked(readBoardStartPreflight).mockImplementation(async () => startFacts(source, journal))
    const start = vi.spyOn(boardStartClient, 'start').mockImplementation(async (input) => ({
      accepted: true, replayed: false, run: { ...makeCurrentWorkflowFixture('own-save').run,
        workspaceId: input.workspaceId, workflowId: input.workflowId, workflowVersionId: input.workflowVersionId,
        agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds, input: input.input },
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><PersistedWorkflowBoundary workspaceId="workspace"
      workflowId="workflow" workflow={source.draft.graph} /></QueryClientProvider>)
    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: 'Authoring fixture' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Authoring unavailable' })).not.toBeInTheDocument()
    await waitFor(() => expect(accessReads).toBeGreaterThan(0))
    await user.click(await screen.findByRole('button', { name: 'Open fixture settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Agent settings' })
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Saved Worker')
    await user.click(within(dialog).getByRole('button', { name: 'Apply agent settings to draft' }))
    await user.click(within(dialog).getByRole('button', { name: 'Close fixture settings' }))
    const accessReadsBeforeStart = accessReads
    await user.click(screen.getByRole('button', {
      name: path === 'Agent settings Save and run' ? 'Save and run' : 'Save workflow',
    }))
    await waitFor(() => expect(journal.intent?.state).toBe('saved'))
    try {
      await act(async () => {
        await client.refetchQueries({ queryKey: boardDraftContextKey('workspace', 'workflow') })
        await client.refetchQueries({ queryKey: graphEditIntentKey('workspace', 'workflow', source.draft.id) })
      })
      await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]?.context.draft.revision).toBe(8))
      expect(screen.queryByText(warning)).not.toBeInTheDocument()
    } finally {
      await act(async () => { release() })
    }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start saved version' })).toBeEnabled())
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
    if (path === 'Agent settings Save and run') {
      await waitFor(() => expect(start).toHaveBeenCalledOnce())
      expect(start.mock.calls[0]![0]).toMatchObject({ workflowVersionId: 'version-2',
        expectedWorkflowRevision: 8, expectedAgentConfigurationVersionIds: { 'agent-0': 'saved-agent-0' } })
    } else {
      expect(await screen.findByText('Saved.')).toBeVisible()
      expect(start).not.toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'Start saved version' }))
      await waitFor(() => expect(start).toHaveBeenCalledOnce())
    }
    expect(accessReads).toBeGreaterThan(accessReadsBeforeStart)
    source = { ...source, draft: { ...source.draft, revision: 9, publishedRevision: 9,
      graph: { ...source.draft.graph, name: 'External rename' } } }
    await act(async () => {
      await client.refetchQueries({ queryKey: boardDraftContextKey('workspace', 'workflow') })
    })
    expect(await screen.findByText(/The shared draft changed elsewhere/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Authoring fixture' })).toBeVisible()
  }, 15_000,
)
