import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ProviderAccountAuthentication } from './ProviderAccountAuthentication'
import { accountTarget, accountTargetInfo, authenticationOperation, observedAccount, operationId,
  workerAccountTarget } from './providerAccounts.fixtures'

const clients: QueryClient[] = []
beforeEach(() => server.use(
  http.get('/api/provider-accounts/targets', () => HttpResponse.json({ targets: [accountTargetInfo()] })),
  http.get('/api/provider-accounts/:id/eligibility', ({ params, request }) => HttpResponse.json({
    accountId: params.id, target: JSON.parse(new URL(request.url).searchParams.get('target')!),
    canManage: true, canReauthenticate: true, reason: null,
  })),
  http.get('/api/provider-accounts/:id/authentication', ({ params, request }) => HttpResponse.json({
    accountId: params.id, target: JSON.parse(new URL(request.url).searchParams.get('target')!),
    currentOperation: null, operations: [], nextCursor: null,
  })),
))
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function mount(savedOperationId?: string, canManage = true, account = observedAccount()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Harness() {
    const [open, setOpen] = useState(true)
    const [selected, setSelected] = useState(savedOperationId)
    return <><button onClick={() => setOpen(true)}>Reopen progress</button>
      <ProviderAccountAuthentication account={account} revision={1} canManage={canManage} open={open}
        {...(selected ? { operationId: selected } : {})} onOperation={setSelected} onClose={() => setOpen(false)} /></>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return { client, user: userEvent.setup() }
}

it('prepares one operation, hides without canceling, and reopens its original progress', async () => {
  let prepares = 0
  let cancels = 0
  const reads: unknown[] = []
  server.use(
    http.post('/api/provider-accounts/:id/authentication', () => {
      prepares++
      return HttpResponse.json({ value: authenticationOperation(), replayed: false })
    }),
    http.post('/api/provider-accounts/authentication/status', async ({ request }) => {
      reads.push(await request.json())
      return HttpResponse.json(authenticationOperation())
    }),
    http.post('/api/provider-accounts/authentication/cancel', () => { cancels++; return HttpResponse.error() }),
  )
  const { user, client } = mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare authentication' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Prepare authentication' }))
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Hide progress' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Reopen progress' }))
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  await waitFor(() => expect(reads.length).toBeGreaterThan(0))
  expect(reads.at(-1)).toMatchObject({ operationId })
  expect(prepares).toBe(1)
  expect(cancels).toBe(0)
  expect(client.getMutationCache().getAll().map(item => item.state.variables)).toEqual([
    expect.objectContaining({ action: 'prepare', input: expect.objectContaining({ intent: 'sign-in', expectedRevision: 1 }) }),
  ])
})

it('retains the original command after a lost prepare acknowledgement and locks dismissal', async () => {
  const requests: unknown[] = []
  server.use(http.post('/api/provider-accounts/:id/authentication', async ({ request }) => {
    requests.push(await request.json())
    return requests.length === 1 ? HttpResponse.error()
      : HttpResponse.json({ value: authenticationOperation(), replayed: true })
  }), http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(authenticationOperation())))
  const { user } = mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare authentication' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Prepare authentication' }))
  const retry = await screen.findByRole('button', { name: 'Retry original authentication' })
  expect(screen.getByRole('button', { name: 'Hide progress' })).toBeDisabled()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('dialog')).toBeVisible()
  await user.click(retry)
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  expect(requests[1]).toEqual(requests[0])
})

it('keeps cancellation unconfirmed until the same native operation closes', async () => {
  let operation = authenticationOperation()
  const cancels: unknown[] = []
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(operation)),
    http.post('/api/provider-accounts/authentication/cancel', async ({ request }) => {
      cancels.push(await request.json())
      operation = authenticationOperation({ revision: 2, cancelRequested: true, state: 'outcome-unknown' })
      return HttpResponse.json({ value: operation, replayed: false })
    }))
  const { user } = mount(operationId)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel authentication' })).toBeEnabled())
  await user.click(await screen.findByRole('button', { name: 'Cancel authentication' }))
  expect(await screen.findByText('Cancel requested. The provider has not confirmed closure.')).toBeVisible()
  expect(screen.queryByText('Authentication canceled')).not.toBeInTheDocument()
  expect(cancels[0]).toMatchObject({ operationId })
  operation = authenticationOperation({ revision: 3, state: 'canceled', cancelRequested: true, nativeClosed: true,
    humanActionRequired: false })
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(await screen.findByText('Authentication canceled')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Cancel authentication' })).not.toBeInTheDocument()
})

