import { createHash } from 'node:crypto'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect, it, vi } from 'vitest'
import { MainClock } from '../../devices/workerClock.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from '../../../../test/helpers/privateFixtureDirectory.js'
import { deferred, rejectableDeferred } from '../../../../test/helpers/deferred.js'
import { createWorkerMcpEndpoint } from './workerMcpEndpoint.js'

async function callLauncher(transport: StdioClientTransport, id: number) {
  const reply = rejectableDeferred<unknown>()
  transport.onmessage = message => {
    if ('id' in message && message.id === id) reply.resolve(message)
  }
  transport.onerror = reply.reject
  await transport.send({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'context_get', arguments: {} } })
  return reply.promise
}

it('keeps stdio calls available while Main renews a lease on a Worker two minutes ahead', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('worker-launcher-clock-')
    const launcher = join(root, 'launcher.mjs')
    await copyFile(new URL('../../../../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
    const clock = new MainClock()
    const workerTime = Date.now()
    clock.observe(workerTime - 120_000)
    const entered = deferred()
    const renewed = deferred<string>()
    const token = 'launcher-clock-token'
    const request = vi.fn(async (body: unknown) => {
      const message = body as { id: number }
      return { statusCode: 200, contentType: 'application/json' as const,
        body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { value: 'Main response' } }) }
    })
    const endpoint = await createWorkerMcpEndpoint({ launcher, now: () => clock.now(),
      signal: new AbortController().signal, relay: {
        environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: token } },
        expiresAt: new Date(workerTime).toISOString(), request,
        refresh: async () => { entered.resolve(); return renewed.promise },
      } })
    const transport = new StdioClientTransport({ command: process.execPath, args: [launcher],
      env: { FOREMAN_CODE_MCP_TOKEN: token }, stderr: 'pipe' })
    try {
      await entered.promise
      await transport.start()
      expect(await callLauncher(transport, 1)).toEqual({ jsonrpc: '2.0', id: 1,
        result: { value: 'Main response' } })
      const expiry = new Date(clock.now() + 15 * 60_000).toISOString()
      renewed.resolve(expiry)
      expect(await endpoint.refreshLease()).toBe(expiry)
      expect(await callLauncher(transport, 2)).toEqual({ jsonrpc: '2.0', id: 2,
        result: { value: 'Main response' } })
      clock.observe(Date.parse(expiry))
      expect(await callLauncher(transport, 3)).toMatchObject({ id: 3,
        error: { data: { kind: 'authentication', httpStatus: 401 } } })
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      renewed.resolve(new Date(clock.now() + 15 * 60_000).toISOString())
      await transport.close()
      await endpoint.close()
    }
  })
})

it.each(['expired', 'other boot', 'invalid deadline'] as const)(
  'rejects a launcher elapsed-time deadline that is %s before contacting its endpoint', async defect => {
    await withPrivateFixtureDirectories(async () => {
      const root = await privateFixtureDirectory('worker-launcher-deadline-')
      const launcher = join(root, 'launcher.mjs')
      await copyFile(new URL('../../../../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
      const token = 'launcher-deadline-token'
      const request = vi.fn(async (body: unknown) => ({ statusCode: 200, contentType: 'application/json' as const,
        body: JSON.stringify({ jsonrpc: '2.0', id: (body as { id: number }).id, result: {} }) }))
      const endpoint = await createWorkerMcpEndpoint({ launcher, signal: new AbortController().signal,
        relay: { environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: token } },
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), request } })
      const path = join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`)
      const route = JSON.parse(await readFile(path, 'utf8'))
      route.monotonicExpiry = {
        bootId: defect === 'other boot' ? 'other-boot' : bootIdentity(),
        nanoseconds: defect === 'expired' ? '0' : (process.hrtime.bigint() + 900_000_000_000n).toString(),
      }
      if (defect === 'invalid deadline') route.monotonicExpiry.nanoseconds = 'invalid'
      await writeFile(path, JSON.stringify(route))
      const transport = new StdioClientTransport({ command: process.execPath, args: [launcher],
        env: { FOREMAN_CODE_MCP_TOKEN: token }, stderr: 'pipe' })
      try {
        await transport.start()
        expect(await callLauncher(transport, 1)).toMatchObject({ id: 1,
          error: { data: { kind: 'route_unavailable' } } })
        expect(request).not.toHaveBeenCalled()
      } finally {
        await transport.close()
        await endpoint.close()
      }
    })
  },
)
