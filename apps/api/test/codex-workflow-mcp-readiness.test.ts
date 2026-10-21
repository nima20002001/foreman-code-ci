import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import { HarnessExecutionError, NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { CodexRpcError, CodexStdioTransport } from '../src/modules/harnesses/codexStdioTransport.js'
import { appLauncherPath } from '../src/modules/harnesses/appMcpLauncher.js'
import { collect, until } from './fixtures/codex-test-helpers.js'
import { CodexAppServerSessionManager, f, managers, setManager, manager, source, json, flag,
  unflag, wire, useCodexFixture } from './codex-app-server.test-support.js'

const tool = { name: 'context_get', inputSchema: { type: 'object' } }
const ready = (name = 'graphql') => ({
  name, runtimeStatus: 'connected', toolsError: null, tools: { context_get: tool },
  resources: [], resourceTemplates: [], authStatus: 'bearerToken',
})

describe('workflow Codex MCP readiness', () => {
  useCodexFixture({ requestTimeoutMs: 5_000 })
  let delays: number[]
  let holdWait: boolean
  let onReload: (() => Promise<void>) | undefined
  let reloadFailures: number
  let stallStatus: boolean
  let expireStartup: (() => void) | undefined

  beforeEach(() => {
    delays = []
    holdWait = false
    onReload = undefined
    reloadFailures = 0
    stallStatus = false
    expireStartup = undefined
    const schedule = ((callback: () => void, milliseconds: number) => {
      const startupWait = [10_000, 20_000, 40_000].includes(milliseconds)
      if (startupWait) delays.push(milliseconds)
      const timer = setTimeout(callback, startupWait && !holdWait ? 1 : milliseconds)
      if (milliseconds === 120_000) expireStartup = () => { clearTimeout(timer); callback() }
      return timer
    }) as typeof setTimeout
    const retryManager = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined,
      'scoped', undefined, {
        mode: 'native', schedule,
        withDiagnostics: async () => {
          throw new HarnessExecutionError('CODEX_DIAGNOSTIC_OWNER_REQUIRED',
            'Turn startup cannot depend on idle-session diagnostics.')
        },
        transport: (...args) => {
          const transport = new CodexStdioTransport(...args)
          const request = transport.request.bind(transport)
          transport.request = async (...requestArgs) => {
            if (requestArgs[0] === 'mcpServerStatus/list' && stallStatus) {
              const signal = requestArgs[2]!
              signal.throwIfAborted()
              return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
              })
            }
            if (requestArgs[0] === 'config/mcpServer/reload' && reloadFailures > 0) {
              reloadFailures--
              throw new CodexRpcError(requestArgs[0], 'reload', false, 'CODEX_RPC_ERROR')
            }
            const result = await request(...requestArgs)
            if (requestArgs[0] === 'config/mcpServer/reload') await onReload?.()
            return result
          }
          return transport
        },
      })
    managers.push(retryManager)
    setManager(retryManager)
  })

  it.each(['empty tools', 'failed startup', 'status request failed'])(
    'automatically reloads and retries %s before sending the same turn once', async failure => {
      if (failure === 'status request failed') await flag('reject-mcp-status')
      else await json('mcp-status.json', { data: [{ ...ready(),
        tools: {}, runtimeStatus: failure === 'failed startup' ? 'failed' : 'connected',
      }], nextCursor: null })
      onReload = async () => {
        await unflag('reject-mcp-status')
        await json('mcp-status.json', { data: [ready()], nextCursor: null })
      }
      const session = await manager.createSession(source)
      const submitted: string[] = []
      const events = await collect(manager.startTurn(session, {
        prompt: 'complete', clientCorrelationId: 'automatic-retry',
        onSubmitted: async id => { submitted.push(id) },
      }))
      assert.deepEqual(delays, [10_000])
      assert.equal((await wire('config/mcpServer/reload')).length, 1)
      assert.equal((await wire('mcpServerStatus/list')).length, 2)
      assert.equal((await wire('turn/start')).length, 1)
      assert.equal(submitted.length, 1)
      const retries = events.filter(event => event.type === 'turn.mcp_startup_retry')
      assert.equal(retries.length, 1)
      assert.deepEqual(retries[0]!.payload, {
        threadId: session.nativeSessionId, serverName: 'graphql', attempt: 2, delayMs: 10_000,
      })
      assert.equal((await manager.history(session)).terminalResult?.outcome, 'succeeded')
    })

  it('continues bounded readiness checks when an MCP reload fails transiently', async () => {
    reloadFailures = 1
    await json('mcp-status.json', { data: [], nextCursor: null })
    onReload = async () => { await json('mcp-status.json', { data: [ready()], nextCursor: null }) }
    const session = await manager.createSession(source)
    const events = await collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'reload-recovery',
    }))
    assert.deepEqual(delays, [10_000, 20_000])
    assert.equal(events.filter(event => event.type === 'turn.mcp_startup_retry').length, 2)
    assert.equal((await wire('mcpServerStatus/list')).length, 3)
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('bounds a stalled readiness request by the two-minute startup deadline', async () => {
    const session = await manager.createSession(source)
    stallStatus = true
    const result = collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'startup-deadline',
    }))
    const settled = result.then(() => undefined, (error: unknown) => error)
    await until(async () => expireStartup, 1_000)
    expireStartup!()
    const error = await settled
    assert(error instanceof NativeDeliveryError)
    assert.equal(error.delivery, 'not_sent')
    assert.equal(error.result.error?.code, 'CODEX_APP_MCP_NOT_READY')
    assert.equal((await wire('turn/start')).length, 0)
  })

  it('streams retry activity during backoff and cancels without submitting or further retries', async () => {
    holdWait = true
    await json('mcp-status.json', { data: [], nextCursor: null })
    const session = await manager.createSession(source)
    const controller = new AbortController()
    const observed: string[] = []
    const result = (async () => {
      for await (const event of manager.startTurn(session, {
        prompt: 'complete', clientCorrelationId: 'canceled-startup',
      }, controller.signal)) observed.push(event.type)
    })()
    const rejection = assert.rejects(result, (error: unknown) =>
      error instanceof NativeDeliveryError && error.delivery === 'not_sent')
    await until(async () => observed.includes('turn.mcp_startup_retry'), 1_000)
    await until(async () => delays.length === 1, 1_000)
    const reloadsBeforeCancel = (await wire('config/mcpServer/reload')).length
    controller.abort()
    await rejection
    assert.deepEqual(delays, [10_000])
    assert.equal((await wire('turn/start')).length, 0)
    assert.equal((await wire('config/mcpServer/reload')).length, reloadsBeforeCancel)
    assert.equal((await manager.history(session)).terminalResult, undefined)
  })

  it.each(['foreman-code', 'graphql'])('checks the live %s session before submitting a turn', async name => {
    await json('mcp.json', { name, enabled: true, required: true,
      transport: { type: 'stdio', command: process.execPath, args: [appLauncherPath()],
        env_vars: ['GRAPHQL_MCP_TOKEN'] } })
    await json('mcp-status.json', { data: [ready(name)], nextCursor: null })
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'ready' }))
    const requests = await wire()
    const statusIndex = requests.findIndex(request => request.method === 'mcpServerStatus/list')
    assert(statusIndex >= 0)
    assert(statusIndex < requests.findIndex(request => request.method === 'turn/start'))
    assert.deepEqual(requests[statusIndex]!.params, {
      threadId: session.nativeSessionId, detail: 'toolsAndAuthOnly',
    })
  })

  it.each([
    [],
    [ready('unrelated')],
    [ready('foreman-code')],
    [{ ...ready(), tools: {} }],
    [{ ...ready(), runtimeStatus: 'failed' }],
    [{ ...ready(), runtimeStatus: 'starting' }],
    [{ ...ready(), runtimeStatus: 'disabled' }],
    [{ ...ready(), runtimeStatus: null }],
    [{ ...ready(), toolsError: 'Discovery failed' }],
  ].map(data => ({ data })))('fails without submitting when the runtime catalog is unavailable: $data', async ({ data }) => {
    await json('mcp-status.json', { data, nextCursor: null })
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'unavailable',
    })), (error: unknown) => {
      assert(error instanceof NativeDeliveryError)
      assert.equal(error.delivery, 'not_sent')
      assert.equal(error.result.error?.code, 'CODEX_APP_MCP_NOT_READY')
      assert.equal(error.result.error?.retryable, true)
      assert.match(error.message, /Retry the activation/)
      return true
    })
    assert.equal((await wire('turn/start')).length, 0)
    assert.deepEqual(delays, [10_000, 20_000, 40_000])
    assert.equal((await wire('mcpServerStatus/list')).length, 4)
    assert.equal((await wire('config/mcpServer/reload')).length, 3)
    assert.equal((await manager.history(session)).events.filter(event =>
      event.type === 'turn.mcp_startup_retry').length, 3)
    assert.equal((await manager.history(session)).terminalResult, undefined)
    await json('mcp-status.json', { data: [ready()], nextCursor: null })
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'retry' }))
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('checks subsequent catalog pages in the same native session', async () => {
    await json('mcp-status.json', { data: [ready('unrelated')], nextCursor: 'next' })
    await json('mcp-status-pages.json', { next: { data: [ready()], nextCursor: null } })
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'paged' }))
    const requests = await wire('mcpServerStatus/list')
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1]!.params, {
      threadId: session.nativeSessionId, detail: 'toolsAndAuthOnly', cursor: 'next',
    })
  })

  it('makes a failed native readiness request retryable without sending model input', async () => {
    await flag('reject-mcp-status')
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'status-failed',
    })), (error: unknown) => error instanceof NativeDeliveryError && error.delivery === 'not_sent'
      && error.result.error?.code === 'CODEX_APP_MCP_NOT_READY' && error.result.error.retryable)
    assert.equal((await wire('turn/start')).length, 0)
  })

  it('rechecks readiness after a completed turn instead of trusting a previous catalog', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'first' }))
    const previous = (await manager.history(session)).terminalResult
    await json('mcp-status.json', { data: [], nextCursor: null })
    await assert.rejects(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'second',
    })), (error: unknown) => error instanceof NativeDeliveryError && error.delivery === 'not_sent')
    assert.equal((await wire('turn/start')).length, 1)
    assert.deepEqual((await manager.history(session)).terminalResult, previous)
  })
})