it.each(['expired', 'failed', 'outcome-unknown'] as const)('rechecks a saved %s operation without starting another login', async state => {
  let prepares = 0
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(authenticationOperation({ state }))),
    http.post('/api/provider-accounts/:id/authentication', () => { prepares++; return HttpResponse.error() }))
  const { user } = mount(operationId)
  await screen.findByRole('button', { name: 'Recheck original operation' })
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Prepare authentication' })).not.toBeInTheDocument()
  expect(prepares).toBe(0)
})

it('does not treat late completion after cancel as a default change or a replacement operation', async () => {
  let operation = authenticationOperation({ cancelRequested: true, state: 'outcome-unknown', revision: 2 })
  let prepares = 0
  let defaults = 0
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(operation)),
    http.post('/api/provider-accounts/:id/authentication', () => { prepares++; return HttpResponse.error() }),
    http.post('/api/provider-accounts/:id/default', () => { defaults++; return HttpResponse.error() }))
  const { user } = mount(operationId)
  await screen.findByText('Authentication outcome unknown')
  operation = authenticationOperation({ cancelRequested: true, state: 'completed', revision: 3, nativeClosed: true,
    humanActionRequired: false })
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(await screen.findByText('Authentication completed')).toBeVisible()
  expect(screen.getByText('Refresh the account to read its sign-in and readiness.')).toBeVisible()
  expect(screen.queryByText(/Its default is unchanged/)).not.toBeInTheDocument()
  expect(prepares).toBe(0)
  expect(defaults).toBe(0)
})


it('allows a read-only caller to recheck progress while disabling cancellation', async () => {
  let cancels = 0
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(authenticationOperation())),
    http.post('/api/provider-accounts/authentication/cancel', () => { cancels++; return HttpResponse.error() }))
  const { user } = mount(operationId, false)
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Cancel authentication' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(cancels).toBe(0)
})

it('discovers the current persisted operation after re-entry without a saved operation link', async () => {
  let prepares = 0
  server.use(
    http.get('/api/provider-accounts/:id/authentication', () => HttpResponse.json({
      accountId: observedAccount().id, target: accountTarget, currentOperation: authenticationOperation(),
      operations: [], nextCursor: '30000000-0000-4000-8000-000000000004',
    })),
    http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(authenticationOperation())),
    http.post('/api/provider-accounts/:id/authentication', () => { prepares++; return HttpResponse.error() }),
  )
  const { user } = mount()
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Hide progress' }))
  await user.click(screen.getByRole('button', { name: 'Reopen progress' }))
  expect(screen.getByText('Waiting for human sign-in')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Prepare authentication' })).not.toBeInTheDocument()
  expect(prepares).toBe(0)
})

it('reconciles a lost prepare response by its persisted command without dispatching another login', async () => {
  let saved: ReturnType<typeof authenticationOperation> | null = null
  let prepares = 0
  server.use(
    http.get('/api/provider-accounts/:id/authentication', () => HttpResponse.json({
      accountId: observedAccount().id, target: accountTarget, currentOperation: saved,
      operations: saved ? [saved] : [], nextCursor: null,
    })),
    http.post('/api/provider-accounts/:id/authentication', async ({ request }) => {
      const input = await request.json() as { commandId: string }
      prepares++
      saved = authenticationOperation({ commandId: input.commandId })
      return HttpResponse.error()
    }),
    http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(saved)),
  )
  const { user } = mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare authentication' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Prepare authentication' }))
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Hide progress' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Retry original authentication' })).not.toBeInTheDocument()
  expect(prepares).toBe(1)
})

