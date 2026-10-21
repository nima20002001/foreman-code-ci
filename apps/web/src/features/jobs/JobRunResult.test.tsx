import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { it, expect } from 'vitest'
import type { JobWorkflowAdmissionReference, JobWorkflowExecutionReference } from '@foreman-code/contracts/job-workflow'
import { server } from '../../mocks/server'
import { JobRunResult } from './JobRunResult'
import { definition, execution, logPage } from './fixtures'

const reference: JobWorkflowAdmissionReference = { kind: 'job', workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', workflowVersionId: 'workflow-version-a',
  nodeId: 'build', nodeExecutionId: 'node-execution-a', occurrenceId: null, occurrenceIndex: 0 }
// Distinct on purpose: the node execution ID and the job execution ID are different identities.
const mapped: JobWorkflowExecutionReference = { ...reference, jobExecutionId: execution.id }
const linked = { ...execution, workflow: { workflowId: 'workflow-a', runId: 'run-a', nodeId: 'build', nodeExecutionId: 'node-execution-a' } }
const mapping = '*/api/management/workspaces/:workspaceId/jobs/workflow-executions/:runId/:nodeExecutionId'
const root = '*/api/management/workspaces/:workspaceId/jobs/executions/:id'

function respond(options: { reference?: unknown; execution?: unknown } = {}) {
  const requested: string[] = []
  server.use(http.get(mapping, () => HttpResponse.json({ reference: options.reference ?? mapped })),
    http.get(root, ({ params }) => { requested.push(String(params.id)); return HttpResponse.json({ execution: options.execution ?? linked }) }),
    http.get(`${root}/logs`, () => HttpResponse.json(logPage)), http.get(`${root}/artifacts`, () => HttpResponse.json({ artifacts: [] })))
  return requested
}
function tree(value: JobWorkflowAdmissionReference, versionId = definition.versionId) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><JobRunResult reference={value} definitionVersionId={versionId} /></QueryClientProvider>
}

it('reads the job through the persisted mapping, never the node execution ID', async () => {
  const requested = respond()
  render(tree(reference))
  expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
  expect(requested).toContain(execution.id)
  expect(requested).not.toContain(reference.nodeExecutionId)
  expect(screen.getByText(/node-execution-a/)).toBeInTheDocument()
})

it.each([
  ['Run', { runId: 'run-b' }], ['node', { nodeId: 'other' }], ['node execution', { nodeExecutionId: 'node-execution-b' }],
  ['workflow version', { workflowVersionId: 'workflow-version-b' }], ['occurrence', { occurrenceId: 'occurrence-a' }], ['repetition', { occurrenceIndex: 2 }],
] as const)('rejects a mapping for another %s without reading any job', async (_name, override) => {
  const requested = respond({ reference: { ...mapped, ...override } })
  render(tree(reference))
  expect(await screen.findByText('Run job result unavailable')).toBeInTheDocument()
  expect(screen.queryByText(/Process:/)).toBeNull()
  expect(requested).toEqual([])
})

it('hides the result after the mapping read is revoked', async () => {
  server.use(http.get(mapping, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied' } }, { status: 403 })))
  render(tree(reference))
  expect(await screen.findByText(/permission lost/)).toBeInTheDocument()
  expect(screen.queryByText(/Process:/)).toBeNull()
})

it('refuses a job whose own workflow correlation disagrees with the mapping', async () => {
  respond({ execution: { ...linked, workflow: { ...linked.workflow, nodeExecutionId: 'node-execution-b' } } })
  render(tree(reference))
  expect(await screen.findByText('Run job result identity mismatch')).toBeInTheDocument()
  expect(screen.queryByText(/Process:/)).toBeNull()
})

it('refuses a job accepted from a different immutable definition version', async () => {
  respond()
  render(tree(reference, 'version-other'))
  expect(await screen.findByText('Run job result identity mismatch')).toBeInTheDocument()
  expect(screen.queryByText(/Process:/)).toBeNull()
})

it('drops the previous result when another execution is selected', async () => {
  respond()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><JobRunResult reference={reference} definitionVersionId={definition.versionId} /></QueryClientProvider>)
  expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
  const next = { ...reference, nodeExecutionId: 'node-execution-b' }
  server.use(http.get(mapping, () => new Promise(() => undefined)))
  view.rerender(<QueryClientProvider client={client}><JobRunResult reference={next} definitionVersionId={definition.versionId} /></QueryClientProvider>)
  expect(await screen.findByText(/Reading the job accepted for this exact Run execution/)).toBeInTheDocument()
  expect(screen.queryByText(/Process:/)).toBeNull()
})

it('recovers when the persisted job mapping appears after the first read', async () => {
  respond()
  let reads = 0
  server.use(http.get(mapping, () => {
    reads += 1
    if (reads === 1) return HttpResponse.json({ error: { code: 'JOB_NOT_FOUND', message: 'Not saved yet' } }, { status: 404 })
    return HttpResponse.json({ reference: mapped })
  }))
  render(tree(reference))
  await screen.findByText('Run job result unavailable')
  await waitFor(() => expect(screen.getByText('Process: build failed')).toBeInTheDocument(), { timeout: 5000 })
  expect(reads).toBeGreaterThan(1)
}, 8000)
