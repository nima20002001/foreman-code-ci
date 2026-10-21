import { installBrowserLocks } from '../../test/browserLocks'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { webcrypto } from 'node:crypto'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { DEFAULT_FILE_RETENTION_SECONDS, FilePageSchema, FileWithRevisionSchema, temporaryFileExpiresAt,
  type FileWithRevision } from '@foreman-code/contracts/files'
import { AgentChatContextSchema, AgentChatStateSchema, agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { RunActivitiesPageSchema, type RunGraphScope } from '@foreman-code/contracts/wave25'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'
import { getWorkspaceDetails } from '../../shared/api/client'
import { queryKeys } from '../../shared/api/query'
import { agentChatFixtureFor } from '../../shared/mocks/agentChatHandlers'
import { bindMockInstallation } from '../../shared/mocks/handlers'
import { getMockFixture, setMockScenario } from '../../shared/mocks/scenarios'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftApi } from '../graph/nextDraft/transport'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { pinnedRunHandlers, reply, runsUrl, versionReply } from '../run-board/testFixtures'
import { page, runA, runB } from '../runs-selector/testFixtures'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { RunsSelector } from '../runs-selector/RunsSelector'
import { useSelectedRun, type SelectedRunState } from '../runs-selector/useSelectedRun'
import { RunBoard } from '../run-board/RunBoard'
import { AgentChatPanel } from '../graph/AgentPanels'
import { Activities } from '../workflow-board/Activities'
import { boardDraftContextKey } from '../workflow-board/keys'
import { installChatSource } from '../conversations/agentChat/testSupport'
import { configuredOperatorSetup } from '../operator-chat/operatorSetupTestFixture'
import { operatorState } from '../operator-chat/pr17-test-fixtures'
import { installCanonicalOperatorFixture } from '../operator-chat/canonicalOperator.test-support'
import { summarizeOperatorConversation } from '../operator-chat/operatorChatStatus'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { admitted, context, envelope, execution, historicalState, installSelectedHandlers,
  scope as chatScope, selectedRoute, snapshot as chatSnapshot } from '../conversations/agentChat/sch10.testSupport'
import boardStyles from '../workflow-board/workflowBoard.css?inline'
import { deferred } from '../../test/deferred'

