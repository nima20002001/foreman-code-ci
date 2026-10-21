import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { PinnedProviderAccount } from './PinnedProviderAccount'
import { accountBinding, observedAccount } from './providerAccounts.fixtures'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><PinnedProviderAccount binding={accountBinding()} /></QueryClientProvider>)
}
it('reads accepted account A after its default is cleared and never offers a replacement', async () => {
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ ...observedAccount(), isDefault: false })))
  mount()
  expect(await screen.findByText('Original account')).toBeVisible()
  expect(screen.getByText('Provider identity at acceptance is unknown.')).toBeVisible()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /new session|switch|make default/i })).not.toBeInTheDocument()
})
it('shows preserved history guidance for a removed account without a new-session fallback', async () => {
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ ...observedAccount(),
    isDefault: false, removedAt: '2026-10-01T13:00:00.000Z' })))
  mount()
  expect(await screen.findByText(/This account was removed from selection/)).toBeVisible()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /new session/i })).not.toBeInTheDocument()
})
it('retains the saved binding when its account is unavailable', async () => {
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ error: {
    code: 'ACCOUNT_NOT_FOUND', message: 'Account unavailable' }, }, { status: 404 })))
  mount()
  expect(await screen.findByText(/The original account is unavailable/)).toBeVisible()
  expect(screen.getByText(accountBinding().accountId)).toBeVisible()
})

it('reads the original slot while retaining the qualified subject recorded at acceptance', async () => {
  const accepted = { ...accountBinding(), subject: { subject: 'accepted-provider-subject',
    provenance: 'qualified-native' as const, qualificationId: 'accepted-qualification',
    observedAt: '2026-10-01T12:00:00.000Z' } }
  server.use(http.get('/api/provider-accounts/:id', ({ request }) => {
    expect(JSON.parse(new URL(request.url).searchParams.get('target')!)).toEqual(accepted.target)
    return HttpResponse.json({ ...observedAccount(), isDefault: false })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><PinnedProviderAccount binding={accepted} /></QueryClientProvider>)
  expect(await screen.findByText('Original account')).toBeVisible()
  expect(screen.getByText('Provider identity recorded at acceptance: accepted-provider-subject')).toBeVisible()
  expect(screen.queryByText(/The original account is unavailable/)).not.toBeInTheDocument()
})

it('shows recovery guidance when fresh observation cannot prove the saved account is available', async () => {
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ ...observedAccount(), status: 'unavailable',
    observation: { ...observedAccount().observation!, status: 'unavailable', readiness: 'unavailable' } })))
  mount()
  expect(await screen.findByText(/The original account is unavailable/)).toBeVisible()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
})

it('keeps an unknown historical identity visible without repeating the retained-profile assurance', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><PinnedProviderAccount /></QueryClientProvider>)
  expect(screen.getByText(/Historical provider identity is unknown/)).toBeVisible()
  expect(screen.queryByText(/The saved native profile is retained/)).not.toBeInTheDocument()
})
