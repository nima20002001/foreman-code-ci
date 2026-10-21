import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { WorkflowJobPage } from '@foreman-code/contracts/job-verification'
import { server } from '../../../mocks/server'
import { execution, logPage } from '../../jobs/fixtures'
import { CiServerDialog } from './CiServer'

const workspaceId = execution.workspaceId
const workflowId = 'workflow-a'
const root = '*/api/management/workspaces/:workspaceId/jobs'
const nodeJob = { ...execution, workflow: { workflowId, runId: 'run-a', nodeId: 'node-a', nodeExecutionId: 'node-exec-a' } }

function respond(items: WorkflowJobPage['items'], history?: () => Response) {
  server.use(
    http.get(`${root}/workflows/:workflowId/executions`, history ?? (() =>
      HttpResponse.json({ workspaceId, workflowId, items, nextCursor: null } satisfies WorkflowJobPage))),
    http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [], nextHistoryCursor: null })),
    http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution: nodeJob })),
    http.get(`${root}/executions/:id/logs`, () => HttpResponse.json(logPage)),
    http.get(`${root}/executions/:id/artifacts`, () => HttpResponse.json({ artifacts: [] })))
}
async function openWorkflowJobs() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><CiServerDialog open onOpenChange={() => undefined}
    workflow={{ workspaceId, workflowId }} jobs={[]} names={new Map()} truncated={false} error={false} loading={false} />
  </QueryClientProvider>)
  await userEvent.click(screen.getByRole('tab', { name: 'Workflow jobs' }))
}

it('lists the workflow job history in the CI server inspector and opens a read-only result', async () => {
  respond([{ name: 'Web build', execution: nodeJob }])
  await openWorkflowJobs()
  const row = await screen.findByRole('button', { name: /Web build/ })
  expect(within(row).getByLabelText('Failed')).toBeInTheDocument()
  expect(within(row).getByText('2.0 s')).toBeInTheDocument()
  await userEvent.click(row)
  expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /cancel|rerun/i })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Back to jobs' }))
  expect(screen.getByRole('button', { name: /Web build/ })).toBeInTheDocument()
})

it('says so when the workflow has no jobs', async () => {
  respond([])
  await openWorkflowJobs()
  expect(await screen.findByText('No jobs yet.')).toBeInTheDocument()
})

it('shows a retryable error when the history cannot be read', async () => {
  respond([], () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Jobs read denied' } }, { status: 403 }))
  await openWorkflowJobs()
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
})
