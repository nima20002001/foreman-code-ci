import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { server } from '../../../mocks/server'
import { deferred } from '../../../test/deferred'
import { CiServerDialog } from './CiServer'
import { ciResultJob, ciResultTests } from './ciResults.testSupport'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a',
  workflowVersionId: 'version-a', executionSemanticsVersion: 3 }

it('does not display the previous status filter while the matching tests are loading', async () => {
  const gate = deferred<void>()
  const requested = deferred<void>()
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', async ({ request }) => {
    const status = new URL(request.url).searchParams.get('status')
    if (status) {
      requested.resolve()
      await gate.promise
    }
    const files = ciResultTests.files.map(file => ({ ...file,
      tests: file.tests.filter(test => !status || status.split(',').includes(test.status)) }))
    return HttpResponse.json({ ticketId: ciResultJob.ticketId, tests: { ...ciResultTests, files } })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><CiServerDialog open onOpenChange={() => {}}
    scope={scope} jobs={[ciResultJob]} names={new Map()} truncated={false} error={false} loading={false} /></QueryClientProvider>)
  try {
    fireEvent.click(screen.getByRole('button', { name: /Show tests of/ }))
    await screen.findByText('passing example')
    fireEvent.click(screen.getByRole('button', { name: 'Passed 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skipped 1' }))
    await requested.promise
    expect(screen.queryByText('passing example')).toBeNull()
    expect(screen.queryByText('skipped example')).toBeNull()
    gate.resolve()
    await screen.findByText('failing example')
    fireEvent.click(screen.getByRole('button', { name: 'Passed 1' }))
    await screen.findByText('passing example')
    fireEvent.click(screen.getByRole('button', { name: 'Passed 1' }))
    expect(screen.queryByText('passing example')).toBeNull()
  } finally {
    gate.resolve()
    await act(async () => { view.unmount(); client.clear() })
  }
})
