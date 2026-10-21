import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { server } from '../../mocks/server'
import { boundLocationKeys, useBoundWorkspaceLocation, useSetBoundWorkspaceLocation } from './workspaceBoundLocation'
import { workerRoot, mainRoot, boundRootReadback } from '../../features/settings/workspaceBoundLocation.fixtures'
const input: WorkspaceRootSelection = { workspaceId: 'workspace-1', hostRef: workerRoot.hostRef, allowedBaseId: workerRoot.bases[0]!.baseId,
  configurationRevision: '1', relativePath: 'src', accessMode: 'read-only', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
const clients: QueryClient[] = []
function wrapper() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> } }
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
describe('exact bound-location HTTP acknowledgement fence', () => {
  it('rejects a validly shaped acknowledgement for a different computer', async () => {
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({ value: boundRootReadback({ ...input, hostRef: mainRoot.hostRef }, mainRoot), replayed: false })))
    const { client, Wrapper } = wrapper(); const mutation = renderHook(() => useSetBoundWorkspaceLocation('workspace-1'), { wrapper: Wrapper })
    await act(async () => { await expect(mutation.result.current.mutateAsync({ input: { ...input, commandId: 'original-command' }, expectedHost: workerRoot })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) })
    expect(client.getQueryData(boundLocationKeys.read('workspace-1'))).toBeUndefined()
  })
  it('rejects a legacy location result instead of accepting it as a remote binding', async () => {
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({ value: { evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 1,
      executionLocation: { runnerId: 'some-server-runner', rootPath: '/projects/shared/src' } }, replayed: false })))
    const { Wrapper } = wrapper(); const mutation = renderHook(() => useSetBoundWorkspaceLocation('workspace-1'), { wrapper: Wrapper })
    await act(async () => { await expect(mutation.result.current.mutateAsync({ input: { ...input, commandId: 'original-command' }, expectedHost: workerRoot })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) })
  })
  it('accepts a device root without moving the cached primary Main location', async () => {
    const selection = { ...input, expectedLocationRevision: 1 }
    const value = boundRootReadback(selection, workerRoot)
    if (value.evidence !== 'bound') throw new Error('Expected a device root binding')
    value.locationRevision = 1
    value.binding.locationRevision = '1'
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', () =>
      HttpResponse.json({ value, replayed: false })))
    const { client, Wrapper } = wrapper()
    const primary = boundRootReadback({ ...input, hostRef: mainRoot.hostRef }, mainRoot)
    client.setQueryData(boundLocationKeys.read('workspace-1'), primary)
    const mutation = renderHook(() => useSetBoundWorkspaceLocation('workspace-1'), { wrapper: Wrapper })
    await act(async () => {
      await expect(mutation.result.current.mutateAsync({
        input: { ...selection, commandId: 'device-root-command' }, expectedHost: workerRoot,
      })).resolves.toEqual({ value, replayed: false })
    })
    expect(client.getQueryData(boundLocationKeys.read('workspace-1'))).toEqual(primary)
  })
  it('does not allow an older read to replace a newer saved bound-location cache', async () => {
    let resolve!: () => void, entered!: () => void
    const gate = new Promise<void>(done => { resolve = done }), started = new Promise<void>(done => { entered = done })
    server.use(http.get('/api/management/workspaces/workspace-1/root-location', async () => { entered(); await gate; return HttpResponse.json(boundRootReadback(input, workerRoot)) }))
    const { client, Wrapper } = wrapper(); const query = renderHook(() => useBoundWorkspaceLocation('workspace-1'), { wrapper: Wrapper })
    await started
    await act(async () => { client.setQueryData(boundLocationKeys.read('workspace-1'), boundRootReadback({ ...input, expectedLocationRevision: 1 }, workerRoot)); resolve(); await gate })
    await waitFor(() => expect(query.result.current.isFetching).toBe(false))
    expect(query.result.current.data?.locationRevision).toBe(2)
  })
})