const scope = { workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline' }
const snapshotRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot'
const selectedChatUnavailable = http.get(selectedRoute, ({ params }) => HttpResponse.json(ReadSelectedRunChatResponseSchema.parse({
  kind: 'unavailable', target: { workspaceId: String(params.workspaceId), workflowId: String(params.workflowId),
    runId: String(params.runId), workflowNodeId: String(params.workflowNodeId) }, reason: 'execution_missing',
})))
const clients: QueryClient[] = []
let restoreBrowserLocks: () => void
const unhandled: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
let selected: SelectedRunState

async function mountBoard(entry = runsUrl('run-a', scope)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  clients.push(client)
  // These interaction tests start with loaded data; router.load() only waits for routing.
  // Read through MSW so cold workspace/draft hydration cannot consume the element wait.
  await Promise.all([
    client.fetchQuery({
      queryKey: queryKeys.workspaceDetails(scope.workspaceId),
      queryFn: ({ signal }) => getWorkspaceDetails({ workspaceId: scope.workspaceId }, { signal }),
    }),
    client.fetchQuery({
      queryKey: boardDraftContextKey(scope.workspaceId, scope.workflowId),
      queryFn: ({ signal }) => nextDraftApi.context(scope.workspaceId, scope.workflowId, { signal }),
    }),
  ])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  return { ...render(<><style>{boardStyles}</style>
    <QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></>), router }
}

async function choose(user: ReturnType<typeof userEvent.setup>, runId: string) {
  const controls = screen.getByLabelText('Board controls')
  expect(controls).toHaveRole('group')
  await user.click(within(controls).getByLabelText('Runs', { selector: 'button' }))
  const menu = await screen.findByLabelText('Runs', { selector: '[role=menu]' })
  await user.click(await waitFor(() => {
    const row = menu.querySelector<HTMLButtonElement>(`[data-run-id="${runId}"]`)
    expect(row).not.toBeNull()
    return row!
  }))
}

function installBoardHistory() {
  const chatReads: URL[] = []
  const fixture = getMockFixture(scope.workspaceId)!
  server.use(
    ...pinnedRunHandlers(scope),
    http.get('/api/local-human', () => HttpResponse.json({ principal: {
      id: 'board-history-reader', name: 'Board history reader', expiresAt: '2099-01-01T00:00:00.000Z',
      grants: [{ actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'runs:read',
        'agent_chat:read', 'settings:read'], scope: { workspaceIds: [scope.workspaceId] } }],
    } })),
    http.get('*/api/workspaces/:workspaceId/agent-chat', ({ request, params }) => {
      const url = new URL(request.url)
      chatReads.push(url)
      const context = AgentChatContextSchema.parse({ workspaceId: String(params.workspaceId),
        ...Object.fromEntries(url.searchParams) })
      return HttpResponse.json(agentChatFixtureFor(agentChatFixtures.empty, context))
    }),
    http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json({ workspace: fixture.workspace,
      revision: 1, archivedAt: null, executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
      locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' } })),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries', () => HttpResponse.json(page([runA, runB]))),
    http.get(snapshotRoute, ({ params }) => HttpResponse.json(reply(String(params.runId), scope))),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/version', ({ params }) =>
      HttpResponse.json(versionReply(reply(String(params.runId), scope).snapshot))),
    http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/reference-files', () =>
      HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
    http.get('*/api/workspaces/:workspaceId/reference-files', () =>
      HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
  )
  return chatReads
}

function SelectedSurface() {
  selected = useSelectedRun(chatScope)
  return <><RunsSelector selection={selected} /><RunBoard selection={selected} />
    <AgentChatPanel name="Removed Coder" context={context(selected.identity.runId ?? undefined)} />
    <Activities selection={selected} /></>
}

async function mountSelected() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema, component: SelectedSurface })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [runsUrl('run-a', chatScope)] }), defaultPendingMinMs: 0 })
  await router.load()
  return render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
}
const activityRegion = () => screen.getAllByRole('region', { name: 'Activities' }).at(-1)!
function fileRow(state: AgentChatState, id: string, filename = 'shared.md', createdAt = new Date().toISOString(), status: 'ready' | 'expired' = 'ready', byteSize = 4) {
  const conversation = state.conversation!
  const scope = { kind: 'temporary' as const, chat: { kind: 'agent' as const, workspaceId: conversation.workspaceId,
    workflowId: conversation.workflowId, agentId: conversation.agentId, conversationId: conversation.id,
    runId: state.context.runId!, executionId: `execution-${state.context.runId}` } }
  return FileWithRevisionSchema.parse({ file: { fileId: `file-${id}`, currentRevisionId: `revision-${id}`, scope,
    state: status, createdAt, retentionDurationSeconds: DEFAULT_FILE_RETENTION_SECONDS,
    expiresAt: temporaryFileExpiresAt(createdAt, DEFAULT_FILE_RETENTION_SECONDS) },
  revision: { fileId: `file-${id}`, revisionId: `revision-${id}`, filename, mediaType: 'text/markdown', byteSize,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', origin: 'upload', createdAt } })
}

beforeEach(() => {
  restoreBrowserLocks = installBrowserLocks()
  unhandled.length = 0; server.events.on('request:unhandled', recordUnhandled)
  localStorage.clear(); sessionStorage.clear(); bindMockInstallation(); useGraphDraftStore.getState().clearAllDrafts()
  installFlowLayout(320, 480); installChatSource()
  server.use(http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })), selectedChatUnavailable,
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/version', ({ params }) =>
      HttpResponse.json(versionReply(chatSnapshot(String(params.runId)).snapshot))),
    http.get('*/api/management/workspaces/workspace-1/runs/:runId/activities', ({ params, request }) => {
      const runId = String(params.runId)
      const snapshot = reply(runId, scope).snapshot
      if (snapshot.kind !== 'available') throw new Error('The Activities fixture requires a saved Run')
      const runScope: RunGraphScope = {
        ...scope, runId, workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3,
      }
      const newer = new URL(request.url).searchParams.has('cursor')
      return HttpResponse.json(RunActivitiesPageSchema.parse({
        scope: runScope, mode: newer ? 'newer' : 'initial', highWater: '1', retainedFrom: '1',
        nextCursor: `cursor-${runId}`, olderCursor: null, hasMore: false,
        items: newer ? [] : [{ id: `activity-${runId}`, scope: runScope, sequence: '1', occurredAt: snapshot.capturedAt,
          source: 'backend', kind: 'run', status: 'recorded', severity: 'info', summary: `Saved run ${runId}`, refs: {} }],
      }))
    }),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/activities', ({ params }) => {
      const runId = String(params.runId)
      const snapshot = reply(runId, scope).snapshot
      if (snapshot.kind !== 'available') throw new Error('Expected a saved Run snapshot')
      return HttpResponse.json(RunActivitiesPageSchema.parse({
        scope: { ...scope, runId, workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 },
        mode: 'initial', highWater: '0', retainedFrom: '1', nextCursor: `cursor-${runId}`,
        olderCursor: null, hasMore: false, items: [],
      }))
    }),
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({
      evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 1,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
    })),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [],
    })),
  )
})
afterEach(() => {
  cleanup(); window.dispatchEvent(new Event('pagehide'))
  restoreBrowserLocks()
  clients.splice(0).forEach((client) => client.clear())
  server.events.removeListener('request:unhandled', recordUnhandled)
  expect(unhandled, 'No selected Board request may bypass MSW').toEqual([])
  useGraphDraftStore.getState().clearAllDrafts(); setMockScenario('normal')
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

describe('Selected Board history', { timeout: 20_000 }, () => {
  it('keeps the 320px controls together and Files read only on the selected Run', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('innerWidth', 320)
    installBoardHistory()
    await mountBoard()
    const board = await screen.findByRole('region', { name: 'Selected Run board' })
    const graph = within(board)
    const node = await graph.findByRole('button', { name: 'Inspect Y' })
    expect(node).toBeVisible()
    expect(node).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Activities' }))
    const activities = await screen.findByRole('region', { name: 'Activities popover' })
    expect(await within(activities).findByText('Saved run run-a')).toBeVisible()
    await user.click(within(activities).getByRole('button', { name: 'Close Activities' }))
    const controls = screen.getByRole('group', { name: 'Board controls' })
    const clock = within(controls).getByRole('button', { name: 'Schedule workflow' })
    const runs = within(controls).getByRole('button', { name: 'Runs' })
    const files = within(controls).getByRole('button', { name: 'Files' })
    expect(runs.compareDocumentPosition(clock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(runs.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(controls.closest('header')).toHaveStyle({ minWidth: '0', boxSizing: 'border-box' })
    await user.click(files)
    const dialog = await screen.findByRole('dialog', { name: 'Files' })
    expect(within(dialog).queryByRole('button', { name: 'Upload workflow file' })).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Choose workflow file')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Close files' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  })

  it.each([320, 1024])('keeps the saved graph and chat selection together across A, B, A at %spx', async (width) => {
    const user = userEvent.setup()
    vi.stubGlobal('innerWidth', width)
    installBoardHistory()
    const targetReads: URL[] = []
    server.use(http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/execution-chat/target', ({ request }) => {
      targetReads.push(new URL(request.url))
      return HttpResponse.json({ kind: 'unavailable', reason: 'NO_EXECUTION' })
    }))
    const { router } = await mountBoard()
    await screen.findByLabelText('Selected Run board')
    const assertSelection = async (runId: string, name: string) => {
      // Run changes remount the canvas. Wait for its pins before retaining a query scope.
      const pinned = await waitFor(() => {
        const region = screen.getByLabelText('Selected Run board')
        expect(region).toHaveRole('region')
        expect(region).toHaveAttribute('data-run-id', runId)
        return region
      })
      const expectedPins = { workflowId: scope.workflowId, selectedRunId: runId }
      expect(router.state.location.search).toMatchObject(expectedPins)
      const graph = within(pinned)
      const node = await graph.findByLabelText(`Inspect ${name}`, { selector: 'button' })
      expect(node).toHaveRole('button')
      expect(node).toBeVisible()
      expect(node).toBeEnabled()
      expect(screen.queryByLabelText('Agent chat', { selector: 'aside, [role=complementary]' })).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Open Selected Run panel', { selector: 'button' })).not.toBeInTheDocument()
      await user.click(node)
      const chat = await screen.findByRole('complementary', { name: 'Workflow side panel' })
      await user.click(within(chat).getByRole('button', { name: 'Chat' }))
      expect(router.state.location.search).toMatchObject({ boardPanel: 'agent', boardAgentTab: 'chat',
        boardNodeId: name === 'Y' ? 'node-y' : 'node-x' })
      expect(chat).toBeVisible()
      await waitFor(() => expect(targetReads.at(-1)?.searchParams.get('runId')).toBe(runId))
      expect(targetReads.at(-1)?.searchParams.get('workflowNodeId')).toBe(name === 'Y' ? 'node-y' : 'node-x')
      await user.keyboard('{Escape}')
      await waitFor(() => expect(chat).not.toBeVisible())
      await user.click(screen.getByRole('button', { name: 'Activities' }))
      const activities = await screen.findByRole('region', { name: 'Activities popover' })
      expect(await within(activities).findByText(`Saved run ${runId}`)).toBeVisible()
      await user.click(within(activities).getByLabelText('Close Activities', { selector: 'button' }))
      expect(router.state.location.search).toMatchObject(expectedPins)
      expect(pinned).toHaveAttribute('data-run-id', runId)
    }
    await assertSelection('run-a', 'Y')
    const controls = screen.getByLabelText('Board controls')
    if (width === 320) {
      await user.click(within(controls).getByLabelText('Files', { selector: 'button' }))
      const dialog = await screen.findByRole('dialog', { name: 'Files' })
      await user.click(within(dialog).getByLabelText('Close files', { selector: 'button' }))
      await waitFor(() => expect(dialog).not.toBeInTheDocument())
    }
    await choose(user, 'run-b')
    await assertSelection('run-b', 'X in B')
    expect(screen.queryByLabelText('Inspect Y', { selector: 'button' })).not.toBeInTheDocument()
    await choose(user, 'run-a')
    await assertSelection('run-a', 'Y')
    expect(screen.queryByLabelText('Inspect X in B', { selector: 'button' })).not.toBeInTheDocument()
  })

  it('keeps same-named Operator file cards bound to chats A and B while a Board is open', async () => {
    const owner = 'combined-owner'
    const operatorFile = (id: string) => FileWithRevisionSchema.parse({
      file: { fileId: `operator-file-${id}`, currentRevisionId: `operator-revision-${id}`,
        scope: { kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: owner,
          operatorId: 'application-operator', conversationId: `conversation-${id}` } }, state: 'ready',
        createdAt: '2026-09-28T00:00:00.000Z', retentionDurationSeconds: DEFAULT_FILE_RETENTION_SECONDS,
        expiresAt: temporaryFileExpiresAt('2026-09-28T00:00:00.000Z', DEFAULT_FILE_RETENTION_SECONDS) },
      revision: { fileId: `operator-file-${id}`, revisionId: `operator-revision-${id}`, filename: 'shared.md',
        mediaType: 'text/markdown', byteSize: 4,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        origin: 'upload', createdAt: '2026-09-28T00:00:00.000Z' },
    })
    const states = new Map(['a', 'b'].map((id) => {
      const conversationId = `conversation-${id}`
      return [conversationId, operatorState({
        conversation: { ...operatorState().conversation, id: conversationId, title: `Chat ${id.toUpperCase()}` },
        messages: [{ id: `message-${id}`, conversationId, role: 'user', content: `Message ${id.toUpperCase()}`,
          attachments: [operatorFile(id)] }], turnState: 'idle', activeRequestId: null,
      })] as const
    }))
    useOperatorChatStore.setState({ open: true, historyOpen: false, selectedConversationId: 'conversation-a' })
    installBoardHistory()
    const fixture = getMockFixture(scope.workspaceId)!
    server.use(
      http.get('/api/local-human', () => HttpResponse.json({ principal: { id: owner, name: 'Combined tester',
        expiresAt: '2099-01-01T00:00:00.000Z', grants: [] } })),
      http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 1, versionId: null,
        value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator,
          uiEnabled: true, harness: DEFAULT_HARNESS_DEFAULTS.codex } } })),
      http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('codex'))),
      http.get('/api/operator/conversations/summaries', () => HttpResponse.json({ conversations: [...states.values()].map(summarizeOperatorConversation) })),
      http.get('/api/operator/conversations/:id', ({ params }) => HttpResponse.json(states.get(String(params.id)))),
      http.get('*/api/operator/conversations/:id/files', ({ params }) => {
        const state = states.get(String(params.id))
        if (!state) throw new Error('Unknown Operator conversation')
        return HttpResponse.json(FilePageSchema.parse({
          items: state.messages.flatMap(message => message.attachments ?? []), pageInfo: { nextCursor: null },
        }))
      }),
      http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json({ workspace: fixture.workspace,
        revision: 1, archivedAt: null, executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
        locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' } })),
      http.get(snapshotRoute, ({ params }) => HttpResponse.json(reply(String(params.runId), scope))),
    )
    installCanonicalOperatorFixture()
    await mountBoard()
    await screen.findByRole('region', { name: 'Selected Run board' })
    const card = () => screen.getByRole('group', { name: /shared.md/ })
    await waitFor(() => expect(card().querySelector('[title*="operator-file-a"]')).not.toBeNull())
    expect(screen.getByText('Message A')).toBeInTheDocument()
    act(() => useOperatorChatStore.getState().select('conversation-b'))
    await waitFor(() => expect(card().querySelector('[title*="operator-file-b"]')).not.toBeNull())
    expect(screen.queryByText('Message A')).not.toBeInTheDocument()
    expect(screen.getByText('Message B')).toBeInTheDocument()
    act(() => useOperatorChatStore.getState().select('conversation-a'))
    await waitFor(() => expect(card().querySelector('[title*="operator-file-a"]')).not.toBeNull())
    expect(screen.queryByText('Message B')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', 'run-a')
  })

  it('moves graph, chat and Activities as one selection and rejects a late old-Run read', async () => {
    const source = installSelectedHandlers()
    const a = source.states.get('run-a')!, b = source.states.get('run-b')!
    a.messages[0]!.attachments = [fileRow(a, 'a')]
    a.messages[1]!.attachments = [fileRow(a, 'expired', 'old.md', '2020-01-01T00:00:00.000Z', 'expired')]
    b.messages[0]!.attachments = [fileRow(b, 'b')]
    server.use(http.get(snapshotRoute, ({ params }) => HttpResponse.json(chatSnapshot(String(params.runId)))))
    await mountSelected()
    await screen.findByText('Reply execution-run-a')
    await within(activityRegion()).findByText('Run activity execution-run-a')
    expect(screen.getByRole('group', { name: /shared.md/ })).toHaveAttribute('data-state', 'ready')
    expect(screen.getByRole('group', { name: /old.md/ })).toHaveAttribute('data-state', 'expired')
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', 'run-a')
    const old = deferred<ReturnType<typeof envelope>>()
    let held = false
    server.use(http.get('*/api/workspaces/:workspaceId/agent-chat', async ({ request }) => {
      const id = new URL(request.url).searchParams.get('runId')!
      if (id === 'run-b' && !held) { held = true; const late = await old.promise; return HttpResponse.json(late.kind === 'selected' ? late.state : null) }
      return HttpResponse.json(source.states.get(id)!)
    }))
    await act(async () => { await selected.selectRun('run-b') })
    await waitFor(() => expect(held).toBe(true))
    expect(screen.queryByText('Reply execution-run-a')).not.toBeInTheDocument()
    await act(async () => { await selected.selectRun('run-a') })
    await screen.findByText('Reply execution-run-a')
    const late = historicalState('run-b'); late.messages[1]!.content = 'Late B response'
    await act(async () => { old.resolve(envelope(late, execution('run-b'))); await old.promise })
    expect(screen.queryByText('Late B response')).not.toBeInTheDocument()
    expect(await within(activityRegion()).findByText('Run activity execution-run-a')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', 'run-a')
    await act(async () => { await selected.selectRun('run-b') })
    await screen.findByText('Reply execution-run-b')
    await within(activityRegion()).findByText('Run activity execution-run-b')
    expect(screen.getByRole('group', { name: /shared.md/ })).toHaveAttribute('data-state', 'ready')
    expect(screen.queryByRole('group', { name: /old.md/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Reply execution-run-a')).not.toBeInTheDocument()
    expect(within(activityRegion()).queryByText('Run activity execution-run-a')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', 'run-b')
    await act(async () => { await selected.selectRun('run-a') })
    await screen.findByText('Reply execution-run-a')
    await within(activityRegion()).findByText('Run activity execution-run-a')
    expect(screen.queryByText('Reply execution-run-b')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: /old.md/ })).toHaveAttribute('data-state', 'expired')
  })

  it('uploads, sends and reads back a Board agent file, keeping a late A upload out of B', async () => {
    vi.stubGlobal('crypto', { ...crypto, subtle: webcrypto.subtle, randomUUID: webcrypto.randomUUID.bind(webcrypto) })
    const source = installSelectedHandlers()
    const staged = new Map<string, FileWithRevision>()
    const posts: Array<{ runId: string; body: Record<string, unknown> }> = []
    const late = deferred<void>()
    let holdFirst = true
    server.use(
      http.get(snapshotRoute, ({ params }) => HttpResponse.json(chatSnapshot(String(params.runId)))),
      http.post('*/files/uploads', async ({ request }) => {
        const input = await request.json() as { requestId: string; filename: string; sha256: string; byteSize: number }
        const runId = new URL(request.url).pathname.includes('execution-run-b') ? 'run-b' : 'run-a'
        const state = source.states.get(runId)!
        const base = fileRow(state, input.requestId, input.filename, new Date().toISOString(), 'ready', input.byteSize)
        const value = FileWithRevisionSchema.parse({ file: { ...base.file, state: 'pending' },
          revision: { ...base.revision, sha256: input.sha256 } })
        staged.set(input.requestId, value)
        return HttpResponse.json({ value, replayed: false })
      }),
      http.put('*/files/uploads/:requestId', ({ params }) => HttpResponse.json({ value: staged.get(String(params.requestId)), replayed: false })),
      http.post('*/files/uploads/:requestId/finalize', async ({ params }) => {
        const row = staged.get(String(params.requestId))!
        if (holdFirst) { holdFirst = false; await late.promise }
        return HttpResponse.json({ value: { ...row, file: { ...row.file, state: 'ready' } }, replayed: false })
      }),
      http.post('*/api/workspaces/:workspaceId/agent-chat/messages', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>
        const runId = (body.context as { runId: string }).runId
        posts.push({ runId, body })
        const result = admitted(source.states.get(runId)!, body as Parameters<typeof admitted>[1])
        const pin = (body.attachments as Array<{ fileId: string; revisionId: string }>)[0]
        const file = [...staged.values()].find((row) => row.revision.fileId === pin?.fileId)!
        result.state.messages.at(-1)!.attachments = [{ ...file, file: { ...file.file, state: 'ready' } }]
        const parsed = AgentChatStateSchema.parse(result.state)
        source.states.set(runId, parsed)
        return HttpResponse.json({ ...result, state: parsed })
      }),
    )
    await mountSelected()
    await screen.findByText('Reply execution-run-a')
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled()
    await userEvent.setup().upload(screen.getByLabelText('Choose attachments'), new File(['late'], 'late.md', { type: 'text/markdown' }))
    await waitFor(() => expect(staged.size).toBe(1))
    await act(async () => { await selected.selectRun('run-b') })
    await screen.findByText('Reply execution-run-b')
    await act(async () => { late.resolve(); await late.promise })
    expect(screen.queryByText('late.md')).not.toBeInTheDocument()
    await userEvent.setup().upload(screen.getByLabelText('Choose attachments'), new File(['from B'], 'sent.md', { type: 'text/markdown' }))
    await waitFor(() => expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('Ready'))
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Review B file')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ runId: 'run-b', body: { context: { runId: 'run-b' } } })
    expect(await screen.findByRole('group', { name: /sent.md/ })).toHaveAttribute('data-state', 'ready')
    await act(async () => { await selected.selectRun('run-a') })
    await screen.findByText('Reply execution-run-a')
    expect(screen.queryByRole('group', { name: /sent.md/ })).not.toBeInTheDocument()
    expect(posts).toHaveLength(1)
  })
})
