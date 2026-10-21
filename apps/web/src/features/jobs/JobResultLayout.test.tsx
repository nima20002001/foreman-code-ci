import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { Dialog } from '../../shared/ui/nocturne'
import { JobResult } from './JobResult'
import { execution, logPage } from './fixtures'
import jobsStyles from './jobs.css?inline'

const title = 'Saved job '.repeat(50).trim()
const description = 'Selected Run with a long saved job name '.repeat(20).trim()

function renderJobDialog() {
  const root = '*/api/management/workspaces/:workspaceId/jobs/executions/:id'
  server.use(
    http.get(root, () => HttpResponse.json({ execution })),
    http.get(`${root}/logs`, () => HttpResponse.json(logPage)),
    http.get(`${root}/artifacts`, () => HttpResponse.json({ artifacts: [] })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<>
    <style>{jobsStyles}</style>
    <QueryClientProvider client={client}>
      <Dialog open className="job-dialog" title={title} description={description} onOpenChange={() => {}}>
        <JobResult workspaceId={execution.workspaceId} executionId={execution.id} />
      </Dialog>
    </QueryClientProvider>
  </>)
}

it('wraps long saved job dialog headings and keeps the close control from shrinking', () => {
  renderJobDialog()
  const heading = screen.getByRole('heading', { name: title })
  expect(getComputedStyle(heading).overflowWrap).toBe('anywhere')
  expect(getComputedStyle(screen.getByText(description)).overflowWrap).toBe('anywhere')
  expect(getComputedStyle(heading.parentElement!).minWidth).toBe('0px')
  expect(getComputedStyle(screen.getByRole('button', { name: 'Close dialog' })).flexShrink).toBe('0')
})

it('keeps read-only log controls in a wrapping toolbar', async () => {
  renderJobDialog()
  const copy = await screen.findByRole('button', { name: 'Copy loaded text' })
  const toolbar = getComputedStyle(copy.parentElement!)
  expect(toolbar.display).toBe('flex')
  expect(toolbar.flexWrap).toBe('wrap')
  expect(screen.getByRole('searchbox', { name: 'Search loaded logs' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull()
})
