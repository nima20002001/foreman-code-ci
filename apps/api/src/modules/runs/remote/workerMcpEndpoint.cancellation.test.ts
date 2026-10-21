import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../../test/helpers/deferred.js'
import { createWorkerMcpEndpoint } from './workerMcpEndpoint.js'

it.each(['close', 'owner abort'] as const)('cancels an active HTTP relay on %s', async action => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'worker-request-cancellation-'))
  const owner = new AbortController()
  const entered = deferred<AbortSignal>()
  const release = deferred<void>()
  const token = 'request-cancellation-token'
  const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'launcher.mjs'), signal: owner.signal,
    relay: { environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: token } },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      request: async (_body, _protocol, signal) => {
        if (!signal) throw new Error('Missing relay request signal')
        entered.resolve(signal)
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          void release.promise.then(() => { signal.removeEventListener('abort', abort); resolve() })
        })
        return { statusCode: 200, contentType: 'application/json', body: '{}' }
      },
    } })
  const pending = fetch(endpoint.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    .then(async response => { await response.text(); return response.status })
  try {
    const signal = await entered.promise
    let closing = Promise.resolve()
    if (action === 'close') closing = endpoint.close()
    else owner.abort()
    expect(signal.aborted).toBe(true)
    expect(await pending).toBe(502)
    await closing
  } finally {
    release.resolve()
    await pending
    await endpoint.close()
    const route = join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`)
    await expect(readFile(route)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['close', 'owner abort'] as const)('cancels an active refresh on %s before joining it', async action => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'worker-refresh-cancellation-'))
  const owner = new AbortController()
  const entered = deferred<AbortSignal>()
  const release = deferred<string>()
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'launcher.mjs'), signal: owner.signal,
    relay: { environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: 'refresh-cancellation-token' } },
      expiresAt, request: async () => ({ statusCode: 200, contentType: 'application/json', body: '{}' }),
      refresh: async signal => {
        if (!signal) throw new Error('Missing relay refresh signal')
        entered.resolve(signal)
        return new Promise<string>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          void release.promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) })
        })
      },
    } })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) - 60_000)
  const pending = endpoint.refreshLease().then(value => ({ value }), error => ({ error }))
  try {
    const signal = await entered.promise
    let closing = Promise.resolve()
    if (action === 'close') closing = endpoint.close()
    else owner.abort()
    expect(signal.aborted).toBe(true)
    expect(await pending).toEqual({ error: signal.reason })
    await closing
  } finally {
    release.resolve(new Date(Date.now() + 600_000).toISOString())
    await pending
    await endpoint.close()
    clock.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
