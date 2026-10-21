import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { accountId, accountTarget, accountTargetInfo, observedAccount, observedAt, secondAccountId, workerAccountTarget } from './providerAccounts.fixtures'
import { useProviderHarnessModels } from './useProviderHarnessModels'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function model(id: string) {
  return { id, name: id, reasoningEfforts: ['medium', 'high'], variants: [], serviceTiers: ['standard', 'priority'] }
}

it.each(['codex', 'claude'] as const)('uses the local %s profile only after an empty account read succeeds', async harness => {
  const nativeRead = vi.fn(() => HttpResponse.json({
    harness, providerVersion: 'qualified-cli', authenticated: true, models: [model('local-model')],
    nativeAgents: [], settings: [], restrictions: [], checkedAt: observedAt,
  }))
  let finishRead!: () => void
  const pendingRead = new Promise<void>(resolve => { finishRead = resolve })
  let started = false
  server.use(
    http.get('/api/provider-accounts/page', async () => {
      started = true
      await pendingRead
      return HttpResponse.json({ target: accountTarget, revision: 1, accounts: [], defaults: [], nextCursor: null })
    }),
    http.get(`/api/management/harnesses/${harness}/options`, nativeRead),
  )
  const view = renderHook(() => useProviderHarnessModels(harness), { wrapper: wrapper() })
  try {
    await waitFor(() => expect(started).toBe(true))
    expect(nativeRead).not.toHaveBeenCalled()
    expect(view.result.current.data).toBeUndefined()
  } finally {
    finishRead()
  }
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
  expect(view.result.current.data?.models.map(item => item.id)).toEqual(['local-model'])
  expect(nativeRead).toHaveBeenCalledTimes(1)
})

it.each([undefined, secondAccountId])('uses the Codex default or the explicitly selected account catalog (%s)', async selectedId => {
  const nativeRead = vi.fn(() => HttpResponse.error())
  server.use(
    http.get('/api/provider-accounts/targets', () => HttpResponse.json({ targets: [accountTargetInfo()] })),
    http.get('/api/provider-accounts/page', () => HttpResponse.json({
      target: accountTarget, revision: 1, accounts: [observedAccount(), observedAccount(secondAccountId)],
      defaults: [], nextCursor: null,
    })),
    http.get('/api/provider-accounts/:id/models', ({ params, request }) => {
      const account = observedAccount(String(params.id))
      expect(JSON.parse(new URL(request.url).searchParams.get('target')!)).toEqual(accountTarget)
      return HttpResponse.json({ binding: account.binding, generation: 1, observedAt,
        models: [model(`model-${account.id}`)] })
    }),
    http.get('/api/management/harnesses/codex/options', nativeRead),
  )
  const view = renderHook(() => useProviderHarnessModels('codex', selectedId), { wrapper: wrapper() })
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
  expect(view.result.current.data?.models.map(item => item.id)).toEqual([`model-${selectedId ?? accountId}`])
  expect(nativeRead).not.toHaveBeenCalled()
})

it.each(['accounts', 'models'] as const)('keeps denied %s discovery from falling back to the local profile', async deniedRead => {
  const nativeRead = vi.fn(() => HttpResponse.error())
  const denied = () => HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Account access denied.' } }, { status: 403 })
  server.use(
    http.get('/api/provider-accounts/targets', () => HttpResponse.json({ targets: [accountTargetInfo()] })),
    http.get('/api/provider-accounts/page', () => deniedRead === 'accounts' ? denied() : HttpResponse.json({
      target: accountTarget, revision: 1, accounts: [observedAccount()], defaults: [], nextCursor: null,
    })),
    http.get('/api/provider-accounts/:id/models', denied),
    http.get('/api/management/harnesses/codex/options', nativeRead),
  )
  const view = renderHook(() => useProviderHarnessModels('codex'), { wrapper: wrapper() })
  await waitFor(() => expect(view.result.current.isError).toBe(true))
  expect(view.result.current.error?.message).toBe('Account access denied.')
  expect(view.result.current.data).toBeUndefined()
  expect(view.result.current.isSuccess).toBe(false)
  expect(nativeRead).not.toHaveBeenCalled()
})

it.each(['codex', 'claude'] as const)('reads the selected Worker native %s login when it has no account slots', async harness => {
  const nativeRead = vi.fn(({ request }: { request: Request }) => {
    expect(JSON.parse(new URL(request.url).searchParams.get('hostRef')!)).toEqual(workerAccountTarget.hostRef)
    return HttpResponse.json({ harness, providerVersion: 'worker-cli', authenticated: true,
      models: [model('worker-native-model')], nativeAgents: [], settings: [], restrictions: [], checkedAt: observedAt })
  })
  server.use(
    http.get('/api/provider-accounts/targets', () => HttpResponse.json({
      targets: [accountTargetInfo(), accountTargetInfo(workerAccountTarget)],
    })),
    http.get('/api/provider-accounts/page', () => HttpResponse.json({
      target: workerAccountTarget, revision: 1, accounts: [], defaults: [], nextCursor: null,
    })),
    http.get(`/api/management/harnesses/${harness}/options`, nativeRead),
  )
  const view = renderHook(() => useProviderHarnessModels(harness, undefined, workerAccountTarget.hostRef),
    { wrapper: wrapper() })
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
  expect(view.result.current.data?.models.map(item => item.id)).toEqual(['worker-native-model'])
  expect(nativeRead).toHaveBeenCalledTimes(1)
})
