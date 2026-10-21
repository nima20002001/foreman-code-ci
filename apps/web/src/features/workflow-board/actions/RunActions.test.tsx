// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, RespondToInteractionRequestSchema } from '@foreman-code/contracts'
import { LocalHumanAccessSchema, ManagedWorkspaceSchema, type ManagementAction } from '@foreman-code/contracts/management'
import { CURRENT_WORKFLOW_CAPABILITIES, CurrentWorkflowCapabilitiesSchema, RunExecutionDetailSchema,
  RunExecutionSummarySchema, RunInspectionRunSchema, RunRecordDetailSchema, RunStartV3InputSchema, WorkflowRunV3Schema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { server } from '../../../mocks/server'
import { useGraphDraftStore } from '../../graph/store'
import { nextDraftKey } from '../../graph/nextDraft/state'
import { readBoardStop, clearBoardStopStorage } from '../stopOutbox'
import { readBoardStart, reserveBoardStart, clearBoardStartStorage } from '../startOutbox'
import { RunActions } from './index'
import { actionKey } from './state'
import { prepareNewFullRun, runActionsClient } from './client'

const clients: QueryClient[] = []
const unhandled: string[] = []
const onUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
const actions: ManagementAction[] = ['runs:read', 'runs:start', 'runs:stop', 'runs:resume', 'interactions:read', 'interactions:respond']
let serial = 0
function fixture(outcome: 'pending' | 'failed' | 'canceled' = 'pending') {
  const f = makeCurrentWorkflowFixture(`actions-${++serial}`)
  const { workspaceId, workflowId, runId } = f.scope
  const runPath = `/api/management/workspaces/${workspaceId}/runs/${runId}`
  const workflowPath = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
  const location = { runnerId: 'synthetic-runner', rootPath: '/synthetic/new-run-folder' }
  const state = {
    run: WorkflowRunV3Schema.parse({ ...f.run, input: { instruction: 'exact original Run input' },
      executionState: outcome === 'pending' ? 'running' : 'completed', outcome,
      ...(outcome === 'pending' ? {} : { finishedAt: f.createdAt, result: outcome === 'failed'
        ? { outcome, error: { code: 'SYNTHETIC_FAILURE', message: 'Exact native failure', retryable: true } }
        : { outcome } }),
    }),
    cleanupPending: false, currentVersionId: f.version.id, revision: 7, locationRevision: 9,
    access: LocalHumanAccessSchema.parse({ principal: { id: 'lane-c-user', name: 'Lane C user',
      expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions, scope: { workspaceIds: [workspaceId], workflowIds: [workflowId] } }] } }),
    capabilities: CurrentWorkflowCapabilitiesSchema.parse({ ...CURRENT_WORKFLOW_CAPABILITIES,
      runtimeAdmission: true, stopAvailable: true, meaningfulEdit: true, reasons: [],
      editIntents: { ...CURRENT_WORKFLOW_CAPABILITIES.editIntents, stopUnsettled: true } }),
    stopFailures: 0, startFailures: 0, approvalFailures: 0, canRespond: true,
    failStatusAfterStop: false,
    stopStatus: 'accepted' as 'accepted' | 'not_owner',
    requests: [] as Array<{ method: string; path: string; body?: unknown }>,
    interactions: [DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex,
      id: `interaction-${runId}`, revision: 0, workspaceId, workflowId, runId, executionId: f.identities[0]!.executionId,
      requestingAgentId: f.identities[0]!.agentId, approval: { handler: 'user' } })],
  }
  const metadata = () => RunInspectionRunSchema.parse({ ...f.scope, executionState: state.run.executionState,
    outcome: state.run.outcome, createdAt: f.createdAt, ...(state.run.finishedAt ? { finishedAt: state.run.finishedAt } : {}),
    ...(state.run.result?.error ? { failure: state.run.result.error } : {}),
    cleanupPending: state.cleanupPending })
  const rows = () => f.identities.map((identity) => RunExecutionSummarySchema.parse({ ...identity,
    state: state.run.executionState === 'completed' ? 'completed' : 'waiting', createdAt: f.createdAt,
    ...(state.run.finishedAt ? { finishedAt: state.run.finishedAt } : {}), acceptedResultAvailable: false }))
  const record = async (request: Request) => {
    const url = new URL(request.url)
    const body: unknown = request.method === 'POST' ? await request.clone().json() : undefined
    state.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, ...(body === undefined ? {} : { body }) })
    return body
  }
  const failed = () => HttpResponse.json({ error: { code: 'SYNTHETIC_UNCERTAIN', message: 'Receipt was not observed' } }, { status: 503 })
  const handlers = [
    http.get('*/api/local-human', async ({ request }) => { await record(request); return HttpResponse.json(state.access) }),
    http.get('*/api/management/workflows/capabilities/v3', async ({ request }) => { await record(request); return HttpResponse.json(state.capabilities) }),
    http.get(`*${runPath}/executions`, async ({ request }) => {
      await record(request)
      if (state.failStatusAfterStop && state.requests.some((entry) => entry.method === 'POST' && entry.path.endsWith('/stop')))
        return failed()
      const url = new URL(request.url), limit = Number(url.searchParams.get('limit'))
      const all = rows(), after = url.searchParams.has('cursor')
      return HttpResponse.json({ run: metadata(), items: limit === 1 ? all.slice(0, 1) : after ? all.slice(1) : all.slice(0, 1),
        pageInfo: { nextCursor: limit === 1 || after ? null : 'next-execution-page' } })
    }),
    http.get(`*${runPath}/executions/:executionId`, async ({ request, params }) => {
      await record(request)
      const row = rows().find((candidate) => candidate.executionId === params.executionId)
      if (!row) return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'No such execution' } }, { status: 404 })
      return HttpResponse.json(RunExecutionDetailSchema.parse({ run: metadata(), execution: row,
        acceptedInput: { digest: `sha256:${'0'.repeat(64)}`, value: { executionSemanticsVersion: 3,
          runInput: state.run.input, occurrence: null, entry: null, predecessors: [] } },
        acceptedResult: { status: 'not_accepted' }, ...(state.run.result ? { reportedResult: state.run.result } : {}) }))
    }),
    http.get(`*${runPath}/version`, async ({ request }) => { await record(request); return HttpResponse.json({ scope: f.scope, version: f.version }) }),
    http.get(`*${runPath}/record`, async ({ request }) => {
      await record(request)
      return HttpResponse.json(RunRecordDetailSchema.parse({ run: state.run,
        stopRequested: false, cleanupPending: state.cleanupPending }))
    }),
    // Regression guard: aggregate history is unavailable for this Run. Neither
    // explicit result disclosure nor full-Run preflight may request/fall back to it.
    http.get(`*${runPath}`, async ({ request }) => {
      await record(request)
      return HttpResponse.json({ error: { code: 'RUN_DETAIL_TOO_LARGE', message: 'Aggregate history exceeds 2 MiB' } }, { status: 409 })
    }),
    http.get(`*${workflowPath}`, async ({ request }) => { await record(request); return HttpResponse.json({ workflow: f.version.definition,
      revision: state.revision, currentVersionId: state.currentVersionId, archivedAt: null }) }),
    http.get(`*/api/management/workspaces/${workspaceId}`, async ({ request }) => {
      await record(request)
      return HttpResponse.json(ManagedWorkspaceSchema.parse({ workspace: { id: workspaceId, name: 'Synthetic workspace' }, revision: 1,
        archivedAt: null, executionLocation: location, locationRevision: state.locationRevision,
        locationValidation: { status: 'ready', checkedAt: f.createdAt } }))
    }),
    http.post(`*${runPath}/stop`, async ({ request }) => {
      await record(request)
      if (state.stopFailures-- > 0) return failed()
      state.cleanupPending = true
      return HttpResponse.json({ runId, status: state.stopStatus, processStopped: false, replayed: state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/stop')).length > 1 })
    }),
    http.post(`*${workflowPath}/runs`, async ({ request }) => {
      const input = RunStartV3InputSchema.parse(await record(request))
      if (state.startFailures-- > 0) return failed()
      return HttpResponse.json({ accepted: true, replayed: state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/runs')).length > 1,
        run: WorkflowRunV3Schema.parse({ ...f.run, id: `${runId}-new`, workflowVersionId: input.workflowVersionId,
          input: input.input, executionLocation: { ...location, locationRevision: input.expectedLocationRevision, identityHash: `sha256:${'a'.repeat(64)}` } }) })
    }),
    http.get('*/api/user/interactions', async ({ request }) => {
      await record(request)
      return HttpResponse.json({ items: state.interactions, nextCursor: null })
    }),
    http.get('*/api/user/interactions/:interactionId', async ({ request, params }) => {
      await record(request)
      const interaction = state.interactions.find((item) => item.id === params.interactionId)
      return HttpResponse.json({ interaction, canRespond: state.canRespond })
    }),
    http.post('*/api/user/interactions/:interactionId/respond', async ({ request }) => {
      const input = RespondToInteractionRequestSchema.parse(await record(request))
      if (state.approvalFailures-- > 0) return failed()
      const current = state.interactions.find((item) => item.id === input.interactionId)!
      const next = DurableInteractionSchema.parse({ ...current, revision: current.revision + 1, status: 'delivery_pending',
        selectedOptionId: input.optionId, selectedSemantic: current.responseOptions.find((option) => option.optionId === input.optionId)!.semantic,
        nativeResponse: { syntheticDecision: input.optionId }, decidedAt: f.createdAt, deliveryState: 'uncertain' })
      state.interactions = state.interactions.map((item) => item.id === current.id ? next : item)
      return HttpResponse.json({ interaction: next, replayed: false })
    }),
  ]
  return { f, state, runPath, workflowPath, location, handlers, metadata, rows }
}
type Fixture = ReturnType<typeof fixture>
const approveOption = (mock: Fixture) => mock.state.interactions[0]!.responseOptions.find((option) => option.semantic === 'approve_once')!
const otherOption = (mock: Fixture) => mock.state.interactions[0]!.responseOptions.find((option) => option.optionId !== approveOption(mock).optionId)!
const writes = (mock: Fixture, suffix: string) => mock.state.requests.filter((request) => request.method === 'POST' && request.path.endsWith(suffix))
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
async function mount(mock: Fixture, strict = false, ready = true) {
  server.use(...mock.handlers)
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  clients.push(query)
  const element = <QueryClientProvider client={query}><RunActions {...mock.f.scope} /></QueryClientProvider>
  const mounted = render(strict ? <StrictMode>{element}</StrictMode> : element)
  if (ready) {
    await screen.findByRole('button', { name: 'Resume execution — unavailable' })
    await waitFor(() => expect(query.getQueryData(actionKey(mock.f.scope, 'capabilities'))).toBeDefined())
    await waitFor(() => expect(screen.queryByText('Checking retained Start storage.')).not.toBeInTheDocument())
  }
  return { ...mounted, query }
}
async function openApproval(user: ReturnType<typeof userEvent.setup>, mock: Fixture) {
  await user.click(screen.getByText('Human approvals for this Run'))
  await user.click(await screen.findByText(`Human approval ${mock.state.interactions[0]!.id} · pending`))
  await screen.findByLabelText('Exact human approval request')
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); clearBoardStartStorage(); clearBoardStopStorage()
  useGraphDraftStore.getState().clearAllDrafts()
  unhandled.length = 0; server.events.on('request:unhandled', onUnhandled)
  const tails = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, work: () => unknown) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(work); tails.set(key, next.catch(() => {
      // ignore: the caller receives the rejection; later lock requests must still run.
      return undefined
    })); return next
  } } })
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((query) => query.clear()); clearBoardStartStorage(); clearBoardStopStorage()
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.useRealTimers()
  server.events.removeListener('request:unhandled', onUnhandled)
  expect(unhandled, 'All Run actions must remain on explicitly mocked existing routes').toEqual([])
})