it('holds human-only no-store instructions outside query, mutation, URL and storage state, and clears them on hide', async () => {
  const operation = authenticationOperation({ expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })
  const instruction = 'Complete sign-in in the installed CLI browser.'
  let handoffs = 0
  server.use(
    http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(operation)),
    http.post('/api/provider-accounts/authentication/handoff', async ({ request }) => {
      expect(request.cache).toBe('no-store')
      expect(request.referrerPolicy).toBe('no-referrer')
      expect(await request.json()).toEqual({ operationId, target: accountTarget })
      handoffs++
      return HttpResponse.json({ operationId, kind: 'local-browser', expiresAt: operation.expiresAt, message: instruction },
        { headers: { 'cache-control': 'no-store, private', pragma: 'no-cache', 'referrer-policy': 'no-referrer' } })
    }),
  )
  const { user, client } = mount(operationId)
  await user.click(await screen.findByRole('button', { name: 'Show sign-in instructions' }))
  expect(await screen.findByText(instruction)).toBeVisible()
  expect(JSON.stringify(client.getQueryCache().getAll().map(item => item.state))).not.toContain(instruction)
  expect(JSON.stringify(client.getMutationCache().getAll().map(item => item.state))).not.toContain(instruction)
  expect(window.location.href).not.toContain(instruction)
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(instruction)
  await user.click(screen.getByRole('button', { name: 'Hide progress' }))
  await user.click(screen.getByRole('button', { name: 'Reopen progress' }))
  expect(screen.queryByText(instruction)).not.toBeInTheDocument()
  expect(handoffs).toBe(1)
})

it('keeps Worker sign-in on its owning browser and includes the original target in status and cancel', async () => {
  const account = { ...observedAccount(), binding: { ...observedAccount().binding!, target: workerAccountTarget } }
  const operation = authenticationOperation({ binding: account.binding,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })
  let handoffs = 0
  server.use(
    http.get('/api/provider-accounts/targets', () => HttpResponse.json({ targets: [accountTargetInfo(workerAccountTarget)] })),
    http.post('/api/provider-accounts/authentication/status', async ({ request }) => {
      expect(await request.json()).toEqual({ operationId, target: workerAccountTarget })
      return HttpResponse.json(operation)
    }),
    http.post('/api/provider-accounts/authentication/cancel', async ({ request }) => {
      expect(await request.json()).toMatchObject({ operationId, target: workerAccountTarget })
      return HttpResponse.json({ value: { ...operation, revision: 2, cancelRequested: true }, replayed: false })
    }),
    http.post('/api/provider-accounts/authentication/handoff', () => { handoffs++; return HttpResponse.error() }),
  )
  const { user } = mount(operationId, true, account)
  expect(await screen.findByText(/Complete sign-in in the owning Worker’s browser/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Show sign-in instructions' })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel authentication' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Cancel authentication' }))
  expect(await screen.findByText('Cancel requested. The provider has not confirmed closure.')).toBeVisible()
  expect(handoffs).toBe(0)
})

it('uses live eligibility to block used-account reauthentication while retaining progress reads', async () => {
  server.use(http.get('/api/provider-accounts/:id/eligibility', () => HttpResponse.json({
    accountId: observedAccount().id, target: accountTarget, canManage: true, canReauthenticate: false,
    reason: 'This account is retained by saved work.',
  })))
  mount()
  expect(await screen.findByText('This account is retained by saved work.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Prepare authentication' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Find saved operations' })).toBeEnabled()
})

it('keeps authentication actions visible with background-progress help on demand', async () => {
  const { user } = mount()
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible()
  expect(screen.queryByText('Choose an authentication action for this account.')).not.toBeInTheDocument()
  expect(screen.queryByText('Authentication continues on the owning computer when you hide this progress.'))
    .not.toBeInTheDocument()
  await user.hover(screen.getByRole('button', { name: 'About Authentication progress' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Authentication continues on the owning computer when you hide this progress.')
})
