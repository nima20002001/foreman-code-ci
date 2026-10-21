// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { collaborationContractFixtures, WorkflowExecutionChatTargetSchema, type WorkflowExecutionChatResolution,
  type WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import { server } from '../../../mocks/server'
import { createWorkflowExecutionChatSlot } from './createWorkflowExecutionChatSlot'
import { executionChatScopeKey } from './client'
import type { WorkflowExecutionChatSlotSelection, WorkflowExecutionChatViewProps,
  WorkflowOutsideRunChatViewProps } from './types'

const fixture = collaborationContractFixtures
const executionTarget = WorkflowExecutionChatTargetSchema.options[0].parse(fixture.executionReadback.target)
const coordinatorTarget = WorkflowExecutionChatTargetSchema.options[1].parse(fixture.consultationReadback.target)
const scope = { workspaceId: fixture.node.workspaceId, workflowId: fixture.node.workflowId }
const base = '*/api/workspaces/:workspaceId/workflows/:workflowId/execution-chat'
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

// These supplied views consume the public adapter contract. The factory, target
// resolution, validation and HTTP client are the production implementations.
function ExecutionChat({ client, resolved, queryKey }: WorkflowExecutionChatViewProps) {
  const read = useQuery({ queryKey, queryFn: ({ signal }) => client.read({ target: resolved.target }, { signal }), retry: false })
  return <section aria-label="Execution conversation">
    <p>{resolved.workflowVersionId}</p>
    <p>{resolved.target.kind === 'workflow_execution' ? resolved.target.execution.executionId : resolved.target.waitingActivationId}</p>
    {read.data?.messages.map(message => <p key={message.id}>{message.content}</p>)}
    {read.isError ? <p role="alert">{read.error.message}</p> : null}
  </section>
}
function OutsideRunChat({ resolved }: WorkflowOutsideRunChatViewProps) {
  return <section aria-label="Outside run conversation">Outside run · {resolved.workflowVersionId}</section>
}
const slot = createWorkflowExecutionChatSlot({ ExecutionChat, OutsideRunChat })

function selected(target: WorkflowExecutionChatTarget = executionTarget): WorkflowExecutionChatResolution {
  return { kind: 'selected', target, agent: fixture.agent, workflowVersionId: fixture.execution.workflowVersionId,
    source: target.kind === 'workflow_execution' ? 'execution' : 'consultation',
    state: target.kind === 'workflow_execution' ? 'active' : 'waiting_children' }
}
function install(initial = selected()) {
  const controls = { resolution: initial, status: 200 }
  const resolutions: URL[] = []
  const reads: WorkflowExecutionChatTarget[] = []
  server.use(http.get(`${base}/target`, ({ request }) => {
    resolutions.push(new URL(request.url))
    if (controls.status !== 200) return HttpResponse.json({ error: {
      code: controls.status === 403 ? 'FORBIDDEN' : 'TEMPORARILY_UNAVAILABLE', message: 'Chat resolution failed',
    } }, { status: controls.status })
    return HttpResponse.json(controls.resolution)
  }), http.post(`${base}/read`, async ({ request }) => {
    const { target } = await request.json() as { target: WorkflowExecutionChatTarget }
    reads.push(target)
    return HttpResponse.json(target.kind === 'workflow_execution' ? fixture.executionReadback : fixture.consultationReadback)
  }))
  return { controls, resolutions, reads }
}
function mount(initial: Partial<WorkflowExecutionChatSlotSelection> = {}) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(cache)
  function Shell() {
    const [visible, setVisible] = useState(true)
    const [pins, setPins] = useState({ ...scope, nodeId: fixture.node.workflowNodeId, ...initial })
    return <>
      <button onClick={() => setVisible(value => !value)}>Toggle chat</button>
      <output aria-label="Chat selection">{JSON.stringify(pins)}</output>
      {visible ? slot({ ...pins, onSelectRun: run => setPins({ ...scope, nodeId: pins.nodeId, ...run }),
        onSelectTarget: (target, workflowVersionId) => setPins({ ...scope, nodeId: pins.nodeId, workflowVersionId,
          ...(target.kind === 'workflow_execution'
            ? { runId: target.execution.runId, executionId: target.execution.executionId }
            : { runId: target.runId, waitingActivationId: target.waitingActivationId }) }) }) : null}
    </>
  }
  render(<QueryClientProvider client={cache}><Shell /></QueryClientProvider>)
  return cache
}

