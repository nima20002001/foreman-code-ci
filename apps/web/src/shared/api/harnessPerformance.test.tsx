import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HarnessDefaultsUpdateInputSchema } from '@foreman-code/contracts/management'
import { apiClient } from './client'
import { queryKeys, useHarnessDefaultsQuery, useManagedHarnessCatalogQuery, useUpdateManagedHarnessDefaultsMutation } from './query'
import { harnessSettingsKeys, useApplyManagedMcpChange, useNativeHarnessOptions, useNativeMcpPlans, useNativeMcpServers } from './harnessSettings'
import { useOperatorChatSetup } from './operatorChatSetup'
import { savedClaudeConfiguration } from '../../features/settings/claudeSettings.fixtures'

const clients: QueryClient[] = []
const revision = `sha256:${'a'.repeat(64)}`
const nextRevision = `sha256:${'b'.repeat(64)}`
const catalog = Object.entries({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration }).map(([harness, defaults]) =>
  ({ harness, defaults, defaultsRevision: 6, capability: null, discoveryError: null }))
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } } })
  clients.push(client)
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.useRealTimers(); vi.restoreAllMocks() })

it('shares one catalog request and each three-second poll while retaining optional Claude defaults and raw revisions', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue(catalog)
  const { client, Wrapper } = wrapper()
  const queries = renderHook(() => ({ catalog: useManagedHarnessCatalogQuery(), first: useHarnessDefaultsQuery(), second: useHarnessDefaultsQuery() }), { wrapper: Wrapper })
  await waitFor(() => expect(queries.result.current.first.isSuccess).toBe(true))
  expect(request).toHaveBeenCalledOnce()
  expect(queries.result.current.first.data?.defaults.claude).toEqual(savedClaudeConfiguration)
  expect(queries.result.current.second.data).toEqual(queries.result.current.first.data)
  expect(client.getQueryData(queryKeys.managedHarnessCatalog)).toEqual(catalog)
  await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
})

it('does not read the catalog when its only defaults observer is disabled', async () => {
  const request = vi.spyOn(apiClient, 'request')
  const { Wrapper } = wrapper()
  renderHook(() => useHarnessDefaultsQuery({ enabled: false }), { wrapper: Wrapper })
  await act(async () => { await Promise.resolve() })
  expect(request).not.toHaveBeenCalled()
})

it('publishes confirmed defaults in the shared catalog without retaining old readiness or accepting a lower revision', async () => {
  const { client, Wrapper } = wrapper()
  client.setQueryData(queryKeys.managedHarnessCatalog, catalog.map(entry => ({ ...entry, capability: { ready: true } })))
  const defaults = HarnessDefaultsUpdateInputSchema.shape.defaults.parse({ ...DEFAULT_HARNESS_DEFAULTS, claude: { ...savedClaudeConfiguration, instructions: 'Saved instructions' } })
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue({ value: { defaults, revision: 7 }, replayed: false })
  const mutation = renderHook(() => useUpdateManagedHarnessDefaultsMutation(), { wrapper: Wrapper })
  await act(async () => { await mutation.result.current.mutateAsync({ defaults, expectedRevision: 6, commandId: crypto.randomUUID() }) })
  expect(client.getQueryData(queryKeys.managedHarnessCatalog)).toEqual([
    expect.objectContaining({ harness: 'codex', defaultsRevision: 7, capability: { ready: true } }),
    expect.objectContaining({ harness: 'claude', defaults: defaults.claude, defaultsRevision: 7, capability: null }),
  ])
  request.mockResolvedValue({ value: { defaults: DEFAULT_HARNESS_DEFAULTS, revision: 6 }, replayed: true })
  await act(async () => { await mutation.result.current.mutateAsync({ defaults: HarnessDefaultsUpdateInputSchema.shape.defaults.parse(DEFAULT_HARNESS_DEFAULTS), expectedRevision: 5, commandId: crypto.randomUUID() }) })
  expect(client.getQueryData(queryKeys.managedHarnessCatalog)).toEqual(expect.arrayContaining([
    expect.objectContaining({ harness: 'claude', defaults: defaults.claude, defaultsRevision: 7 }),
  ]))
})

it('refreshes affected MCP state without unrelated native options or plans, and waits for fresh revision readback', async () => {
  let writes = 0, finishReadback!: () => void, finishReadiness!: () => void
  const readback = new Promise<void>(resolve => { finishReadback = resolve })
  const readiness = new Promise<void>(resolve => { finishReadiness = resolve })
  const request = vi.spyOn(apiClient, 'request').mockImplementation(async (path, _schema, options) => {
    if (options?.method === 'POST') {
      writes++
      return { id: crypto.randomUUID(), harness: 'codex', status: 'applied', change: { kind: 'remove', name: 'graphql' }, revision,
        managedPreset: 'graphql', requestedBy: 'owner', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), error: null }
    }
    if (path === '/api/management/harnesses') { if (writes) await readiness; return catalog }
    if (path.startsWith('/api/operator/setup')) { if (writes) await readiness; return { status: 'configured' } }
    if (path.endsWith('/plans')) return { items: [] }
    if (path.endsWith('/codex/mcp')) { if (writes) await readback; return { harness: 'codex', revision: writes ? nextRevision : revision, servers: [] } }
    return { harness: 'claude', models: [] }
  })
  const { client, Wrapper } = wrapper()
  const hooks = renderHook(() => ({
    catalog: useManagedHarnessCatalogQuery(), options: useNativeHarnessOptions('claude'), servers: useNativeMcpServers('codex'),
    plans: useNativeMcpPlans('codex'), otherPlans: useNativeMcpPlans('codex'), setup: useOperatorChatSetup(true, 6),
    managed: useApplyManagedMcpChange('codex'),
  }), { wrapper: Wrapper })
  await waitFor(() => expect([hooks.result.current.catalog, hooks.result.current.options, hooks.result.current.servers,
    hooks.result.current.plans, hooks.result.current.otherPlans, hooks.result.current.setup].every(value => value.isSuccess)).toBe(true))
  request.mockClear()
  act(() => hooks.result.current.managed.start({ preset: 'graphql', installed: false, expectedRevision: revision }))
  await waitFor(() => expect(request).toHaveBeenCalledTimes(5))
  expect(request.mock.calls.map(([path]) => path).sort()).toEqual([
    '/api/management/harnesses/mcp/managed', '/api/management/harnesses', '/api/management/harnesses/codex/mcp',
    '/api/management/harnesses/codex/mcp/plans', '/api/operator/setup?expectedDefaultsRevision=6',
  ].sort())
  expect(hooks.result.current.managed.isPending).toBe(true)
  expect(hooks.result.current.servers.data?.revision).toBe(revision)
  await act(async () => { finishReadback(); await readback })
  await waitFor(() => expect(hooks.result.current.managed.isSuccess).toBe(true))
  expect(hooks.result.current.servers.data?.revision).toBe(nextRevision)
  expect(client.getQueryState(harnessSettingsKeys.mcp('codex'))?.isInvalidated).toBe(false)
  expect(hooks.result.current.catalog.isFetching).toBe(true)
  expect(hooks.result.current.setup.isFetching).toBe(true)
  await act(async () => { finishReadiness(); await readiness })
})
