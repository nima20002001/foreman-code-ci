import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTestRoot, removeTestRoot } from '../../../scripts/test-resources.mjs'
import { DomainError } from '../src/modules/errors.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { CodexStdioTransport, isObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { calls, collect, fixture, fixtureQualification, input, processesForRequests }
  from './fixtures/codex-test-helpers.js'
import { deferred } from './helpers/deferred.js'
import { privateFixtureRoot } from './helpers/privateFixtureDirectory.js'

it.each([
  { persistence: 'persistent', detaches: true },
  { persistence: 'ephemeral', detaches: false },
])('preserves only an owned $persistence session while its first turn is pending', async ({ persistence, detaches }) => {
  const root = createTestRoot(await privateFixtureRoot(), 'codex-pending-turn-')
  const provider = await fixture({ root })
  const source = input(provider.directory)
  if (source.request.configuration.harness.harness !== 'codex') throw new Error('Expected the Codex fixture.')
  if (persistence === 'ephemeral') source.request.configuration.harness.advanced!.sessionPersistence = 'ephemeral'
  const registry = new NativeProcessRegistry(join(provider.directory, 'native-process-registry'))
  const recovery = registry.scope(`execution:${source.request.executionId}`)
  const entered = deferred()
  const release = deferred()
  const caller = new AbortController()
  const reason = new DomainError('ENGINE_RESTART', 'The original session is restarting.', 409)
  const makeManager = () => new CodexAppServerSessionManager(provider.binary, undefined, undefined, recovery,
    'scoped', undefined, {
      mode: 'native', qualify: fixtureQualification, assertUnchanged: async () => undefined,
      transport: (...args) => {
        const transport = new CodexStdioTransport(...args)
        const request = transport.request.bind(transport)
        transport.request = async (method, ...parameters) => {
          if (method === 'mcpServerStatus/list') {
            entered.resolve()
            await release.promise
          }
          return request(method, ...parameters)
        }
        return transport
      },
    })
  const manager = makeManager()
  const other = makeManager()
  let startup: Promise<{ error: unknown } | { events: unknown }> | undefined
  try {
    const session = await manager.createSession(source)
    expect(manager.canDetachForRestart(session)).toBe(false)
    startup = collect(manager.startTurn(session, {
      prompt: 'Submit the original input once', clientCorrelationId: `execution:${source.request.executionId}`,
    }, caller.signal)).then(events => ({ events }), (error: unknown) => ({ error }))
    await entered.promise
    const before = await calls(provider.directory)
    expect(before.filter(call => isObject(call.wire) && call.wire.method === 'thread/start')).toHaveLength(1)
    expect(before.filter(call => isObject(call.wire) && call.wire.method === 'turn/start')).toEqual([])
    expect(manager.canDetachForRestart(session)).toBe(detaches)
    expect(other.canDetachForRestart(session)).toBe(false)
    expect(manager.canDetachForRestart({ ...session, nativeSessionId: 'unknown-session' })).toBe(false)
    expect(manager.canDetachForRestart({ ...session, providerVersion: 'different-version' })).toBe(false)
    expect(manager.canDetachForRestart({ ...session, harness: 'claude' })).toBe(false)
    const original = (await processesForRequests(provider.directory, 'thread/start'))[0]!
    if (typeof original.pid !== 'number') throw new Error('Expected the original native provider process.')
    caller.abort(reason)
    await manager.closeForRestart(session)
    expect(manager.canDetachForRestart(session)).toBe(false)
    if (detaches) expect(() => process.kill(original.pid as number, 0)).not.toThrow()
    else expect(() => process.kill(original.pid as number, 0)).toThrow()
    release.resolve()
    expect(await startup).toEqual({ events: [] })
    const after = await calls(provider.directory)
    expect(after.filter(call => isObject(call.wire) && call.wire.method === 'thread/start')).toHaveLength(1)
    expect(after.filter(call => isObject(call.wire) && ['turn/start', 'thread/resume'].includes(String(call.wire.method))))
      .toEqual([])
  } finally {
    caller.abort(reason)
    release.resolve()
    await startup
    try {
      await Promise.all([manager.shutdown(), other.shutdown()])
    } finally {
      expect(await registry.closeOwner(recovery.owner)).toBe(true)
      removeTestRoot(root)
    }
  }
}, 30_000)
