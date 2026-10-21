import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { deferred } from './helpers/deferred.js'
import { DomainError } from '../src/modules/errors.js'

// The provider boundary is controllable; launch, publication, ownership and shutdown use production SQL/services.
describe.runIf(postgresEnabled)('workflow startup preservation', () => {
  it.each(['session creation', 'session publication'] as const)(
    'reloads a starting execution when shutdown overlaps %s', async phase => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    const database = await migratedDatabase()
    let runtime: Awaited<ReturnType<typeof checkpointRuntimeFixture>>
    try {
      runtime = await checkpointRuntimeFixture(1, 1, {
        database, fixture, approvalNodeIds: [fixture.version.entryNodeId],
      })
    } catch (error) {
      await database.close()
      throw error
    }
    const opening = deferred()
    const publish = deferred()
    const captured = deferred()
    const bound = deferred()
    const firstBatch = deferred()
    const originalConnection = runtime.provider.connection.bind(runtime.provider)
    const detached: NativeSessionReference[] = []
    let original: NativeSessionReference | undefined
    const connections = vi.spyOn(runtime.provider, 'connection').mockImplementation(() => {
      const manager = originalConnection()
      return { ...manager,
        createSession: async (...args) => {
          original = await manager.createSession(...args)
          if (phase === 'session creation') {
            opening.resolve()
            await publish.promise
          }
          return original
        },
        startTurn: async function* (session, input, signal) {
          bound.resolve()
          await firstBatch.promise
          for await (const event of manager.startTurn(session, input, signal)) {
            yield event
            // Keep the original turn active after its first batch commits.
            if (!signal) throw new Error('Expected the workflow lifetime signal')
            if (!signal.aborted) await once(signal, 'abort')
            signal.throwIfAborted()
          }
        },
        canDetachForRestart: () => true,
        closeForRestart: async session => { detached.push(session) },
      }
    })
    const updateExecution = runtime.runs.updateExecution.bind(runtime.runs)
    const publication = vi.spyOn(runtime.runs, 'updateExecution').mockImplementation(async (...args) => {
      if (phase === 'session publication' && args[0].nativeSessionId) {
        opening.resolve()
        await publish.promise
      }
      return updateExecution(...args)
    })
    let shutdown: Promise<void> | undefined
    let startup: Promise<unknown> | undefined
    let restorePages = () => undefined as void
    try {
      startup = runtime.engine.start(runtime.f.run.id).then(
        () => undefined,
        (error: unknown) => error,
      )
      await opening.promise
      const before = (await runtime.runs.listRepeatExecutions(runtime.f.run.id))[0]!.execution
      expect(before).toMatchObject({ state: 'starting' })
      expect(before).not.toHaveProperty('nativeSessionId')
      const executionPages = runtime.runs.executionPages.bind(runtime.runs)
      const pages = vi.spyOn(runtime.runs, 'executionPages').mockImplementation(async function* (...args) {
        for await (const executions of executionPages(...args)) {
          captured.resolve()
          // Preservation requires a committed binding, even when the page is stale.
          await bound.promise
          yield executions
        }
      })
      restorePages = () => pages.mockRestore()
      shutdown = runtime.engine.shutdown()
      await captured.promise
      publish.resolve()
      await bound.promise
      firstBatch.resolve()
      await shutdown
      const startupError = await startup
      expect(startupError).toBeInstanceOf(DomainError)
      expect(startupError).toMatchObject({ code: 'ENGINE_RESTART' })
      expect(detached).toEqual([original])
      expect(await runtime.runs.hasPendingCleanup(runtime.f.run.id)).toBe(false)
      expect(runtime.provider.closedSessions.has(original!.nativeSessionId)).toBe(false)
      expect(await runtime.runs.get(runtime.f.run.id)).toMatchObject({
        id: runtime.f.run.id, workflowVersionId: fixture.version.id, outcome: 'pending',
      })
      const after = (await runtime.runs.getExecution(before.id))!
      expect(after).toMatchObject({
        id: before.id, nativeSessionId: original!.nativeSessionId,
        agentConfigurationVersionId: before.agentConfigurationVersionId, attempt: before.attempt,
      })
      expect(['running', 'waiting']).toContain(after.state)
      expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 1 })
      const closure = await runtime.db.pool.query<{ detached_reference: unknown }>(
        'select detached_reference from execution_native_closures where execution_id=$1 and detached_at is not null', [before.id])
      expect(closure.rows).toEqual([{ detached_reference: original }])
    } finally {
      publish.resolve()
      firstBatch.resolve()
      shutdown ??= runtime.engine.shutdown()
      await Promise.allSettled([startup, shutdown])
      restorePages()
      publication.mockRestore()
      connections.mockRestore()
      try { await runtime.close() } finally { await database.close() }
    }
  }, 60_000)
})
