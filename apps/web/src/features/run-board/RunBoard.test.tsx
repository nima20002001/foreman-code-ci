import { useEffect, useLayoutEffect, useState } from 'react'
import { URL } from 'node:url'
import { webcrypto } from 'node:crypto'
import { makeCurrentWorkflowFixture, RunExecutionDetailSchema, RunVersionDetailSchema } from '@foreman-code/contracts/wave25'
import * as inspectionClient from '../workflow-board/runDetailsClient'
import { digestCurrentValue } from '../workflow-board/runDetailsClient'
import { definition, execution as jobExecution, verificationExecution, logPage } from '../jobs/fixtures'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useLocation } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { RunBoardSnapshotGetResult } from '@foreman-code/contracts/run-snapshots'
import { server } from '../../mocks/server'
import { runsSelectorApi } from '../runs-selector/client'
import { runsSelectorKeys } from '../runs-selector/query'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { useSelectedRun, type SelectedRunState } from '../runs-selector/useSelectedRun'
import { RunBoardSlot } from './RunBoardSlot'
import { reply, runA, runB, runsUrl, scope } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'
import { deferred } from '../../test/deferred'

const snapshotRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot'
const clients: QueryClient[] = []
const releases: (() => void)[] = []
const editorMounted = vi.fn(), editorUnmounted = vi.fn(), authoringShortcut = vi.fn()
let latest: SelectedRunState | undefined
let unexpected: string[] = []

/** A persistent editor owner with both a local geometry buffer and uncontrolled
 * text. Tests the slot's lifetime contract without booting the whole authoring
 * service/Run inspector. No production editor or React Flow module is mocked.
 */
function EditorProbe() {
  const [x, setX] = useState(901)
  useEffect(() => { editorMounted(); return () => { editorUnmounted() } }, [])
  return <section aria-label="Current editable workflow">
    <input aria-label="Draft name" defaultValue="X today" />
    <input aria-label="Buffered draft x" type="number" value={x} onChange={(event) => setX(Number(event.target.value))} />
    <button type="button">Save</button><button type="button">Start</button>
  </section>
}
function Harness() {
  const location = useLocation()
  const search = location.search as Record<string, unknown>
  const selection = useSelectedRun({ workspaceId: decodeURIComponent(location.pathname.split('/')[2]!),
    workflowId: typeof search.workflowId === 'string' ? search.workflowId : scope.workflowId })
  useLayoutEffect(() => { latest = selection }, [selection])
  return <div onKeyDown={authoringShortcut}>
    <output aria-label="Selected Run">{selection.identity.runId ?? 'current'}</output>
    <RunBoardSlot selection={selection}><EditorProbe /></RunBoardSlot>
  </div>
}
async function mount(entry = runsUrl('run-a')) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema, component: Harness })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [entry] }),
    defaultPendingMinMs: 0 })
  await router.load()
  const result = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByLabelText('Selected Run')
  await waitFor(() => expect(latest).toBeDefined())
  return { ...result, client, router }
}
async function select(runId: string | null) { await act(async () => { await latest!.selectRun(runId) }) }
function hold(result: RunBoardSnapshotGetResult) {
  const gate = deferred<void>()
  const release = () => gate.resolve()
  releases.push(release)
  return { release, response: async () => { await gate.promise; return HttpResponse.json(result) } }
}
function withoutCancellation() {
  const actual = runsSelectorApi.snapshot
  const completed: string[] = []
  vi.spyOn(runsSelectorApi, 'snapshot').mockImplementation(async (input) => {
    // Deliberately drop AbortSignal, but retain the real HTTP client and schema
    // checks. A passing race test must not depend solely on transport abort.
    const result = await actual(input)
    completed.push(input.runId)
    return result
  })
  return completed
}
const savedNode = (name: string) => screen.findByRole('group', { name: `${name}, saved agent, read only` })
const noGraph = () => expect(screen.queryByTestId('run-board-canvas')).not.toBeInTheDocument()
const denied = (status: number) => HttpResponse.json({ error: { code: 'DENIED', message: 'Unavailable' } }, { status })

