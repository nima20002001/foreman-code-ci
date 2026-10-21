import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { HarnessExecutionError, NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import { prepareCodexFileTurn } from '../src/modules/harnesses/codexFiles/index.js'
import type { CodexChatFiles } from '../src/modules/harnesses/codexFiles/runtime.js'
import { calls, collect, input, until } from './fixtures/codex-test-helpers.js'
import { filePorts, fileScope, sourceRef } from './fixtures/codex-file-runtime-helpers.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { join } from 'node:path'
import { CodexStdioTransport } from '../src/modules/harnesses/codexStdioTransport.js'

function boundary(operation: NativeDeliveryError['operation'], delivery: NativeDeliveryError['delivery']) {
  return (error: unknown) => error instanceof NativeDeliveryError
    && error.operation === operation && error.delivery === delivery
}

function chatInput(directory: string) {
  const source = input(directory)
  delete source.environment
  return source
}

describe('Codex creation and prompt write boundaries', () => {
  let f: Awaited<ReturnType<typeof deliveryFixture>>
  beforeEach(async () => { f = await deliveryFixture() })
  afterEach(async () => { await f.close() })

  it('accepts a delayed session reply without treating creation as uncertain', async () => {
    const manager = f.makeManager()
    await f.flag('late-thread-start')
    const session = await manager.createSession(chatInput(f.directory))
    assert.equal(session.harness, 'codex')
    assert.equal((await f.wire('thread/start')).length, 1)
    assert.equal((await f.wire('turn/start')).length, 0)
  })

  it('refuses workflow credentials in chat before creating a thread', async () => {
    const manager = f.makeManager()
    await assert.rejects(manager.createSession(input(f.directory)), (error: unknown) => {
      assert(error instanceof NativeDeliveryError)
      assert.equal(error.operation, 'session_creation')
      assert.equal(error.delivery, 'not_sent')
      assert.equal(error.result.error?.code, 'CODEX_APP_MCP_UNAVAILABLE')
      return true
    })
    assert.equal((await f.wire('thread/start')).length, 0)
    assert.equal((await f.wire('turn/start')).length, 0)
  })

  for (const fault of ['auth', 'model', 'initialize'] as const) {
    it(`${fault} failure before thread/start permits one explicit creation retry`, async () => {
      const manager = f.makeManager()
      const source = chatInput(f.directory)
      if (fault === 'auth') await f.flag('logged-out')
      if (fault === 'model') await f.json('models.json', { models: [] })
      if (fault === 'initialize') await f.flag('reject-initialize')
      await assert.rejects(manager.createSession(source), boundary('session_creation', 'not_sent'))
      assert.equal((await f.wire('thread/start')).length, 0)
      await f.unflag('logged-out')
      await f.unflag('models.json')
      await f.unflag('reject-initialize')
      const session = await manager.createSession(source)
      assert.equal(session.harness, 'codex')
      assert.equal((await f.wire('thread/start')).length, 1)
      assert.equal((await f.wire('turn/start')).length, 0)
    })
  }

  it('failure after a successful thread/start keeps creation fenced', async () => {
    const manager = f.makeManager(undefined, {
      id: () => { throw new HarnessExecutionError('CODEX_ACTIVATION_FAILED', 'Cannot assign the local connection.') },
    })
    const source = chatInput(f.directory)
    await assert.rejects(manager.createSession(source), boundary('session_creation', 'unknown'))
    await assert.rejects(manager.createSession(source), /may already exist/)
    assert.equal((await f.wire('thread/start')).length, 1)
    assert.equal((await f.wire('turn/start')).length, 0)
  })

  it('an idle process exit leaves the next prompt definitely unsent', async () => {
    const manager = f.makeManager()
    const source = chatInput(f.directory)
    const session = await manager.createSession(source)
    await f.flag('idle-exit')
    await until(async () => (await calls(f.directory)).some((entry) => entry.exited) || undefined)
    await until(async () => manager.originalSessionLifetime(session, source) ? undefined : true)
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'next', clientCorrelationId: 'next' })),
      boundary('turn_submission', 'not_sent'))
    assert.equal((await f.wire('turn/start')).length, 0)
  })

  for (const fault of ['prepare', 'recheck'] as const) {
    it(`attachment ${fault} failure cleans up before any prompt write and supports retry`, async () => {
      const ports = filePorts()
      let failing = true
      const files: CodexChatFiles = {
        async prepare({ session, signal }) {
          if (fault === 'prepare' && failing) throw new Error('Attachment source is unavailable.')
          return prepareCodexFileTurn({
            ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: session.nativeSessionId,
            admissionId: 'input-admission', executionHostId: 'execution-host-a', projectMode: 'read', allowMutation: false,
            allowedTools: ['files.list', 'files.read'], expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
          }, { ...ports.dependencies, files: ports.files, source: {
            ...ports.dependencies.source,
            recheck: async () => {
              if (fault === 'recheck' && failing) throw new Error('The pinned attachment was removed.')
              return ports.dependencies.source.recheck()
            },
          } }, signal)
        },
      }
      const manager = f.makeManager(files)
      const session = await manager.createSession(chatInput(f.directory))
      await assert.rejects(collect(manager.startTurn(session, {
        prompt: 'Use the attachment', clientCorrelationId: 'unsent', onSubmitted: async () => assert.fail('Unexpected write'),
      })), boundary('turn_submission', 'not_sent'))
      assert.equal((await f.wire('turn/start')).length, 0)
      assert.equal(ports.tokens.size, 0)
      if (fault === 'recheck') assert(ports.events.includes('host:close'))
      failing = false
      await collect(manager.startTurn(session, {
        prompt: 'Use the attachment', clientCorrelationId: 'retry', onSubmitted: async () => undefined,
      }))
      assert.equal((await f.wire('turn/start')).length, 1)
    })
  }

  it('a connection failure after the prompt write remains uncertain', async () => {
    const manager = f.makeManager()
    const session = await manager.createSession(chatInput(f.directory))
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId: 'written' })),
      boundary('turn_submission', 'unknown'))
    assert.equal((await f.wire('turn/start')).length, 1)
  })

  it('retains a late prompt rejection only for its correlation without inventing a turn', async () => {
    const journalPath = join(f.directory, 'native-journal')
    const manager = f.makeManager(undefined, {
      transport: (...args) => {
        args[7] = 500
        return new CodexStdioTransport(...args)
      },
    }, { responseJournal: new NativeResponseJournal(journalPath) })
    const source = chatInput(f.directory)
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'late-reject', clientCorrelationId: 'rejected' })),
      boundary('turn_submission', 'unknown'))
    const result = await until(async () => {
      try { return (await manager.reconcile(session, 'rejected')).nonSubmission } catch { return undefined }
    })
    assert.equal(result.nativeSessionId, session.nativeSessionId)
    assert.equal(result.clientCorrelationId, 'rejected')
    assert.equal(result.result.outcome, 'failed')
    assert.deepEqual((await manager.reconcile(session, 'rejected')).nonSubmission, result)
    assert.equal((await manager.reconcile(session, 'another')).nonSubmission, undefined)
    assert.equal((await f.wire('turn/start')).length, 1)
    await manager.shutdown()
    const replacement = f.makeManager(undefined, {}, { responseJournal: new NativeResponseJournal(journalPath) })
    await replacement.attachSession(session, { ...source, correlationId: 'rejected' })
    assert.deepEqual((await replacement.reconcile(session, 'rejected')).nonSubmission, result)
    await collect(replacement.startTurn(session, { prompt: 'retry', clientCorrelationId: 'rejected' }))
    const retried = await replacement.reconcile(session, 'rejected')
    assert(retried.nativeTurnId)
    assert.equal(retried.nonSubmission, undefined)
    assert.equal((await f.wire('turn/start')).length, 2)
  })

  for (const read of ['thread-read', 'turn-history'] as const) {
    it(`preserves a definite rejection while an older ${read} response is in flight`, async () => {
      const manager = f.makeManager(undefined, {
        transport: (...args) => new CodexStdioTransport(...args),
      }, {
        responseJournal: new NativeResponseJournal(join(f.directory, 'native-journal')),
      })
      const session = await manager.createSession(chatInput(f.directory))
      await f.flag('hold-turn-rejection')
      const controller = new AbortController()
      const submission = assert.rejects(collect(manager.startTurn(session, {
        prompt: 'reject', clientCorrelationId: 'rejected',
      }, controller.signal)), boundary('turn_submission', 'unknown'))
      await until(async () => (await f.wire('turn/start')).length > 0)
      controller.abort()
      await submission
      await f.flag(`hold-${read}`)
      const reconciliation = manager.reconcile(session, 'rejected').then(
        value => ({ value }), error => ({ error }),
      )
      const method = read === 'thread-read' ? 'thread/read' : 'thread/turns/list'
      await until(async () => (await f.wire(method)).length > 0)
      await f.flag('release-turn-rejection')
      await until(async () => (await manager.history(session)).events.some(event =>
        event.type === 'turn.start_rejected' && event.payload.correlationId === 'rejected'))
      await assert.rejects(collect(manager.startTurn(session, {
        prompt: 'complete', clientCorrelationId: 'retry-while-reading',
      })), (error: unknown) => {
        assert(error instanceof NativeDeliveryError)
        assert.equal(error.delivery, 'not_sent')
        assert.equal(error.result.error?.code, 'CODEX_SESSION_BUSY')
        return true
      })
      assert.equal((await f.wire('turn/start')).length, 1)
      // The rejection must survive a read held beyond the fixture's former 500 ms deadline.
      await new Promise(resolve => setTimeout(resolve, 600))
      await f.flag(`release-${read}`)
      const result = await reconciliation
      if ('error' in result) throw result.error
      const rejected = result.value
      assert.equal(rejected.nonSubmission?.clientCorrelationId, 'rejected')
      assert.equal(rejected.nativeTurnId, undefined)
      assert.deepEqual((await manager.reconcile(session, 'rejected')).nonSubmission, rejected.nonSubmission)
      assert.equal((await manager.reconcile(session, 'another')).nonSubmission, undefined)
      assert.equal((await f.wire('turn/start')).length, 1)
      await f.unflag('hold-turn-rejection')
      await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'retry' }))
      assert((await manager.reconcile(session, 'retry')).nativeTurnId)
      assert.equal((await f.wire('turn/start')).length, 2)
    })
  }

  for (const phase of ['preparation', 'pre-send'] as const) {
    it(`retains the ${phase} failure and failed cleanup without authorizing a retry`, async () => {
      const ports = filePorts()
      const originalClose = ports.dependencies.host.close
      let cleanupFails = true
      let rechecks = 0
      const files: CodexChatFiles = {
        async prepare({ session, signal }) {
          return prepareCodexFileTurn({
            ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: session.nativeSessionId,
            admissionId: 'input-admission', executionHostId: 'execution-host-a', projectMode: 'read', allowMutation: false,
            allowedTools: ['files.list', 'files.read'], expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
          }, { ...ports.dependencies, files: ports.files,
            source: { ...ports.dependencies.source, recheck: async () => {
              rechecks++
              if (rechecks === (phase === 'preparation' ? 1 : 2)) throw new Error('Attachment disappeared.')
              return ports.dependencies.source.recheck()
            } },
            host: { ...ports.dependencies.host, close: async () => {
              if (cleanupFails) throw new Error('Host closure is unconfirmed.')
              await originalClose()
            } },
          }, signal)
        },
      }
      const manager = f.makeManager(files)
      const session = await manager.createSession(chatInput(f.directory))
      try {
        await assert.rejects(collect(manager.startTurn(session, {
          prompt: 'Use the attachment', clientCorrelationId: 'cleanup-failure', onSubmitted: async () => assert.fail('Unexpected write'),
        })), (error: unknown) => {
          assert(error instanceof NativeDeliveryError)
          assert.equal(error.operation, 'turn_submission')
          assert.equal(error.delivery, 'not_sent')
          assert.equal(error.cleanup, 'pending')
          assert(error.cause instanceof AggregateError)
          assert(error.cause.errors[0] instanceof NativeDeliveryError)
          assert.equal(error.cause.errors[0].delivery, 'not_sent')
          if (phase === 'preparation') {
            assert.equal(error.cause.errors[0].result.error?.code, 'CODEX_FILE_PREPARATION_CLEANUP_REQUIRED')
            const preparation = error.cause.errors[0].cause
            assert(preparation instanceof Error && preparation.cause instanceof AggregateError)
            assert.match(preparation.cause.errors[0].message, /Attachment disappeared/)
          } else assert.match(error.cause.errors[0].message, /Attachment disappeared/)
          assert.match(error.cause.errors[1].message, /Host closure is unconfirmed/)
          return true
        })
        assert.equal((await f.wire('turn/start')).length, 0)
      } finally { cleanupFails = false }
      await manager.dispose()
      assert(ports.events.includes('host:close'))
    })
  }

  it('the admitted lookup recovers only the original late creation without allocation or replay', async () => {
    const source = chatInput(f.directory)
    let allocations = 0
    const admitted = createAdmittedNativeManager('codex', async () => {
      allocations++
      return { manager: f.makeManager(undefined, {
        transport: (...args) => {
          args[7] = 500
          return new CodexStdioTransport(...args)
        },
      }) }
    })
    await assert.rejects(admitted.manager.reconcileSessionCreation!(source))
    assert.equal(allocations, 0)
    await f.flag('late-thread-start')
    await assert.rejects(admitted.manager.createSession(source), boundary('session_creation', 'unknown'))
    const session = await until(async () => {
      try { return await admitted.manager.reconcileSessionCreation!(source) } catch { return undefined }
    })
    await assert.rejects(admitted.manager.reconcileSessionCreation!({ ...source, correlationId: 'another-creation' }))
    await assert.rejects(admitted.manager.reconcileSessionCreation!({ ...source,
      request: { ...source.request, configuration: { ...source.request.configuration, id: 'another-configuration' } },
    }))
    assert.equal(session.harness, 'codex')
    assert.equal(allocations, 1)
    assert.equal((await f.wire('thread/start')).length, 1)
    assert.equal((await f.wire('turn/start')).length, 0)
    await admitted.manager.dispose!()
    await assert.rejects(admitted.manager.reconcileSessionCreation!(source))
  })

  it('retains a late definitive creation rejection until cleanup and reconciliation', async () => {
    const manager = f.makeManager(undefined, {
      transport: (...args) => {
        args[7] = 500
        return new CodexStdioTransport(...args)
      },
    })
    const source = chatInput(f.directory)
    await f.flag('late-reject-thread-start')
    await assert.rejects(manager.createSession(source), boundary('session_creation', 'unknown'))
    await until(async () => {
      try { await manager.reconcileSessionCreation(source) } catch (error) {
        return boundary('session_creation', 'not_sent')(error) || undefined
      }
      return undefined
    })
    await assert.rejects(manager.reconcileSessionCreation(source), boundary('session_creation', 'not_sent'))
    assert.equal((await f.wire('thread/start')).length, 1)
    assert.equal((await f.wire('turn/start')).length, 0)
  })

  it('recovers one late fork only for the original source and accepted configuration', async () => {
    const manager = f.makeManager(undefined, {
      transport: (...args) => new CodexStdioTransport(...args),
    })
    const source = await manager.createSession(chatInput(f.directory))
    const forkInput = { ...chatInput(f.directory), correlationId: 'fork-creation', instructionsDelivered: true }
    await f.flag('hold-thread-fork')
    const controller = new AbortController()
    const creation = assert.rejects(manager.forkSession(source, forkInput, controller.signal),
      boundary('session_creation', 'unknown'))
    await until(async () => (await f.wire('thread/fork')).length > 0)
    controller.abort()
    await creation
    await assert.rejects(manager.forkSession(source, forkInput), /may already exist/)
    await f.flag('release-thread-fork')
    const fork = await until(async () => {
      try { return await manager.reconcileSessionCreation(forkInput, new AbortController().signal, source) } catch { return undefined }
    })
    assert.notEqual(fork.nativeSessionId, source.nativeSessionId)
    await assert.rejects(manager.reconcileSessionCreation(forkInput))
    await assert.rejects(manager.reconcileSessionCreation(forkInput, new AbortController().signal,
      { ...source, nativeSessionId: 'another-source' }))
    await assert.rejects(manager.reconcileSessionCreation({ ...forkInput, request: {
      ...forkInput.request, configuration: { ...forkInput.request.configuration, id: 'another-configuration' },
    } }, new AbortController().signal, source))
    assert.equal((await f.wire('thread/fork')).length, 1)
    assert.equal((await f.wire('turn/start')).length, 0)
  })
})
