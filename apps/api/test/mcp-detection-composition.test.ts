import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'
import { createAppMcpRuntime, localAppMcpEndpoint } from '../src/modules/app-runtime/composition.js'
import { McpDetectionService, WorkerLaunchCredentialService } from '../src/modules/harnesses/mcpDetection.js'
import { registerMcpDetectionRoute } from '../src/routes/mcpDetection.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'

afterEach(() => vi.restoreAllMocks())

function route(service: McpDetectionService) {
  let handler!: (request: unknown, reply: unknown) => Promise<unknown>
  registerMcpDetectionRoute({ get: (_path: string, action: typeof handler) => { handler = action } } as never, {
    inspectionSnapshot: async () => ({ runnerId: 'runner-local', rootPath: '/workspace' }),
  } as never, service)
  const request = {
    params: { workspaceId: 'workspace-1', harness: 'codex' },
    query: {},
    raw: Object.assign(new EventEmitter(), { aborted: false }),
    operatorPrincipal: {
      id: 'operator-1', name: 'Operator', audience: 'operator', expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null,
      grants: [{ actions: ['harnesses:read', 'workspace_locations:read'], scope: { workspaceIds: ['workspace-1'] } }],
    },
  }
  const reply = { raw: Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }) }
  return { handler, request, reply }
}

describe('application MCP composition and HTTP detection', () => {
  it('preflights, issues and renews credentials with an execution timeout longer than the credential lease', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture' })
    assert(config.harnesses.timeoutMs > 900_000)
    const pool = {} as never
    const access = {} as never
    const runtime = createAppMcpRuntime({ pool, access, commands: {} as never, interactions: {} as never, config, runnerId: 'runner-local' })
    assert(runtime.executionCredentials instanceof WorkerLaunchCredentialService)
    assert(runtime.mcpDetection.service instanceof McpDetectionService)
    assert.equal(runtime.mcpDetection.pool, pool)
    assert.equal(runtime.appMcp.access, access)
    const credential = { principalId: 'worker', environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: 'token' } },
      expiresAt: new Date(Date.now() + 900_000).toISOString() }
    const inspected = {} as Awaited<ReturnType<McpDetectionService['preflight']>>
    const preflight = vi.spyOn(runtime.mcpDetection.service, 'preflight').mockResolvedValue(inspected)
    const revoke = vi.spyOn(Wave25WorkerCredentialService.prototype, 'revokeSupersededForExecution').mockResolvedValue(0)
    const issue = vi.spyOn(Wave25WorkerCredentialService.prototype, 'issueForExecution').mockResolvedValue(credential)
    const renewedExpiry = new Date(Date.now() + 1_800_000).toISOString()
    const renew = vi.spyOn(Wave25WorkerCredentialService.prototype, 'renewForExecution').mockResolvedValue(renewedExpiry)
    const prepared = await runtime.executionCredentials.prepare({ executionId: 'execution', harness: 'codex', workingDirectory: '/workspace' })
    assert.deepEqual(prepared, { credential, detection: inspected })
    assert.deepEqual(preflight.mock.calls, [[{ harness: 'codex', runnerId: 'runner-local', workingDirectory: '/workspace' }]])
    assert.deepEqual(revoke.mock.calls, [['execution']])
    assert.deepEqual(issue.mock.calls, [['execution']])
    assert.equal(await runtime.executionCredentials.renew('execution', credential), renewedExpiry)
    assert.deepEqual(renew.mock.calls, [['execution', credential]])
  })

  it('normalizes wildcard listen addresses to usable local endpoints', () => {
    assert.equal(localAppMcpEndpoint('0.0.0.0', 3000), 'http://127.0.0.1:3000/mcp')
    assert.equal(localAppMcpEndpoint('::', 3000), 'http://[::1]:3000/mcp')
  })

  it('accepts workspace-scoped detection authority and denies another workspace', async () => {
    let calls = 0
    let phase: string | undefined
    const service = new McpDetectionService({ inspect: async (input) => {
      calls += 1
      phase = input.phase
      return { ...input, providerVersion: '0.154.0', inspectedAt: new Date().toISOString() }
    } }, 'http://127.0.0.1:3000/mcp')
    const f = route(service)
    await f.handler(f.request, f.reply)
    assert.equal(calls, 1)
    assert.equal(phase, 'configuration')
    f.request.params.workspaceId = 'workspace-other'
    await assert.rejects(f.handler(f.request, f.reply))
    assert.equal(calls, 1)
  })

  it('cancels request-owned native inspection when the HTTP client disconnects', async () => {
    let inspected: AbortSignal | undefined
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    const service = new McpDetectionService({ inspect: async (input) => {
      inspected = input.signal
      ready()
      return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('abandoned')), { once: true }))
    } }, 'http://127.0.0.1:3000/mcp')
    const f = route(service)
    const response = f.handler(f.request, f.reply)
    await started
    f.reply.raw.emit('close')
    await response
    assert.equal(inspected?.aborted, true)
    assert.equal(f.request.raw.listenerCount('aborted'), 0)
    assert.equal(f.reply.raw.listenerCount('close'), 0)
  })
})
