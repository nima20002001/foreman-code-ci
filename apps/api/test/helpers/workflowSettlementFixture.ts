import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, CurrentWorkflowSaveResultSchema, type CurrentFixtureForm,
  type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { RunOwnership } from '../../src/modules/runs/ownership.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../../src/modules/runs/repeatPostgres.js'
import { openRepeatCanonicalPublicationLocked } from '../../src/modules/run-graph/repeatPublication.js'
import { allowTechnicalRetryLocked, completeRunLocked } from '../../src/modules/runs/workflowRepositoryServices.js'
import { hasWorkflowExecutionCapacityLocked } from '../../src/modules/runs/workflowExecutionBudget.js'
import type { RepeatRuntimeLifecycle } from '../../src/modules/runs/repeatRuntime.js'
import { finishWorkflowCleanup, persistWorkDirectionWait, requestWorkflowCleanup,
  settleWorkflowRun } from '../../src/modules/runs/workflowLifecycle.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { markRepeatRunRunning } from '../../src/modules/runs/repeatLifecycle.js'
import { repeatDigest, repeatId } from '../../src/modules/runs/repeatResolution.js'
import { insertCurrentRunFixture } from './eng04CurrentRunFixture.js'
import type { currentDatabase } from './eng04CurrentDatabase.js'
import { writerFixture, type WriterFixture } from '../eng04-writer-fixtures.js'
import { graphHeaders } from '../eng04-graph-composition-fixture.js'

/** Actual typed Save, canonical publication, owner, repository and completion
 * writer. The test supplies native terminals and doubles physical closure only. */