it.each(['execution', 'coordinator'] as const)('pins the resolved %s before mounting the supplied view and reading history', async kind => {
  const target = kind === 'execution' ? executionTarget : coordinatorTarget
  const wire = install(selected(target))
  mount()
  await screen.findByText('Working on the task.')
  expect(wire.reads).toEqual([target])
  const pins = wire.resolutions.at(-1)!.searchParams
  expect(pins.get('runId')).toBe('run')
  expect(pins.get('workflowVersionId')).toBe('version')
  expect(pins.get(kind === 'execution' ? 'executionId' : 'waitingActivationId'))
    .toBe(kind === 'execution' ? 'execution' : 'activation')
  expect(pins.has(kind === 'execution' ? 'waitingActivationId' : 'executionId')).toBe(false)
})

it('requires an explicit Run and execution choice and never follows a successor on refresh', async () => {
  const wire = install({ kind: 'run_selection_required', items: [{ runId: 'run', workflowVersionId: 'version' }],
    revision: 1, nextCursor: null, hasMore: false })
  const cache = mount()
  await screen.findByRole('button', { name: 'Run run' })
  expect(wire.reads).toEqual([])
  const choice = selected()
  if (choice.kind !== 'selected') throw new Error('Expected selected fixture')
  const candidate = { target: choice.target, agent: choice.agent, workflowVersionId: choice.workflowVersionId,
    source: choice.source, state: choice.state }
  wire.controls.resolution = { kind: 'selection_required', items: [candidate], revision: 1, nextCursor: null, hasMore: false }
  fireEvent.click(screen.getByRole('button', { name: 'Run run' }))
  await screen.findByRole('button', { name: 'Execution execution · Attempt 1' })
  expect(wire.reads).toEqual([])
  wire.controls.resolution = choice
  fireEvent.click(screen.getByRole('button', { name: 'Execution execution · Attempt 1' }))
  await screen.findByText('Working on the task.')
  wire.controls.resolution = selected({ ...executionTarget,
    execution: { ...fixture.execution, executionId: 'successor', activationId: 'successor-activation' } })
  await act(async () => { await cache.invalidateQueries({ queryKey: [...executionChatScopeKey(scope), 'selection'] }) })
  expect(await screen.findByRole('alert')).toHaveTextContent('another saved selection')
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"execution"')
  expect(wire.reads.every(target => target.kind === 'workflow_execution' && target.execution.executionId === 'execution')).toBe(true)
  expect(screen.queryByRole('region', { name: 'Execution conversation' })).not.toBeInTheDocument()
})

it('retains transient status, hides denied history through a failed retry, and resumes only after a successful read', async () => {
  const wire = install()
  const cache = mount({ runId: 'run', workflowVersionId: 'version', executionId: 'execution' })
  await screen.findByText('Working on the task.')
  const refresh = () => act(async () => {
    await cache.invalidateQueries({ queryKey: [...executionChatScopeKey(scope), 'selection'] })
  })
  wire.controls.status = 503
  await refresh()
  await screen.findByRole('alert')
  expect(screen.getByText('Working on the task.')).toBeVisible()
  wire.controls.status = 403
  await refresh()
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Execution conversation' })).not.toBeInTheDocument())
  wire.controls.status = 503
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled())
  expect(screen.queryByText('Working on the task.')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Chat selection')).toHaveTextContent('"executionId":"execution"')
  wire.controls.status = 200
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Working on the task.')
})

it('mounts outside-run chat only for an unpinned current workflow and performs no hidden reads', async () => {
  const wire = install({ kind: 'outside_run', agent: fixture.node, workflowVersionId: 'version', reason: 'NO_LIVE_RUN' })
  const cache = mount()
  await screen.findByRole('region', { name: 'Outside run conversation' })
  expect(wire.reads).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Toggle chat' }))
  const count = wire.resolutions.length
  await act(async () => { await cache.invalidateQueries({ queryKey: executionChatScopeKey(scope) }) })
  expect(wire.resolutions).toHaveLength(count)
  expect(wire.reads).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Toggle chat' }))
  await screen.findByRole('region', { name: 'Outside run conversation' })
  await waitFor(() => expect(wire.resolutions).toHaveLength(count + 1))
})
