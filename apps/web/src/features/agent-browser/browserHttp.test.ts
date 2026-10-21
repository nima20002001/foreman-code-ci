import { expect, it, vi } from 'vitest'
import { HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { BrowserProfileReplicaSchema, BrowserProfileSyncJobSchema } from '@foreman-code/contracts/browser-profiles'
import { createBrowserProfilesClient, type BrowserProfileCodecs } from '../browser-profiles/client'
import { browserMswHandlers } from './testing'
import { createBrowserHttp } from './http'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { deferred } from './testFixtures'
import type { BrowserProfileCatalog } from '../browser-profiles/types'


it('saves policy through the canonical profile route without sync and preserves command identity through a lost sync response', async () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  const replica = { profileId: 'profile', computerId: 'worker', desiredSnapshot: null, receivedSnapshot: null, appliedSnapshot: null,
    transfer: 'update_available', loginEvidence: [], localOverride: false, lastSeenAt: null, reason: null }
  const job = { id: 'job', commandId: 'same-command', state: 'queued', profiles: [], targets: [], revision: 1,
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' }
  let fail = true
  server.use(...browserMswHandlers(async request => {
    const path = new URL(request.url).pathname
    requests.push({ method: request.method, path, body: await request.json() })
    if (path.endsWith('/sync') && fail) { fail = false; return HttpResponse.error() }
    return HttpResponse.json(path.endsWith('/sync') ? job : replica)
  }))
  const unused = { encode: () => { throw new Error('Unused fixture codec') }, decode: async (): Promise<never> => { throw new Error('Unused fixture codec') } }
  // These tiny fixture envelopes stand in for D's actual C0 codecs, never exported as wire schemas.
  const profiles: BrowserProfileCodecs = { readCatalog: unused, create: unused, addExisting: unused, update: unused, confirmLogin: unused,
    remove: unused, openSetup: unused, closeSetup: unused, readSync: unused,
    setLocalOverride: { encode: (profileId, computerId, localOverride, commandId) => ({ json: { profileId, computerId, localOverride, commandId } }),
      decode: async response => BrowserProfileReplicaSchema.parse(await response.json()) },
    sync: { encode: (profileIds, commandId) => ({ json: { profileIds, commandId } }),
      decode: async response => BrowserProfileSyncJobSchema.parse(await response.json()) } }
  const client = createBrowserProfilesClient({ origin: 'http://localhost', profiles,
    error: vi.fn(async () => ({ message: 'Rejected', outcome: 'rejected' as const })) })
  expect(await client.setLocalOverride('profile', 'worker', false, 'policy-command')).toMatchObject({ localOverride: false })
  expect(requests.map(request => request.path)).toEqual(['/api/browser/profiles/profile'])
  await expect(client.sync(['profile'], 'same-command')).rejects.toThrow()
  expect(await client.sync(['profile'], 'same-command')).toMatchObject({ id: 'job', state: 'queued' })
  expect(requests[1]).toEqual(requests[2])
})

it('collects all bounded catalog pages and restarts once if the authoritative revision changes', async () => {
  const empty: BrowserProfileCatalog = { profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [] }
  const seen: string[] = []
  let pass = 0
  server.use(...browserMswHandlers(async request => {
    const cursor = new URL(request.url).searchParams.get('cursor') ?? ''
    seen.push(cursor)
    if (!cursor) pass += 1
    const id = cursor ? 'second' : 'first'
    return HttpResponse.json({ ...empty, profiles: [{ id, name: id, sourceComputerId: 'main', distribution: 'shared', revision: 1, publishedRevision: 0 }],
      nextCursor: cursor ? null : 'next', revision: pass === 1 && !cursor ? 1 : 2 })
  }))
  const unused = { encode: () => { throw new Error('Unused fixture codec') }, decode: async (): Promise<never> => { throw new Error('Unused fixture codec') } }
  const codecs: BrowserProfileCodecs = { create: unused, addExisting: unused, update: unused, setLocalOverride: unused,
    confirmLogin: unused, remove: unused, openSetup: unused, closeSetup: unused, sync: unused, readSync: unused,
    readCatalog: { encode: cursor => ({ query: new URLSearchParams(cursor ? { cursor } : {}) }),
      decode: async response => response.json() } }
  const client = createBrowserProfilesClient({ origin: 'http://localhost', profiles: codecs, error: async () => ({ message: 'Rejected' }) })
  const catalog = await client.readCatalog(new AbortController().signal)
  expect(catalog.profiles.map(profile => profile.id)).toEqual(['first', 'second'])
  expect(seen).toEqual(['', 'next', '', 'next'])
})

it('uses the shared installation boundary and rejects a late decoded body after a session switch', async () => {
  const decoded = deferred<{ value: string }>(), decoding = deferred<void>()
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const call = createBrowserHttp({ fetch: fetcher, origin: 'http://localhost', error: async () => ({ message: 'Rejected' }) })
  const request = call('GET', '/api/browser/profiles', { encode: () => ({}), decode: async () => {
    decoding.resolve(); return decoded.promise
  } }, [])
  await decoding.promise
  expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ credentials: 'omit', cache: 'no-store', headers: expect.any(Headers) }))
  try {
    beginSessionChange(); decoded.resolve({ value: 'private old metadata' })
    await expect(request).rejects.toHaveProperty('name', 'AbortError')
  } finally { finishSessionChange() }
})