describe('ENG-05 contextual Run actions on current S3 contracts', () => {
  it.each(['finish', 'continue', 'stop'] as const)('offers a Run direction choice for %s through the existing interaction UI', async (choice) => {
    const mock = fixture()
    const user = userEvent.setup()
    const base = mock.state.interactions[0]!
    const offered = approveOption(mock)
    mock.state.interactions = [DurableInteractionSchema.parse({ ...base, kind: 'work_direction',
      nativeRequestType: 'workflow/work_direction', request: { message: 'Review is incomplete', remainingFindings: ['Review is incomplete'] },
      responseOptions: [
        { ...offered, optionId: 'finish', label: 'Finish Run and accept remaining findings' },
        { ...offered, optionId: 'continue', label: 'Continue in a new Run', input: { kind: 'form', schema: {
          type: 'object', properties: { direction: { type: 'string', title: 'Direction for the agents', minLength: 1 } },
          required: ['direction'], additionalProperties: false,
        } } },
        { ...offered, optionId: 'stop', label: 'Stop Run', semantic: 'cancel' },
      ],
    })]
    await mount(mock)
    await user.click(screen.getByText('Human approvals for this Run'))
    await user.click(await screen.findByText(`Run direction ${base.id} · pending`))
    expect(await screen.findByLabelText('Exact human approval request')).toHaveTextContent('Review is incomplete')
    expect(screen.getByRole('button', { name: 'Finish Run and accept remaining findings' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Continue in a new Run' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop Run' })).toBeEnabled()
    if (choice === 'continue') await user.type(screen.getByLabelText('Direction for the agents (required)'), 'Complete the review')
    const label = mock.state.interactions[0]!.responseOptions.find((item) => item.optionId === choice)!.label
    await user.click(screen.getByRole('button', { name: label }))
    await screen.findByText('Run direction recorded.')
    expect(writes(mock, '/respond').map((request) => request.body)).toEqual([{
      interactionId: base.id, expectedRevision: base.revision, optionId: choice,
      ...(choice === 'continue' ? { response: { direction: 'Complete the review' } } : {}),
    }])
  })
  it('reads bounded metadata only on mount and refresh, and never advertises node retry or provider recovery', async () => {
    const mock = fixture(), user = userEvent.setup()
    await mount(mock, true)
    const statusReads = mock.state.requests.filter((request) => request.path.includes('/executions'))
    expect(statusReads.length).toBeGreaterThan(0)
    expect(statusReads.every((request) => request.path.endsWith('/executions?limit=1'))).toBe(true)
    expect(mock.state.requests.some((request) => request.path === mock.runPath || request.path.endsWith('/version') || request.path.endsWith('/record'))).toBe(false)
    expect(screen.getByRole('button', { name: 'Resume execution — unavailable' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /retry.*node|restart.*provider/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh / reconnect client state' }))
    await screen.findByText('Client state refreshed.')
    expect(mock.state.requests.filter((request) => request.method === 'POST')).toEqual([])
  })
  it('retains exact Stop on an uncertain reply and separates accepted Stop from cleanup settlement', async () => {
    const mock = fixture(), user = userEvent.setup(); mock.state.stopFailures = 1
    await mount(mock)
    await user.click(screen.getByRole('button', { name: 'Stop this Run' }))
    await screen.findByText(/Stop is not confirmed/)
    const first = readBoardStop(mock.f.scope)!
    expect(first.request).toEqual({ workspaceId: mock.f.scope.workspaceId, runId: mock.f.scope.runId, commandId: expect.any(String) })
    expect(first.scope).toEqual(mock.f.scope)
    await user.click(screen.getByRole('button', { name: 'Reconcile Stop' }))
    await screen.findByText(/Stop receipt: accepted/)
    expect(writes(mock, '/stop').map((request) => request.body)).toEqual([first.request, first.request])
    expect(readBoardStop(mock.f.scope)?.receipt?.processStopped).toBe(false)
    expect(screen.getByRole('button', { name: 'Verify cleanup settlement' })).toBeDisabled()
    mock.state.run = WorkflowRunV3Schema.parse({ ...mock.f.run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: mock.f.createdAt })
    mock.state.cleanupPending = false
    await user.click(screen.getByRole('button', { name: 'Refresh / reconnect client state' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify cleanup settlement' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Verify cleanup settlement' }))
    await screen.findByText(/Authenticated readback confirms this Run is terminal and cleanup-settled/)
    expect(readBoardStop(mock.f.scope)).toBeUndefined()
  })
  it('keeps the exact accepted Stop receipt visible when the following current-state read fails', async () => {
    const mock = fixture(), user = userEvent.setup(); mock.state.failStatusAfterStop = true
    await mount(mock)
    await user.click(screen.getByRole('button', { name: 'Stop this Run' }))
    await screen.findByText(/Current Run state is unavailable:/)
    expect(writes(mock, '/stop')).toHaveLength(1)
    expect(readBoardStop(mock.f.scope)?.receipt?.status).toBe('accepted')
    expect(screen.getByText(/Stop receipt: accepted/)).toBeInTheDocument()
  })
  it('does not clear a not-owner Stop or label it native settlement', async () => {
    const mock = fixture(), user = userEvent.setup(); mock.state.stopStatus = 'not_owner'
    await mount(mock); await user.click(screen.getByRole('button', { name: 'Stop this Run' }))
    await screen.findByText(/This backend did not prove ownership/)
    expect(readBoardStop(mock.f.scope)?.receipt?.status).toBe('not_owner')
    expect(screen.queryByRole('button', { name: 'Verify cleanup settlement' })).not.toBeInTheDocument()
  })
  it('disables commands for read-only grants, including a runs:resume grant without a capability', async () => {
    const mock = fixture('failed'); mock.state.access.principal.grants[0]!.actions = ['runs:read', 'runs:resume', 'interactions:read']
    await mount(mock)
    expect(screen.getByRole('button', { name: 'Stop this Run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review new full Run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Resume execution — unavailable' })).toBeDisabled()
    expect(mock.state.requests.filter((request) => request.method === 'POST')).toEqual([])
  })
  it('does not let a run-scoped Start grant create a different Run', async () => {
    const mock = fixture('failed'); mock.state.access.principal.grants[0]!.scope.runIds = [mock.f.run.id]
    await mount(mock)
    expect(screen.getByRole('button', { name: 'Review new full Run' })).toBeDisabled()
    expect(screen.getByText(/A grant limited to this Run cannot create a new Run/)).toBeInTheDocument()
  })
  it.each(['failed', 'canceled'] as const)('keeps %s cleanup-pending unavailable for a new full Run', async (outcome) => {
    const mock = fixture(outcome); mock.state.cleanupPending = true
    await mount(mock)
    expect(screen.getByRole('button', { name: 'Review new full Run' })).toBeDisabled()
    expect(screen.getByText(/Cleanup is pending\. A new full Run is unavailable/)).toBeInTheDocument()
  })
  it.each(['failed', 'canceled'] as const)('starts a NEW full Run for settled %s despite unavailable aggregate history, using exact input and fresh pins', async (outcome) => {
    const mock = fixture(outcome), user = userEvent.setup(), old = structuredClone(mock.state.run)
    await mount(mock)
    await user.click(screen.getByRole('button', { name: 'Review new full Run' }))
    await screen.findByRole('heading', { name: 'Confirm a new full Run' })
    expect(writes(mock, '/runs')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Start new full Run' }))
    const accepted = await screen.findByText(/Accepted Run/)
    expect(accepted).toHaveTextContent(`Accepted Run ${mock.f.run.id}-new, saved version ${old.workflowVersionId}.`)
    const sent = RunStartV3InputSchema.parse(writes(mock, '/runs')[0]!.body)
    expect(sent).toMatchObject({ workspaceId: mock.f.scope.workspaceId, workflowId: mock.f.scope.workflowId,
      workflowVersionId: old.workflowVersionId, input: old.input, executionSemanticsVersion: 3,
      expectedWorkflowRevision: 7, expectedLocationRevision: 9, expectedAgentConfigurationVersionIds: mock.f.version.agentConfigurationVersionIds })
    expect(sent).not.toHaveProperty('draftId'); expect(sent).not.toHaveProperty('repeat')
    expect(mock.state.run).toEqual(old)
    expect(mock.state.requests.filter((call) => call.path === `${mock.runPath}/record`)).toHaveLength(2)
    expect(mock.state.requests.some((call) => call.path === mock.runPath)).toBe(false)
    expect(readBoardStart(nextDraftKey(mock.f.scope.workspaceId, mock.f.scope.workflowId))).toBeUndefined()
  })
  it('explains unavailable historical-version retry rather than substituting the current head', async () => {
    const mock = fixture('failed'), user = userEvent.setup(); mock.state.currentVersionId = 'newer-saved-version'
    await mount(mock); await user.click(screen.getByRole('button', { name: 'Review new full Run' }))
    await screen.findByText(/Retrying this older saved version is unavailable/)
    expect(writes(mock, '/runs')).toEqual([])
  })
  it('rejects stale fresh pins between review and confirm with no Start', async () => {
    const mock = fixture('failed'), user = userEvent.setup()
    await mount(mock); await user.click(screen.getByRole('button', { name: 'Review new full Run' }))
    await screen.findByRole('heading', { name: 'Confirm a new full Run' })
    mock.state.locationRevision++
    await user.click(screen.getByRole('button', { name: 'Start new full Run' }))
    await screen.findByText(/Start pins or execution folder changed after review/)
    expect(writes(mock, '/runs')).toEqual([])
  })
  it('returns keyboard focus on Cancel and does not Start', async () => {
    const mock = fixture('failed'), user = userEvent.setup()
    await mount(mock); const review = screen.getByRole('button', { name: 'Review new full Run' })
    await user.click(review)
    const heading = await screen.findByRole('heading', { name: 'Confirm a new full Run' })
    await waitFor(() => expect(heading).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(review).toHaveFocus())
    expect(writes(mock, '/runs')).toEqual([])
  })
  it('reconciles an uncertain Start with the exact retained original pins, never a fresh command', async () => {
    const mock = fixture('failed'), user = userEvent.setup()
    const request = RunStartV3InputSchema.parse({ workspaceId: mock.f.scope.workspaceId, workflowId: mock.f.scope.workflowId,
      workflowVersionId: mock.f.version.id, executionSemanticsVersion: 3, commandId: 'retained-start-command',
      expectedWorkflowRevision: 2, expectedLocationRevision: 4, expectedAgentConfigurationVersionIds: mock.f.version.agentConfigurationVersionIds, input: { original: true } })
    await reserveBoardStart(nextDraftKey(mock.f.scope.workspaceId, mock.f.scope.workflowId), request)
    await mount(mock)
    expect(screen.getByRole('button', { name: 'Review new full Run' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reconcile retained Start' }))
    const accepted = await screen.findByText(/Accepted Run/)
    expect(accepted).toHaveTextContent(`Accepted Run ${mock.f.run.id}-new, saved version ${mock.f.version.id}.`)
    expect(writes(mock, '/runs').map((call) => call.body)).toEqual([request])
    expect(mock.state.requests.some((call) => call.path === mock.workflowPath || call.path.endsWith('/version'))).toBe(false)
  })
  it('keeps a failed Start response in the existing outbox and disables replacement Start', async () => {
    const mock = fixture('failed'), user = userEvent.setup(); mock.state.startFailures = 1
    await mount(mock); await user.click(screen.getByRole('button', { name: 'Review new full Run' }))
    await screen.findByRole('heading', { name: 'Confirm a new full Run' })
    await user.click(screen.getByRole('button', { name: 'Start new full Run' }))
    await screen.findByText(/New Start is not confirmed/)
    const retained = readBoardStart(nextDraftKey(mock.f.scope.workspaceId, mock.f.scope.workflowId))!
    expect(retained).toEqual(writes(mock, '/runs')[0]!.body)
    await user.click(screen.getByRole('button', { name: 'Reconcile retained Start' }))
    const reconciled = await screen.findByText(/Reconciled Run/)
    expect(reconciled).toHaveTextContent(`Reconciled Run ${mock.f.run.id}-new, saved version ${mock.f.version.id}.`)
    expect(writes(mock, '/runs').map((call) => call.body)).toEqual([retained, retained])
  })
  it('uses the human Run-filtered inbox and exact revision, with decision distinct from native acknowledgement', async () => {
    const mock = fixture(), user = userEvent.setup()
    mock.state.run = WorkflowRunV3Schema.parse({ ...mock.state.run, executionState: 'waiting' })
    await mount(mock); await openApproval(user, mock)
    await user.click(screen.getByRole('button', { name: approveOption(mock).label }))
    await screen.findByText(/Human decision recorded\. Approval response is not native acknowledgement/)
    expect(writes(mock, '/respond')[0]!.path).toBe(`/api/user/interactions/${mock.state.interactions[0]!.id}/respond`)
    expect(writes(mock, '/respond')[0]!.body).toEqual({ interactionId: mock.state.interactions[0]!.id,
      optionId: approveOption(mock).optionId, expectedRevision: 0 })
    const list = mock.state.requests.find((call) => call.path.startsWith('/api/user/interactions?'))!
    const query = new URL(list.path, 'http://localhost').searchParams
    expect(query.get('runId')).toBe(mock.f.scope.runId); expect(query.get('limit')).toBe('10')
    expect(screen.getAllByText(/Native delivery is uncertain/).length).toBeGreaterThan(0)
  })
  it('retains an uncertain approval tuple and only reconciles that same option and revision', async () => {
    const mock = fixture(), user = userEvent.setup(); mock.state.approvalFailures = 1
    await mount(mock); await openApproval(user, mock)
    await user.click(screen.getByRole('button', { name: approveOption(mock).label }))
    await screen.findByText(/Approval response is not confirmed/)
    expect(screen.getByRole('button', { name: otherOption(mock).label })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reconcile same approval response' }))
    await screen.findByText(/Human decision recorded/)
    const calls = writes(mock, '/respond'); expect(calls).toHaveLength(2); expect(calls[0]!.body).toEqual(calls[1]!.body)
  })
  it('honors the human service canRespond=false and sends no response', async () => {
    const mock = fixture(), user = userEvent.setup(); mock.state.canRespond = false
    await mount(mock); await openApproval(user, mock)
    expect(screen.getByRole('button', { name: approveOption(mock).label })).toBeDisabled()
    expect(screen.getByText(/does not permit this caller to respond/)).toBeInTheDocument()
    expect(writes(mock, '/respond')).toEqual([])
  })
  it('shows the persisted rework budget cause in status and recorded Run details', async () => {
    const mock = fixture('failed')
    const user = userEvent.setup()
    const error = {
      code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED',
      message: 'The Run reached its execution limit and cannot start more work.',
      retryable: false,
    }
    mock.state.run = WorkflowRunV3Schema.parse({ ...mock.state.run, result: { outcome: 'failed', error } })
    await mount(mock)
    const status = screen.getByText(/Run failed:/)
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent(error.message)
    expect(status).toHaveTextContent(error.code)
    expect(mock.state.requests.some((call) => call.path === `${mock.runPath}/record`)).toBe(false)
    await user.click(screen.getByText('Failure details and execution reports'))
    await user.click(screen.getByText('Recorded Run-level result'))
    const result = await screen.findByLabelText('Exact recorded Run result')
    expect(JSON.parse(result.textContent!)).toEqual(mock.state.run.result)
  })
  it('loads exact failure reports only on explicit disclosure, and pages without polling private content', async () => {
    const mock = fixture('failed'), user = userEvent.setup()
    await mount(mock)
    await user.click(screen.getByText('Failure details and execution reports'))
    await user.click(screen.getByText('Recorded Run-level result'))
    const result = await screen.findByLabelText('Exact recorded Run result')
    expect(result).toHaveTextContent('Exact native failure')
    const records = mock.state.requests.filter((call) => call.path === `${mock.runPath}/record`).length
    expect(records).toBe(1)
    expect(mock.state.requests.some((call) => call.path === mock.runPath)).toBe(false)
    const first = mock.f.identities[0]!
    await user.click(await screen.findByText(`Execution ${first.executionId} · ${first.workflowNodeId} · attempt 1 · completed`))
    await screen.findByLabelText(`Reported result ${first.executionId}`)
    expect(screen.getByText(/No successful predecessor result was accepted/)).toBeInTheDocument()
    expect(screen.getByText(/diagnostic information, not a permission or capability to retry this node/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next execution page' }))
    await screen.findByText(`Execution ${mock.f.identities[1]!.executionId} · ${mock.f.identities[1]!.workflowNodeId} · attempt 1 · completed`)
    expect(screen.queryByLabelText(`Reported result ${first.executionId}`)).not.toBeInTheDocument()
    const reports = mock.state.requests.filter((call) => call.path.includes(`/executions/${first.executionId}`)).length
    await user.click(screen.getByRole('button', { name: 'Refresh / reconnect client state' })); await flush()
    expect(mock.state.requests.filter((call) => call.path.includes(`/executions/${first.executionId}`))).toHaveLength(reports)
    expect(mock.state.requests.filter((call) => call.path === `${mock.runPath}/record`)).toHaveLength(records)
  })
  it('describes an ordinary saved workflow without inventing business-repeat rounds', async () => {
    const mock = fixture('failed'), user = userEvent.setup()
    await mount(mock); await user.click(screen.getByText('Saved business-repetition policy'))
    await screen.findByText(/No business repeat is configured in this saved version/)
    expect(mock.f.version.definition).not.toHaveProperty('repeat')
    expect(mock.state.requests.filter((call) => call.method === 'POST')).toEqual([])
  })
  it('rejects a valid-shaped response for another Run before displaying contextual controls', async () => {
    const mock = fixture()
    mock.handlers.unshift(http.get(`*${mock.runPath}/executions`, () => HttpResponse.json({
      run: { ...mock.metadata(), runId: 'another-run' }, items: [], pageInfo: { nextCursor: null },
    })))
    await mount(mock, false, false)
    await screen.findByText(/response does not belong to the selected Run and immutable version/)
    expect(screen.queryByRole('button', { name: 'Stop this Run' })).not.toBeInTheDocument()
    expect(mock.state.requests.filter((call) => call.method === 'POST')).toEqual([])
  })
  it('rejects a foreign Run interaction even when the human list response is schema-valid', async () => {
    const mock = fixture(), user = userEvent.setup()
    mock.state.interactions[0]!.runId = 'foreign-run'
    await mount(mock); await user.click(screen.getByText('Human approvals for this Run'))
    await screen.findByText(/human approval belongs to a different Run/)
    expect(screen.queryByRole('button', { name: approveOption(mock).label })).not.toBeInTheDocument()
    expect(writes(mock, '/respond')).toEqual([])
  })
  it('rechecks revoked Stop grants immediately before dispatch and sends no command', async () => {
    const mock = fixture(), user = userEvent.setup()
    await mount(mock)
    mock.state.access.principal.grants[0]!.actions = ['runs:read']
    await user.click(screen.getByRole('button', { name: 'Stop this Run' }))
    await screen.findByText(/runs:stop permission is unavailable for this exact scope/)
    expect(writes(mock, '/stop')).toEqual([])
    expect(readBoardStop(mock.f.scope)).toBeUndefined()
  })
  it('keeps native Start and Stop unavailable when capabilities are false', async () => {
    const mock = fixture('failed')
    mock.state.capabilities = CurrentWorkflowCapabilitiesSchema.parse(CURRENT_WORKFLOW_CAPABILITIES)
    await mount(mock)
    expect(screen.getByRole('button', { name: 'Stop this Run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review new full Run' })).toBeDisabled()
    expect(mock.state.requests.filter((call) => call.method === 'POST')).toEqual([])
  })
  it('does not turn an interrupted Run into a supported manual Resume or full retry', async () => {
    const mock = fixture()
    mock.state.run = WorkflowRunV3Schema.parse({ ...mock.state.run, executionState: 'interrupted' })
    await mount(mock)
    expect(screen.getByRole('button', { name: 'Resume execution — unavailable' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review new full Run' })).toBeDisabled()
    expect(mock.state.requests.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('keeps automatic current-state refresh at limit=1 without loading history or private reports', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const mock = fixture()
    await mount(mock)
    const before = mock.state.requests.filter((call) => call.path.endsWith('/executions?limit=1')).length
    await act(async () => { vi.advanceTimersByTime(5001) })
    await waitFor(() => expect(mock.state.requests.filter((call) => call.path.endsWith('/executions?limit=1')).length).toBeGreaterThan(before))
    expect(mock.state.requests.every((call) => !call.path.includes('/executions/') && !call.path.endsWith('/version') && !call.path.endsWith('/record') && call.path !== mock.runPath)).toBe(true)
  })
  it('hides prior actionable state when synchronization is denied, without sending a command', async () => {
    const mock = fixture(), user = userEvent.setup()
    await mount(mock)
    server.use(http.get(`*${mock.runPath}/executions`, () => HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Run read was revoked' } }, { status: 403 })))
    await user.click(screen.getByRole('button', { name: 'Refresh / reconnect client state' }))
    await screen.findByText(/Synchronization failed: Run read was revoked/)
    expect(screen.queryByRole('button', { name: 'Stop this Run' })).not.toBeInTheDocument()
    expect(mock.state.requests.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('hides a reviewed private Start payload after denial while retaining the exact outbox command', async () => {
    const mock = fixture('failed'), user = userEvent.setup()
    await mount(mock)
    await user.click(screen.getByRole('button', { name: 'Review new full Run' }))
    await screen.findByRole('heading', { name: 'Confirm a new full Run' })
    server.use(http.post(`*${mock.workflowPath}/runs`, () => HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Admission was denied' } }, { status: 403 })))
    await user.click(screen.getByRole('button', { name: 'Start new full Run' }))
    await screen.findByText(/New Start is not confirmed: Admission was denied/)
    expect(screen.queryByRole('heading', { name: 'Confirm a new full Run' })).not.toBeInTheDocument()
    expect(screen.queryByText('Exact input and configuration pins to send')).not.toBeInTheDocument()
    expect(readBoardStart(nextDraftKey(mock.f.scope.workspaceId, mock.f.scope.workflowId))?.workflowVersionId).toBe(mock.f.version.id)
    expect(screen.getByRole('button', { name: 'Review new full Run' })).toBeDisabled()
  })

  it.each(['id', 'workflowVersionId'] as const)('rejects foreign record %s for both result disclosure and full-Run preflight', async (pin) => {
    const mock = fixture('failed')
    server.use(...mock.handlers)
    server.use(http.get(`*${mock.runPath}/record`, () => HttpResponse.json({
      run: { ...mock.state.run, [pin]: 'foreign-pin' }, stopRequested: false, cleanupPending: false,
    })))
    await expect(runActionsClient.runResult(mock.f.scope)).rejects.toThrow(/selected Run and immutable version/)
    await expect(prepareNewFullRun(mock.f.scope, 'record-pin-test')).rejects.toThrow(/selected Run and immutable version/)
    await flush()
    expect(writes(mock, '/runs')).toEqual([])
    expect(mock.state.requests.some((call) => call.path === mock.runPath)).toBe(false)
  })

  it.each(['cleanupPending', 'stopRequested'] as const)('rejects a record with missing persisted %s instead of assuming settlement', async (missing) => {
    const mock = fixture('failed')
    server.use(...mock.handlers)
    const payload: Record<string, unknown> = { run: mock.state.run, stopRequested: false, cleanupPending: false }
    delete payload[missing]
    server.use(http.get(`*${mock.runPath}/record`, () => HttpResponse.json(payload)))
    await expect(runActionsClient.runResult(mock.f.scope)).rejects.toThrow()
    await expect(prepareNewFullRun(mock.f.scope, 'missing-cleanup-test')).rejects.toThrow()
    await flush()
    expect(writes(mock, '/runs')).toEqual([])
    expect(mock.state.requests.some((call) => call.path === mock.runPath)).toBe(false)
  })

  it.each([403, 409])('does not fall back to aggregate detail when the Run-only read fails with %i', async (status) => {
    const mock = fixture('failed')
    server.use(...mock.handlers)
    const code = status === 403 ? 'ACCESS_DENIED' : 'RUN_INSPECTION_TOO_LARGE'
    server.use(http.get(`*${mock.runPath}/record`, () => HttpResponse.json({ error: { code, message: 'Exact Run record unavailable' } }, { status })))
    await expect(runActionsClient.runResult(mock.f.scope)).rejects.toThrow('Exact Run record unavailable')
    await expect(prepareNewFullRun(mock.f.scope, 'no-fallback-test')).rejects.toThrow('Exact Run record unavailable')
    await flush()
    expect(writes(mock, '/runs')).toEqual([])
    expect(mock.state.requests.some((call) => call.path === mock.runPath)).toBe(false)
  })

})
