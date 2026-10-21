import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { WorkspaceLocationSetResultSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, RunStartV3InputSchema,
  RunStartV3ResultSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'

describe.runIf(postgresEnabled)('restart during native startup', () => {
  for (const boundary of ['reservation', 'authorization'] as const) {
    it.each([false, true])(
      `drains ${boundary} preflight paused across restart and preserves the Run (disposal fails first=%s)`, async failFirst => {
        const runtime = await currentOperatorIntegration({
          fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
          approvalNodeIds: [], insertRun: false,
        })
        const paused = rejectableDeferred()
        const release = rejectableDeferred()
        const restarting = rejectableDeferred()
        let pauseNext = true
        let startupFailure: unknown
        let failDisposal = failFirst
        let disposalAttempts = 0
        let disposed = 0
        let shutdown: Promise<unknown> | undefined
        const connection = runtime.provider.connection.bind(runtime.provider)
        const connections = vi.spyOn(runtime.provider, 'connection').mockImplementation(() => {
          const manager = connection()
          const dispose = manager.dispose?.bind(manager)
          if (!dispose) throw new Error('Expected provider disposal.')
          return { ...manager, dispose: async () => {
            disposalAttempts++
            if (failDisposal) {
              failDisposal = false
              throw new Error('Original transport disposal is unconfirmed.')
            }
            await dispose()
            disposed++
          } }
        })
        const begin = PostgresWorkflowClosureStore.prototype.begin
        const reservation = vi.spyOn(PostgresWorkflowClosureStore.prototype, 'begin')
          .mockImplementation(async function (this: PostgresWorkflowClosureStore, execution) {
            if (boundary === 'reservation' && pauseNext) {
              pauseNext = false
              paused.resolve()
              await release.promise
            }
            try {
              return await begin.call(this, execution)
            } catch (error) {
              startupFailure = error
              throw error
            }
          })
        const authorize = runtime.locations.revalidateRunAuthorization.bind(runtime.locations)
        const authorization = vi.spyOn(runtime.locations, 'revalidateRunAuthorization')
          .mockImplementation(async (...args) => {
            if (boundary === 'authorization' && pauseNext && args[3] === runtime.db.pool) {
              const registered = await runtime.db.pool.query('select 1 from execution_native_closures')
              if (registered.rowCount) {
                pauseNext = false
                paused.resolve()
                await release.promise
              }
            }
            try {
              return await authorize(...args)
            } catch (error) {
              startupFailure = error
              throw error
            }
          })
        const closeForRestart = runtime.native.closeForRestart.bind(runtime.native)
        const close = vi.spyOn(runtime.native, 'closeForRestart').mockImplementation(() => {
          const closing = closeForRestart()
          restarting.resolve()
          return closing
        })
        try {
          // Start validates filesystem identity; the seeded synthetic location is insufficient.
          const locationResponse = await runtime.client.callTool({ name: 'workspace_location_set', arguments: {
            workspaceId: runtime.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
            runnerId: LOCAL_RUNNER_ID, rootPath: runtime.db.directory,
          } })
          expect(locationResponse.isError, JSON.stringify(decodeMcpToolResult(locationResponse))).not.toBe(true)
          const location = WorkspaceLocationSetResultSchema.parse(decodeMcpToolResult(locationResponse)).value
          const savedResponse = await runtime.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save,
            arguments: await runtime.create() })
          expect(savedResponse.isError).not.toBe(true)
          const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResponse)).value
          const input = RunStartV3InputSchema.parse({
            workspaceId: saved.workspaceId, workflowId: saved.workflowId, workflowVersionId: saved.version.id,
            commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: saved.revision,
            expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
            expectedLocationRevision: location.locationRevision, input: {},
          })
          const reader = await runtime.access.issue({
            name: 'Startup read-only caller', audience: 'operator',
            expiresAt: new Date(Date.now() + 300_000),
            grants: [{ actions: ['runs:read'], scope: { workspaceIds: [saved.workspaceId] } }],
          })
          const deniedClient = await runtime.connect(reader.token)
          const denied = await deniedClient.callTool({ name: 'run_start', arguments: input })
          expect(denied.isError).toBe(true)
          expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
          const deniedReceipts = await runtime.db.pool.query(`select command_id from management_command_receipts
            where operation='run.start' and principal_id=$1 and command_id=$2`,
          [reader.principal.id, input.commandId])
          expect(deniedReceipts.rows).toEqual([])

          const startedResponse = await runtime.client.callTool({ name: 'run_start', arguments: input })
          const startedResult = decodeMcpToolResult(startedResponse)
          expect(startedResponse.isError, JSON.stringify(startedResult)).not.toBe(true)
          const started = RunStartV3ResultSchema.parse(startedResult)
          expect(started).toMatchObject({ accepted: true, replayed: false, run: {
            outcome: 'pending', executionLocation: { locationRevision: location.locationRevision },
          } })
          await paused.promise
          expect(startupFailure).toBeUndefined()
          expect(runtime.provider.counts).toMatchObject({ sessions: 0, starts: 0 })
          const receipt = await runtime.db.pool.query(`select r.id from runs r join management_command_receipts c
            on c.operation='run.start' and c.result->>'id'=r.id
            where r.id=$1 and c.principal_id=$2 and c.command_id=$3`,
          [started.run.id, runtime.writer.principal.id, input.commandId])
          expect(receipt.rows).toEqual([{ id: started.run.id }])
          shutdown = runtime.engine.shutdown().then(() => undefined, (error: unknown) => error)
          await restarting.promise
          const cleanup = await runtime.db.pool.query(
            'select run_id from run_cleanup_intents where run_id=$1 and pending', [started.run.id])
          // Restart defers the in-flight attempt to a fresh attempt; it does not fence the Run.
          expect(cleanup.rows).toEqual([])
          expect(disposalAttempts).toBe(0)
          release.resolve()
          const shutdownError = await shutdown
          // Without a Run fence the preflight passes; the closing owner still starts no native session.
          expect(startupFailure).toBeUndefined()
          if (failFirst) {
            expect(shutdownError).toBeInstanceOf(AggregateError)
            expect(disposed).toBe(0)
            await runtime.engine.shutdown()
          } else {
            expect(shutdownError).toBeUndefined()
          }
          expect(disposed).toBe(1)
          expect(disposalAttempts).toBe(failFirst ? 2 : 1)
          expect(runtime.provider.counts).toMatchObject({ sessions: 0, starts: 0 })
          const read = await deniedClient.callTool({ name: 'run_get', arguments: {
            workspaceId: saved.workspaceId, runId: started.run.id, detail: 'full',
          } })
          expect(read.isError).not.toBe(true)
          expect(decodeMcpToolResult(read)).toMatchObject({ run: {
            id: started.run.id, workflowVersionId: saved.version.id, outcome: 'pending',
          } })
        } finally {
          release.resolve()
          failDisposal = false
          await shutdown
          try {
            await runtime.close()
          } finally {
            connections.mockRestore()
            reservation.mockRestore()
            authorization.mockRestore()
            close.mockRestore()
          }
        }
      }, 60_000,
    )
  }

  it.each(['created', 'binding'] as const)(
    'reaches restart closure while native startup is blocked at %s', async boundary => {
      const runtime = await currentOperatorIntegration({
        fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [],
      })
      const paused = rejectableDeferred()
      const release = rejectableDeferred()
      const restarting = rejectableDeferred()
      let observed: NativeSessionReference | undefined
      let shutdown: Promise<unknown> | undefined
      let starting: Promise<unknown> | undefined
      const connection = runtime.provider.connection.bind(runtime.provider)
      const connections = vi.spyOn(runtime.provider, 'connection').mockImplementation(() => {
        const manager = connection()
        const createSession = manager.createSession.bind(manager)
        return { ...manager, createSession: async (...args: Parameters<typeof manager.createSession>) => {
          observed = await createSession(...args)
          if (boundary === 'created') {
            paused.resolve()
            await release.promise
          }
          return observed
        } }
      })
      const updateExecution = runtime.runs.updateExecution.bind(runtime.runs)
      const publication = vi.spyOn(runtime.runs, 'updateExecution').mockImplementation(async (...args) => {
        if (boundary === 'binding' && args[0].nativeSessionId && args[0].state === 'running') {
          paused.resolve()
          await release.promise
        }
        await updateExecution(...args)
      })
      const closeForRestart = runtime.native.closeForRestart.bind(runtime.native)
      const close = vi.spyOn(runtime.native, 'closeForRestart').mockImplementation(() => {
        const closing = closeForRestart()
        restarting.resolve()
        return closing
      })
      try {
        starting = runtime.engine.start(runtime.f.run.id).then(() => undefined, (error: unknown) => error)
        await Promise.race([paused.promise, starting.then(() => {
          throw new Error('The Run finished before the startup boundary.')
        })])
        shutdown = runtime.engine.shutdown().then(() => undefined, (error: unknown) => error)
        const reachedClosure = await Promise.race([
          restarting.promise.then(() => true),
          shutdown.then(() => false),
        ])
        expect(reachedClosure).toBe(true)
        expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 0 })
        expect(runtime.provider.closedSessions.has(observed!.nativeSessionId)).toBe(false)
        release.resolve()
        expect(await shutdown).toBeUndefined()
        expect(runtime.provider.closedSessions.has(observed!.nativeSessionId)).toBe(true)
        expect(runtime.provider.counts.starts).toBe(0)
        const read = await runtime.client.callTool({ name: 'run_get', arguments: {
          workspaceId: runtime.f.scope.workspaceId, runId: runtime.f.run.id, detail: 'full',
        } })
        expect(read.isError).not.toBe(true)
        expect(decodeMcpToolResult(read)).toMatchObject({ run: {
          id: runtime.f.run.id, workflowVersionId: runtime.f.version.id, outcome: 'pending',
        } })
      } finally {
        release.resolve()
        await shutdown
        await starting
        try {
          await runtime.close()
        } finally {
          connections.mockRestore()
          publication.mockRestore()
          close.mockRestore()
        }
      }
    }, 60_000,
  )

  it.each(['created', 'binding', 'bound'] as const)(
    'drains native startup paused at %s before closing its original manager', async boundary => {
      const runtime = await currentOperatorIntegration({
        fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
        approvalNodeIds: [], insertRun: false,
      })
      const paused = rejectableDeferred()
      const release = rejectableDeferred()
      const restarting = rejectableDeferred()
      let pauseNext = true
      let observed: NativeSessionReference | undefined
      let executionId: string | undefined
      let disposals = 0
      let restartCloses = 0
      let shutdown: Promise<unknown> | undefined
      const holdAtBoundary = async () => {
        pauseNext = false
        paused.resolve()
        await release.promise
      }
      const connection = runtime.provider.connection.bind(runtime.provider)
      const connections = vi.spyOn(runtime.provider, 'connection').mockImplementation(() => {
        const manager = connection()
        const createSession = manager.createSession.bind(manager)
        const dispose = manager.dispose?.bind(manager)
        const closeForRestart = manager.closeForRestart?.bind(manager)
        if (!dispose || !closeForRestart) throw new Error('Expected provider shutdown support.')
        return { ...manager,
          createSession: async (...args: Parameters<typeof manager.createSession>) => {
            if (!isWorkflowStart(args[0])) throw new Error('Expected workflow session creation.')
            const session = await createSession(...args)
            observed = session
            executionId = args[0].request.executionId
            if (boundary === 'created' && pauseNext) await holdAtBoundary()
            return session
          },
          dispose: async () => {
            await dispose()
            disposals++
          },
          closeForRestart: async (session: NativeSessionReference) => {
            await closeForRestart(session)
            restartCloses++
          },
        }
      })
      const updateExecution = runtime.runs.updateExecution.bind(runtime.runs)
      const publication = vi.spyOn(runtime.runs, 'updateExecution').mockImplementation(async (...args) => {
        const firstBinding = pauseNext && args[0].nativeSessionId !== undefined && args[0].state === 'running'
        if (firstBinding && boundary === 'binding') await holdAtBoundary()
        await updateExecution(...args)
        if (firstBinding && boundary === 'bound') await holdAtBoundary()
      })
      const closeForRestart = runtime.native.closeForRestart.bind(runtime.native)
      const close = vi.spyOn(runtime.native, 'closeForRestart').mockImplementation(() => {
        const closing = closeForRestart()
        restarting.resolve()
        return closing
      })
      try {
        const locationResponse = await runtime.client.callTool({ name: 'workspace_location_set', arguments: {
          workspaceId: runtime.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
          runnerId: LOCAL_RUNNER_ID, rootPath: runtime.db.directory,
        } })
        expect(locationResponse.isError).not.toBe(true)
        const location = WorkspaceLocationSetResultSchema.parse(decodeMcpToolResult(locationResponse)).value
        const savedResponse = await runtime.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save,
          arguments: await runtime.create() })
        expect(savedResponse.isError).not.toBe(true)
        const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResponse)).value
        const input = RunStartV3InputSchema.parse({
          workspaceId: saved.workspaceId, workflowId: saved.workflowId, workflowVersionId: saved.version.id,
          commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: saved.revision,
          expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
          expectedLocationRevision: location.locationRevision, input: {},
        })
        const reader = await runtime.access.issue({
          name: 'Startup read-only caller', audience: 'operator',
          expiresAt: new Date(Date.now() + 300_000),
          grants: [{ actions: ['runs:read'], scope: { workspaceIds: [saved.workspaceId] } }],
        })
        const deniedClient = await runtime.connect(reader.token)
        const denied = await deniedClient.callTool({ name: 'run_start', arguments: input })
        expect(denied.isError).toBe(true)
        expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        const deniedReceipts = await runtime.db.pool.query(`select command_id from management_command_receipts
          where operation='run.start' and principal_id=$1 and command_id=$2`, [reader.principal.id, input.commandId])
        expect(deniedReceipts.rows).toEqual([])

        const response = await runtime.client.callTool({ name: 'run_start', arguments: input })
        expect(response.isError, JSON.stringify(decodeMcpToolResult(response))).not.toBe(true)
        const started = RunStartV3ResultSchema.parse(decodeMcpToolResult(response))
        expect(started).toMatchObject({ accepted: true, replayed: false })
        await paused.promise
        expect(observed).toBeDefined()
        expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 0 })
        const reservation = await runtime.db.pool.query(`select generation::text,execution_identity,expected_reference
          from execution_native_closures where execution_id=$1`, [executionId])
        expect(reservation.rows).toHaveLength(1)
        expect(reservation.rows[0]).toMatchObject({ execution_identity: { id: executionId }, expected_reference: null })

        shutdown = runtime.engine.shutdown().then(() => undefined, (error: unknown) => error)
        await Promise.race([
          restarting.promise,
          shutdown.then(error => {
            throw error ?? new Error('Shutdown finished before native startup was drained.')
          }),
        ])
        const binding = await runtime.db.pool.query(`select e.record->>'nativeSessionId' as session_id,s.reference
          from harness_executions e left join execution_native_sessions s on s.execution_id=e.id
          where e.id=$1`, [executionId])
        expect(binding.rows).toEqual([{ session_id: boundary === 'bound' ? observed!.nativeSessionId : null,
          reference: boundary === 'bound' ? observed : null }])
        expect(disposals).toBe(0)
        expect(restartCloses).toBe(0)
        release.resolve()
        expect(await shutdown).toBeUndefined()
        expect(runtime.provider.closedSessions.has(observed!.nativeSessionId)).toBe(true)
        expect(disposals).toBe(boundary === 'bound' ? 0 : 1)
        expect(restartCloses).toBe(boundary === 'bound' ? 1 : 0)
        expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 0, attaches: 0 })
        const closure = await runtime.db.pool.query(`select generation::text,execution_identity,expected_reference,
          detached_reference,detached_at is not null as detached from execution_native_closures where execution_id=$1`,
        [executionId])
        expect(closure.rows).toEqual([{ ...reservation.rows[0],
          detached_reference: boundary === 'bound' ? observed : null, detached: boundary === 'bound' }])
        const read = await deniedClient.callTool({ name: 'run_get', arguments: {
          workspaceId: saved.workspaceId, runId: started.run.id, detail: 'full',
        } })
        expect(read.isError).not.toBe(true)
        expect(decodeMcpToolResult(read)).toMatchObject({ run: {
          id: started.run.id, workflowVersionId: saved.version.id, outcome: 'pending',
        } })
      } finally {
        release.resolve()
        try {
          await shutdown
        } finally {
          try {
            await runtime.close()
          } finally {
            connections.mockRestore()
            publication.mockRestore()
            close.mockRestore()
          }
        }
      }
    }, 60_000,
  )
})
