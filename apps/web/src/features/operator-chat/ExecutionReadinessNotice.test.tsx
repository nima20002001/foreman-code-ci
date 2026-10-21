import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionReadiness } from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import { ExecutionReadinessNotice } from './ExecutionReadinessNotice'

const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.clear()) })
function mount(status: ExecutionReadiness['status'] | 'error', scope: ExecutionReadiness['scope'] = 'operator-configuration') {
  server.use(http.get('*/api/management/harnesses/codex/execution-readiness', ({ request }) => {
    expect(new URL(request.url).searchParams.get('scope')).toBe('operator-configuration')
    expect(new URL(request.url).searchParams.get('configurationVersionId')).toBe('accepted-operator-config')
    return status === 'error'
    ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 })
    : HttpResponse.json({ harness: 'codex', scope, configurationVersionId: 'accepted-operator-config', status, rolloutEnabled: status === 'eligible',
      defaultsRevision: null, checkedAt: new Date().toISOString(), reason: status === 'eligible' ? null : { code: 'NATIVE_ROLLOUT_DISABLED', message: 'Explicit opt-in is required.' }, limitation: 'Run checks remain authoritative.' })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ExecutionReadinessNotice harness="codex" configurationVersionId="accepted-operator-config" /></QueryClientProvider>)
}
describe('execution readiness notice', () => {
  it('makes a missing rollout visible without blocking browsing', async () => {
    mount('blocked')
    expect(await screen.findByText('Execution is unavailable')).toBeVisible()
    expect(screen.getByText('Explicit opt-in is required.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Dismiss notice' })).toBeEnabled()
  })
  it('does not imply the selected Operator has been qualified', async () => {
    mount('eligible')
    await waitFor(() => expect(screen.queryByText('Checking execution eligibility…')).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('keeps failed reads explicitly unverified', async () => {
    mount('error')
    expect(await screen.findByText('Execution eligibility is unverified')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
  })
  it('does not use a workflow preset response as Operator readiness evidence', async () => {
    mount('eligible', 'saved-harness-defaults')
    expect(await screen.findByText('Execution eligibility is unverified')).toBeVisible()
  })
})