beforeEach(() => {
  latest = undefined; unexpected = []
  editorMounted.mockClear(); editorUnmounted.mockClear(); authoringShortcut.mockClear()
  installFlowLayout()
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', ({ request }) =>
      HttpResponse.json({ runId: new URL(request.url).searchParams.get('runId'), jobs: [], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
      HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })),
    http.get(snapshotRoute, ({ params }) => HttpResponse.json(reply(String(params.runId), {
      workspaceId: String(params.workspaceId), workflowId: String(params.workflowId),
    }))),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/version', ({ params }) => {
      const workspaceId = String(params.workspaceId)
      const workflowId = workspaceId === scope.workspaceId ? scope.workflowId : 'other-workflow'
      const runId = String(params.runId)
      const workflowVersionId = runId === 'run-b' ? runB.workflowVersionId : runA.workflowVersionId
      const { version } = makeCurrentWorkflowFixture('saved-run-board', 'single')
      return HttpResponse.json(RunVersionDetailSchema.parse({
        scope: { workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion: 3 },
        version: { ...version, id: workflowVersionId, workspaceId, workflowId,
          definition: { ...version.definition, id: workflowId, workspaceId } },
      }))
    }),
    http.all('*/api/*', ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`)
      return HttpResponse.json({ error: { code: 'UNEXPECTED', message: 'Only saved Run reads are allowed in this test.' } }, { status: 500 })
    }),
  )
})
afterEach(async () => {
  cleanup()
  await act(async () => { for (const release of releases.splice(0)) release() })
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
  expect(unexpected).toEqual([])
})

const inspectionRoute = '*/api/management/workspaces/:workspaceId/runs/:runId/executions'
async function inspectorApi(kind: 'agent' | 'job' = 'agent') {
  vi.stubGlobal('crypto', webcrypto)
  const nodeId = kind === 'agent' ? 'node-x' : 'build'
  const identity = kind === 'agent' ? { workflowNodeId: nodeId, agentId: 'agent-x',
    agentConfigurationVersionId: 'config-x-old', worktree: { repository: 'octo/site', branch: 'foreman/coder' } }
    : { kind: 'job', workflowNodeId: nodeId, jobDefinitionId: definition.id, jobDefinitionVersionId: definition.versionId }
  const input = { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] }
  const detail = RunExecutionDetailSchema.parse({
    run: { ...scope, runId: 'run-a', workflowVersionId: 'version-a', executionSemanticsVersion: 3,
      executionState: 'running', outcome: 'pending', createdAt: runA.capturedAt, cleanupPending: false },
    execution: { ...identity, executionId: 'node-execution', attempt: 1, state: 'running',
      createdAt: runA.capturedAt, acceptedResultAvailable: false },
    acceptedInput: { value: input, digest: await digestCurrentValue(input) }, acceptedResult: { status: 'not_accepted' },
  })
  server.use(http.get(inspectionRoute, () => HttpResponse.json({ run: detail.run, items: [detail.execution], pageInfo: { nextCursor: null } })),
    http.get(`${inspectionRoute}/:executionId`, () => HttpResponse.json(detail)),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/nodes/:nodeId/placement', ({ params }) =>
      HttpResponse.json({ ...scope, runId: String(params.runId), nodeId: String(params.nodeId),
        readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })),
    http.get('*/api/management/workspaces/:workspaceId/jobs/queue', () => HttpResponse.json({ tickets: [], nextHistoryCursor: null })),
    http.get('*/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:nodeId', () =>
      HttpResponse.json({ kind: 'unavailable', target: { ...scope, runId: 'run-a', workflowNodeId: nodeId }, reason: 'execution_missing' })))
  return detail
}

describe('selected saved Run board (real Router, Query, HTTP/MSW and canvas)', () => {
  it('shows removed agent Y, the old name, a hierarchy layout (not the saved coordinates) and every saved edge in A; B has no Y', async () => {
    const { container } = await mount()
    const y = await savedNode('Y')
    expect(y).toHaveStyle({ transform: 'translate(0px,260px)', width: '156px', height: '156px' })
    const x = await savedNode('X before rename')
    expect(x).toHaveStyle({ transform: 'translate(0px,0px)' })
    expect(x).toHaveAttribute('title', expect.stringContaining('config-x-old'))
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(3))
    const handoff = container.querySelector('.react-flow__edge[data-id="edge-xy"]')!
    const approval = container.querySelector('.react-flow__edge[data-id="approval-xy"]')!
    expect(handoff).toHaveAttribute('aria-label', 'Handoff from X before rename to Y: Old handoff, read only')
    expect(approval.querySelector('.n-signal-edge')).toHaveAttribute('data-kind', 'approval')
    expect(handoff.querySelector('path.n-signal-edge-base')?.getAttribute('d'))
      .not.toBe(approval.querySelector('path.n-signal-edge-base')?.getAttribute('d'))

    await select('run-b')
    expect(await savedNode('X in B')).toHaveStyle({ transform: 'translate(0px,0px)' })
    expect(screen.queryByRole('group', { name: 'Y, saved agent, read only' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'X before rename, saved agent, read only' })).not.toBeInTheDocument()
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1))
    expect(container.querySelector('.react-flow__edge')).toHaveAttribute('data-id', 'edge-xz')
  })

  it('clears the rendered A graph immediately while B is loading', async () => {
    await mount(); await savedNode('Y')
    const b = hold(reply('run-b'))
    server.use(http.get(snapshotRoute, () => b.response()))
    await select('run-b')
    const board = screen.getByRole('region', { name: 'Selected Run board' })
    expect(within(board).getByRole('status')).toHaveTextContent('Loading…')
    expect(board).toHaveAttribute('aria-busy', 'true')
    noGraph()
    expect(screen.queryByRole('region', { name: 'Current editable workflow' })).not.toBeInTheDocument()
    b.release()
    await savedNode('X in B')
  })

  it('ignores a late A response while B is selected even when the transport does not abort', async () => {
    const completed = withoutCancellation()
    const a = hold(reply('run-a'))
    let requestedA = false
    server.use(http.get(snapshotRoute, ({ params }) => {
      if (params.runId === 'run-a') { requestedA = true; return a.response() }
      return HttpResponse.json(reply('run-b'))
    }))
    await mount(); await waitFor(() => expect(requestedA).toBe(true))
    const firstA = latest!.capture()
    await select('run-b'); await savedNode('X in B')
    a.release()
    await waitFor(() => expect(completed).toContain('run-a'))
    expect(latest!.isCurrent(firstA)).toBe(false)
    expect(screen.queryByRole('group', { name: 'Y, saved agent, read only' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', 'run-b')
    expect(await savedNode('X in B')).toBeInTheDocument()
  })

  it('fences the first A and B during rapid A -> B -> A, waiting for the new A visit', async () => {
    const completed = withoutCancellation()
    const first = hold(reply('run-a')), b = hold(reply('run-b')), second = hold(reply('run-a'))
    const seen: string[] = []
    server.use(http.get(snapshotRoute, ({ params }) => {
      const id = String(params.runId)
      seen.push(id)
      return id === 'run-b' ? b.response() : seen.filter((item) => item === 'run-a').length === 1 ? first.response() : second.response()
    }))
    await mount(); await waitFor(() => expect(seen).toEqual(['run-a']))
    const ticket = latest!.capture()
    await select('run-b'); await waitFor(() => expect(seen).toEqual(['run-a', 'run-b']))
    await select('run-a'); await waitFor(() => expect(seen).toEqual(['run-a', 'run-b', 'run-a']))
    expect(latest!.generation.id).not.toBe(ticket.id)
    expect(latest!.isCurrent(ticket)).toBe(false)
    b.release(); first.release()
    await waitFor(() => expect(completed).toHaveLength(2))
    noGraph()
    expect(within(screen.getByRole('region', { name: 'Selected Run board' })).getByRole('status')).toHaveTextContent('Loading…')
    second.release()
    await savedNode('Y')
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-generation', latest!.generation.id)
    expect(screen.queryByRole('group', { name: 'X in B, saved agent, read only' })).not.toBeInTheDocument()
  })

  it('renders one short unavailable line for a legacy Run, never today’s graph', async () => {
    await mount(runsUrl('legacy'))
    expect(await screen.findByText('Snapshot unavailable')).toBeInTheDocument()
    noGraph()
    const region = screen.getByRole('region', { name: 'Selected Run board' })
    expect(region).toHaveTextContent(/^Snapshot unavailable$/)
    expect(screen.queryByRole('region', { name: 'Current editable workflow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  })

  it('retains the same editor instance, unsaved text and buffered geometry across history and back/forward', async () => {
    const { router } = await mount(runsUrl(null))
    noGraph()
    const name = screen.getByRole('textbox', { name: 'Draft name' })
    const x = screen.getByRole('spinbutton', { name: 'Buffered draft x' })
    fireEvent.change(name, { target: { value: 'Unsaved title' } })
    fireEvent.change(x, { target: { value: '1234' } })
    await select('run-a'); await savedNode('Y')
    expect(name.closest('.run-board-current')).toHaveAttribute('hidden')
    expect(name.closest('.run-board-current')).toHaveAttribute('inert')
    expect(editorMounted).toHaveBeenCalledTimes(1)
    expect(editorUnmounted).not.toHaveBeenCalled()
    await select('run-b'); await savedNode('X in B')
    await select('legacy'); await screen.findByText('Snapshot unavailable')
    await select(null)
    expect(screen.getByRole('textbox', { name: 'Draft name' })).toBe(name)
    expect(name).toHaveValue('Unsaved title')
    expect(screen.getByRole('spinbutton', { name: 'Buffered draft x' })).toBe(x)
    expect(x).toHaveValue(1234)
    expect(editorUnmounted).not.toHaveBeenCalled()
    await act(async () => { router.history.back() })
    await screen.findByText('Snapshot unavailable')
    await act(async () => { router.history.forward() })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Draft name' })).toBe(name))
    expect(name).toHaveValue('Unsaved title')
    expect(x).toHaveValue(1234)
  })

  it.each([401, 403, 404])('removes a previously loaded graph after a %s read denial', async (status) => {
    const { client } = await mount(); await savedNode('Y')
    server.use(http.get(snapshotRoute, () => denied(status)))
    await act(async () => { await client.refetchQueries({ queryKey: runsSelectorKeys.snapshot(latest!) }) })
    await screen.findByText(status === 401 ? 'Access unavailable' : status === 403 ? 'No access' : 'Run not found')
    noGraph()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  })

  it('fails closed on a mixed-scope snapshot response instead of rendering it', async () => {
    server.use(http.get(snapshotRoute, () => HttpResponse.json(reply('run-a', { ...scope, workspaceId: 'other-workspace' }))))
    await mount(); await screen.findByText('Load failed')
    noGraph()
    expect(latest!.identity).toEqual({ ...scope, runId: 'run-a' })
  })

  it('uses the new scope and a fresh generation even when both workflows have the same Run id', async () => {
    const { router } = await mount(); await savedNode('Y')
    const pending = hold(reply('run-a', { workspaceId: 'other-workspace', workflowId: 'other-workflow' }))
    server.use(http.get(snapshotRoute, () => pending.response()))
    await act(async () => { await router.navigate({ href: runsUrl('run-a', { workspaceId: 'other-workspace', workflowId: 'other-workflow' }) }) })
    noGraph()
    expect(latest!.identity.workspaceId).toBe('other-workspace')
    pending.release()
    await savedNode('Y')
  })

  it('has only view controls at 320px; keyboard/drag cannot edit, delete, save or Start', async () => {
    const frozenBefore = JSON.stringify(runA)
    const { container } = await mount(); const y = await savedNode('Y')
    const canvas = screen.getByTestId('run-board-canvas')
    expect(canvas.getBoundingClientRect().width).toBe(320)
    expect(screen.queryByRole('button', { name: /Start|Save|Settings|Chat|interactive/i })).not.toBeInTheDocument()
    const controls = container.querySelector('.react-flow__controls')!
    expect(within(controls as HTMLElement).getAllByRole('button')).toHaveLength(3)
    expect(container.querySelector('.react-flow__controls-interactive')).not.toBeInTheDocument()
    expect(y).not.toHaveClass('draggable')
    expect(y.querySelector('.run-board-node-visual')).toHaveAttribute('inert')
    for (const key of ['ArrowRight', 'Delete', 'Backspace', 'Enter', ' ']) fireEvent.keyDown(y, { key })
    fireEvent.keyDown(y, { key: 's', ctrlKey: true })
    const down = new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100, buttons: 1, button: 0 })
    Object.defineProperty(down, 'view', { value: y.ownerDocument.defaultView })
    fireEvent(y, down)
    fireEvent.mouseMove(window, { clientX: 240, clientY: 230, buttons: 1 })
    const up = new MouseEvent('mouseup', { bubbles: true })
    Object.defineProperty(up, 'view', { value: y.ownerDocument.defaultView })
    fireEvent(window, up)
    expect(y).toHaveStyle({ transform: 'translate(0px,260px)' })
    expect(authoringShortcut).not.toHaveBeenCalled()
    expect(JSON.stringify(runA)).toBe(frozenBefore)
    await userEvent.click(within(controls as HTMLElement).getAllByRole('button')[2]!)
    expect(await savedNode('Y')).toBe(y)
    expect(container.querySelector('.react-flow__viewport')?.getAttribute('style')).not.toMatch(/NaN|Infinity/)
  })

  it('does not manufacture nodes for a valid empty snapshot', async () => {
    server.use(http.get(snapshotRoute, () => HttpResponse.json({ snapshot: { ...runB, runId: 'run-a', nodes: [], edges: [] } })))
    await mount(); await screen.findByText('No nodes')
    noGraph()
  })
})

it('opens accepted branch and execution facts from an Agent on the standard selected-Run board', async () => {
  await inspectorApi()
  const { router } = await mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X before rename' }))
  const inspector = await screen.findByRole('region', { name: 'Run node inspector: X before rename' })
  expect(await within(inspector).findByText('foreman/coder')).toBeInTheDocument()
  expect(router.history.location.search).toContain('runNodeId=node-x')
  expect(screen.queryByRole('button', { name: /Save|Start|Request cancellation/ })).toBeNull()
})

it('shows the server message and code when a saved execution result cannot be read', async () => {
  await inspectorApi()
  const error = { code: 'REPEAT_INPUT_NOT_ACCEPTED',
    message: 'The repeat operation conflicts with its pinned durable evidence.' }
  server.use(http.get(`${inspectionRoute}/:executionId`, () => HttpResponse.json({ error }, { status: 409 })))
  await mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X before rename' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Attempt 1 · node-execution' }))
  const inspector = await screen.findByRole('region', { name: 'Run node inspector: X before rename' })
  expect(await within(inspector).findByText(`Execution result unavailable. ${error.message}`)).toBeInTheDocument()
  expect(within(inspector).getByText(error.code)).toBeInTheDocument()
})

it('shows an Agent active-time timeout in the Run inspector without expanding raw results', async () => {
  const detail = await inspectorApi()
  const failure = { code: 'EXECUTION_ACTIVE_TIMEOUT',
    message: 'The execution exhausted its active-time budget.', retryable: false }
  server.use(http.get(inspectionRoute, () => HttpResponse.json({
    run: { ...detail.run, executionState: 'completed', outcome: 'failed', failure },
    items: [{ ...detail.execution, state: 'completed', failure }], pageInfo: { nextCursor: null },
  })))
  await mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X before rename' }))
  const inspector = await screen.findByRole('region', { name: 'Run node inspector: X before rename' })
  expect(await within(inspector).findByText(/Agent failed: The execution exhausted its active-time budget/))
    .toBeInTheDocument()
  expect(within(inspector).getAllByText('EXECUTION_ACTIVE_TIMEOUT')).toHaveLength(2)
})

it('opens job-node logs, artifacts and verification through the persisted relationship without historical editing controls', async () => {
  const detail = await inspectorApi('job')
  const snapshot = { ...runA, nodes: [{ kind: 'job', id: 'build', name: 'Build',
    jobDefinitionId: definition.id, jobDefinitionRevision: definition.revision, jobDefinitionVersionId: definition.versionId,
    position: { x: 0, y: 0 }, size: { width: 200, height: 160 } }], edges: [] }
  const workflow = { workflowId: scope.workflowId, runId: 'run-a', nodeId: 'build', nodeExecutionId: 'node-execution' }
  const jobsRoot = '*/api/management/workspaces/:workspaceId/jobs/executions/:id'
  server.use(http.get(snapshotRoute, () => HttpResponse.json({ snapshot })),
    http.get('*/api/management/workspaces/:workspaceId/jobs/workflow-executions/:runId/:nodeExecutionId', () =>
      HttpResponse.json({ reference: { kind: 'job', ...scope, workflowVersionId: 'version-a', ...workflow,
        jobExecutionId: jobExecution.id, occurrenceId: null, occurrenceIndex: 0 } })),
    http.get(jobsRoot, () => HttpResponse.json({ execution: { ...verificationExecution, workspaceId: scope.workspaceId,
      workflow, process: { phase: 'running', outcome: null, exitCode: null, signal: null, processStopped: false } } })),
    http.get(`${jobsRoot}/logs`, () => HttpResponse.json(logPage)),
    http.get(`${jobsRoot}/artifacts`, () => HttpResponse.json({ artifacts: [] })))
  const { router } = await mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect Build' }))
  await userEvent.click(await screen.findByRole('button', { name: /Attempt 1 · node-execution/ }))
  expect(await screen.findByRole('region', { name: 'Job logs' })).toBeInTheDocument()
  expect(await screen.findByRole('region', { name: 'Job artifacts' })).toBeInTheDocument()
  expect(await screen.findByRole('region', { name: 'Verification result' })).toBeInTheDocument()
  expect(router.history.location.search).toContain('runExchangeKey')
  expect(screen.queryByRole('button', { name: /Save|Start|Request cancellation|Review rerun/ })).toBeNull()
  expect(detail.execution.executionId).not.toBe(jobExecution.id)
})

it('fences delayed inspector reads across Run A, Run B and a new Run A visit', async () => {
  const detail = await inspectorApi()
  const actual = inspectionClient.readRunExecutions
  const completed: string[] = []
  vi.spyOn(inspectionClient, 'readRunExecutions').mockImplementation(async (scope, filters, cursor) => {
    const value = await actual(scope, filters, cursor)
    completed.push(scope.runId)
    return value
  })
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
  let reads = 0
  server.use(http.get(inspectionRoute, async ({ params }) => {
    const index = reads++
    if (index < gates.length) await gates[index]!.promise
    const runId = String(params.runId)
    return HttpResponse.json({ run: { ...detail.run, runId, workflowVersionId: runId === 'run-b' ? 'version-b' : 'version-a' },
      items: [{ ...detail.execution, agentConfigurationVersionId: runId === 'run-b' ? 'config-x-b' : 'config-x-old' }],
      pageInfo: { nextCursor: null } })
  }))
  releases.push(...gates.map(gate => () => gate.resolve()))
  await mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X before rename' }))
  await waitFor(() => expect(reads).toBe(1))
  await select('run-b')
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X in B' }))
  await waitFor(() => expect(reads).toBe(2))
  await select('run-a')
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X before rename' }))
  await waitFor(() => expect(reads).toBe(3))
  await act(async () => { gates[0]!.resolve(); gates[1]!.resolve() })
  await waitFor(() => expect(completed).toHaveLength(2))
  expect(screen.queryByText('foreman/coder')).toBeNull()
  expect(screen.getByText('Reading node executions…')).toBeInTheDocument()
  await act(async () => gates[2]!.resolve())
  expect(await screen.findByText('foreman/coder')).toBeInTheDocument()
})

it('returns to the first node execution page after six pages while retaining the selected result', async () => {
  const detail = await inspectorApi()
  const occurrence = (index: number) => ({
    scope: { ...scope, runId: 'run-a', workflowVersionId: 'version-a', executionSemanticsVersion: 3 as const },
    blockId: 'finite-repeat', occurrenceId: `occurrence-${index}`, occurrenceIndex: index,
  })
  const input = { ...detail.acceptedInput.value, occurrence: { contractVersion: 1 as const,
    identity: occurrence(1), input: { bindingId: 'input-1', inputDigest: `sha256:${'1'.repeat(64)}`, previous: null } } }
  const result = { outcome: 'succeeded' as const, output: { text: 'Saved first occurrence result' } }
  const completed = RunExecutionDetailSchema.parse({ ...detail,
    execution: { ...detail.execution, state: 'completed', occurrence: occurrence(1),
      acceptedResultAvailable: true, finishedAt: runA.capturedAt },
    acceptedInput: { value: input, digest: await digestCurrentValue(input) },
    acceptedResult: { status: 'accepted', value: result, digest: await digestCurrentValue(result) },
  })
  const cursors: (string | null)[] = []
  const ciRunIds: (string | null)[] = []
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', ({ request }) => {
    const runId = new URL(request.url).searchParams.get('runId')
    ciRunIds.push(runId)
    return HttpResponse.json({ runId, jobs: [], truncated: false })
  }), http.get(`${inspectionRoute}/:executionId`, () => HttpResponse.json(completed)),
    http.get(inspectionRoute, ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor')
    cursors.push(cursor)
    const pageIndex = cursor === null ? 0 : Number(cursor)
    const items = Array.from({ length: 25 }, (_, index) => ({ ...completed.execution,
      executionId: pageIndex === 0 && index === 0 ? 'node-execution' : `execution-${pageIndex * 25 + index + 1}`,
      occurrence: occurrence(pageIndex * 25 + index + 1),
    }))
    return HttpResponse.json({ run: detail.run, items,
      pageInfo: { nextCursor: pageIndex < 5 ? String(pageIndex + 1) : null } })
  }))
  await mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X before rename' }))
  const inspector = within(await screen.findByRole('region', { name: 'Run node inspector: X before rename' }))
  const buttonText = (label: string) => (_content: string, element: Element | null) => element?.textContent === label
  await userEvent.click(await inspector.findByText(buttonText('Attempt 1 · node-execution'), { selector: 'button' }))
  expect(await inspector.findByLabelText('Execution node-execution')).toBeInTheDocument()
  const hostCi = within(inspector.getByRole('region', { name: 'Agent CI results' }))
  expect(await hostCi.findByText('No CI jobs in this Run yet')).toBeVisible()
  expect(new Set(ciRunIds)).toEqual(new Set(['run-a']))
  expect(hostCi.queryByText(/CI history unavailable/)).not.toBeInTheDocument()
  for (let pageIndex = 1; pageIndex <= 5; pageIndex++) {
    await userEvent.click(inspector.getByText(buttonText('Load more executions'), { selector: 'button' }))
    const lastAttempt = `Attempt 1 · execution-${pageIndex * 25 + 25}`
    expect(await inspector.findByText(buttonText(lastAttempt), { selector: 'button' })).toHaveAccessibleName(lastAttempt)
  }
  expect(inspector.queryByText(buttonText('Attempt 1 · node-execution'), { selector: 'button' })).not.toBeInTheDocument()
  expect(cursors.slice(0, 6)).toEqual([null, '1', '2', '3', '4', '5'])
  expect(inspector.queryByText(buttonText('Load more executions'), { selector: 'button' })).not.toBeInTheDocument()
  expect(inspector.getByText('Earlier executions are hidden. Refresh to return to the first page.')).toBeVisible()
  expect(inspector.getByLabelText('Execution node-execution')).toBeInTheDocument()
  expect(inspector.getByLabelText('Accepted output from X before rename'))
    .toHaveTextContent('Saved first occurrence result')
  const readsBeforeRefresh = cursors.length
  await userEvent.click(inspector.getByText(buttonText('Refresh node executions'), { selector: 'button' }))
  const selectedAttempt = await inspector.findByText(buttonText('Attempt 1 · node-execution'), { selector: 'button' })
  expect(selectedAttempt).toHaveAccessibleName('Attempt 1 · node-execution')
  expect(selectedAttempt).toHaveAttribute('aria-pressed', 'true')
  expect(cursors.slice(readsBeforeRefresh)).toEqual([null])
  expect(inspector.getByLabelText('Execution node-execution')).toBeInTheDocument()
  expect(inspector.getByLabelText('Accepted output from X before rename'))
    .toHaveTextContent('Saved first occurrence result')
})

it('withdraws inspector branch facts after delayed permission loss', async () => {
  await inspectorApi()
  const { client } = await mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Inspect X before rename' }))
  await screen.findByText('foreman/coder')
  const gate = deferred<void>()
  releases.push(() => gate.resolve())
  server.use(http.get(inspectionRoute, async () => { await gate.promise; return denied(403) }))
  let refresh!: Promise<void>
  act(() => { refresh = client.refetchQueries({ queryKey: ['saved-run-inspection'] }) })
  await act(async () => { gate.resolve(); await refresh })
  await screen.findByText('No access')
  expect(screen.queryByText('foreman/coder')).toBeNull()
  expect(screen.queryByRole('button', { name: /Attempt 1/ })).toBeNull()
})

it('refreshes the originating Agent CI from queued to running to terminal without changing saved names', async () => {
  const ref = { kind: 'ci' as const, workspaceId: runA.workspaceId, workflowId: runA.workflowId,
    runId: runA.runId, workflowVersionId: runA.workflowVersionId, nodeId: 'node-x', agentId: 'agent-x',
    executionId: 'execution-x', attemptKey: '1', ticketId: '00000000-0000-4000-8000-000000000001' }
  const ci = { id: ref.ticketId, groupId: '00000000-0000-4000-8000-000000000002',
    suite: 'build' as const, part: 'build-api' as const, partition: null, state: 'queued' as const,
    computer: null, step: null, exitCode: null, queuedAt: '2026-10-01T00:00:00.000Z', startedAt: null, finishedAt: null }
  let state: 'queued' | 'running' | 'passed' = 'queued'
  server.use(http.get(snapshotRoute, () => {
    const current = { ...ci, state }
    const activitySnapshot = { schemaVersion: 1, scope: { kind: 'workflow_run', workspaceId: runA.workspaceId,
      workflowId: runA.workflowId, runId: runA.runId, workflowVersionId: runA.workflowVersionId }, revision: '1',
      active: state === 'passed' ? [] : [{ ref, phase: state === 'queued' ? 'waiting' : 'active', outcome: null,
        delivery: null, evidence: 'confirmed', startedAt: null, ci: current }], queued: state === 'queued' ? [ref] : [],
      latest: ref, pendingInteractions: [], activities: [{ kind: 'diagnostic', id: 'ci-activity', revision: '0',
        order: '1', owner: ref, source: { schemaVersion: 1, system: 'run_activity', observedAt: ci.queuedAt },
        evidence: 'confirmed', code: 'job_work', message: `CI build ${state}`, ci: current }],
      page: { before: null, nextCursor: null, hasMore: false } }
    return HttpResponse.json({ snapshot: runA, activitySnapshot })
  }))
  const { client } = await mount()
  const owner = await savedNode('X before rename')
  expect(await within(owner).findByRole('status')).toHaveTextContent('CI build-api · queued')
  expect(within(await savedNode('Y')).queryByText(/CI build/)).toBeNull()
  for (const next of ['running', 'passed'] as const) {
    state = next
    await act(async () => { await client.refetchQueries({ queryKey: runsSelectorKeys.snapshot(latest!) }) })
    await waitFor(() => expect(within(owner).getByRole('status')).toHaveTextContent(`CI build-api · ${next}`))
  }
  expect(await savedNode('X before rename')).toBeInTheDocument()
})