export async function workflowSettlementFixture(db: Awaited<ReturnType<typeof currentDatabase>>,
  configure: (graph: WorkflowDefinitionV3, writer: WriterFixture) => WorkflowDefinitionV3 | Promise<WorkflowDefinitionV3>,
  form: CurrentFixtureForm = 'sequential') {
  const writer = await writerFixture(db, form)
  let owner: RunOwnership | undefined
  try {
    const graph = await configure(writer.input.graph, writer)
    const configurations = writer.configurations.filter((configuration) =>
      graph.nodes.some((node) => node.kind !== 'job' && node.agentId === configuration.agentId))
    const pins = Object.fromEntries(configurations.map((configuration) => [configuration.agentId, configuration.id]))
    const response = await writer.app.inject({ method: 'PUT', url: writer.url,
      headers: graphHeaders(writer.writer.token), payload: { ...writer.input, graph,
        expectedAgentConfigurationVersionIds: pins } })
    assert.equal(response.statusCode, 200, response.body)
    const saved = CurrentWorkflowSaveResultSchema.parse(response.json()).value
    const directory = await stat(db.directory, { bigint: true })
    const identity = { device: String(directory.dev), inode: String(directory.ino) }
    const identityHash = `sha256:${createHash('sha256').update(`${identity.device}:${identity.inode}`).digest('hex')}`
    await db.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
      [writer.f.scope.workspaceId, JSON.stringify(identity)])
    const seeded = await insertCurrentRunFixture(db.pool, { ...writer.f, configurations, run: { ...writer.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory,
        locationRevision: 1, identityHash } } }, saved, writer.writer.principal.id)
    const { run, version, scope } = seeded
    owner = await RunOwnership.acquire(db.pool, run.id, () => undefined)
    assert.ok(owner)
    const locations = new WorkspaceLocationService(db.pool, writer.commands, db.directory, 'runner-local')
    await markRepeatRunRunning(owner, locations, { executionState: 'running', outcome: 'pending' })
    let retryPolicy: 'single_retry' | 'production' = 'single_retry'
    const host: RepeatRepositoryHost = { openLocked: async (sql, lockedScope, record) => {
      const storedRun = AcceptedWorkflowRunV3Schema.parse(record)
      const publication = await openRepeatCanonicalPublicationLocked(sql, lockedScope, owner!)
      return {
        run: storedRun,
        assertAuthorityLocked: async () => { owner!.assertOwned() },
        assertAdmissionLocked: async () => { owner!.assertOwned() },
        assertSettlementLocked: async () => { owner!.assertOwned() },
        allowTechnicalRetryLocked: async (transaction, execution) => {
          if (retryPolicy === 'production') return allowTechnicalRetryLocked(transaction, storedRun, version, execution)
          return execution.result?.outcome === 'failed' && execution.result.error?.retryable === true
            && execution.attempt === 1 && await hasWorkflowExecutionCapacityLocked(transaction, run.id, version)
        },
        publishLocked: (_transaction, effect, facts, mutate) => publication.publishEffectLocked(effect, facts, mutate),
        assertPublicationReceiptLocked: (_transaction, effect) => publication.assertEffectReceiptLocked(effect),
        completeRunLocked: (transaction, terminals) => completeRunLocked(transaction, storedRun, version, terminals, owner!),
      }
    } }
    let store = new RepeatRunRepository(owner, host, version)
    const readRun = async () => AcceptedWorkflowRunV3Schema.parse(
      (await db.pool.query('select record from runs where id=$1', [run.id])).rows[0]?.record)
    let failureSettlements = 0
    const lifecycle: RepeatRuntimeLifecycle = {
      preflight: async () => undefined,
      markRunning: async () => undefined,
      currentState: async () => ({ executionState: (await readRun()).executionState, stopRequested: false }),
      persistWait: async () => false,
      persistDirectionWait: () => persistWorkDirectionWait(owner!, locations),
      cancelNativeAndRequestCleanup: async () => true,
      requestCleanup: (failure) => requestWorkflowCleanup(db.pool, run.id, owner!, failure),
      settleRun: async (_stopped, interrupted) => {
        if (await settleWorkflowRun(owner!, interrupted)) failureSettlements++
      },
      finishNative: async () => undefined,
      finishCleanup: () => finishWorkflowCleanup(owner!, false),
    }
    return { ...writer, run, version, scope, lifecycle, readRun,
      get store() { return store },
      get owner() { return owner! },
      host,
      get failureSettlements() { return failureSettlements },
      setProductionRetryPolicy() { retryPolicy = 'production' },
      async restart() {
        await owner!.release()
        owner = await RunOwnership.acquire(db.pool, run.id, () => undefined)
        assert.ok(owner)
        store = new RepeatRunRepository(owner, host, version)
      },
      candidate(nodeId: string, attempt = 1) {
        const node = version.definition.nodes.find((item) => item.id === nodeId)
        assert.ok(node && node.kind !== 'job')
        return HarnessExecutionSchema.parse({ id: `execution-${randomUUID()}`, runId: run.id,
          workflowNodeId: node.id, agentId: node.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
          attempt, input: {}, state: 'queued', createdAt: new Date().toISOString() })
      },
      async finish(executionId: string, result: ExecutionResult) {
        const { execution } = await store.readExecution(executionId)
        const next = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result,
          finishedAt: new Date().toISOString() })
        await owner!.oneShotConnection().transaction(async (sql) => {
          const publication = await openRepeatCanonicalPublicationLocked(sql, scope, owner!)
          const source = { execution: next }
          const sourceDigest = repeatDigest(source)
          await publication.publishNativeLocked({ kind: 'observation', scope,
            ref: { nodeId: execution.workflowNodeId, occurrence: null }, previous: execution, next,
            source, sourceDigest, sourceRevision: '1', effect: null,
            sourceId: repeatId('repeat-native', run.id, 'outside', executionId, 'observation', sourceDigest),
          }, async () => {
            await sql.query('update harness_executions set record=$2::jsonb where id=$1',
              [executionId, JSON.stringify(next)])
          })
        })
        return next
      },
      async accept(executionId: string) {
        return store.acceptWorkTerminal(executionId, (attempt) => {
          throw new Error(`Unexpected retry ${attempt}`)
        })
      },
      async close() { await owner?.release(); await writer.app.close() },
    }
  } catch (error) {
    await owner?.release()
    await writer.app.close()
    throw error
  }
}
