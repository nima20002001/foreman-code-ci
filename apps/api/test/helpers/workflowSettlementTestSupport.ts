import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph'
import { afterAll, beforeAll, vi } from 'vitest'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { executeRepeatRuntime } from '../../src/modules/runs/repeatRuntime.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { nim2691TaskDatabase } from './nim2691Database.js'
import type { currentDatabase } from './eng04CurrentDatabase.js'
import { workflowSettlementFixture } from './workflowSettlementFixture.js'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { OperatorInteractionService } from '../../src/modules/interactions/operator.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { graphRpc } from '../eng04-graph-composition-fixture.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { admitRepeatRun, type RepeatStartPublication } from '../../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'

export type Fixture = Awaited<ReturnType<typeof workflowSettlementFixture>>
export const timeout = 120000
export const finish = (revision = 1): ExecutionResult => ({ outcome: 'succeeded', output: {
  routing: { kind: 'finish' }, data: { latestDeliverable: { revision }, remainingFindings: [] },
} })
export const failed = (retryable: boolean): ExecutionResult => ({ outcome: 'failed',
  error: { code: 'PROVIDER_FAILED', message: 'Native execution failed.', retryable } })
export const handoffs = (budget: number) => (graph: WorkflowDefinitionV3): WorkflowDefinitionV3 => ({ ...graph,
  handoffs: { contractVersion: 1 }, executionPolicy: { maxParallelism: 2, maxNodeExecutions: budget },
})

export function useSettlementFixtures() {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let release: (() => void) | undefined
  let lifetime: Promise<void> | undefined

  beforeAll(async () => {
    const released = new Promise<void>((resolve) => { release = resolve })
    let ready: () => void
    const initialized = new Promise<void>((resolve) => { ready = resolve })
    lifetime = nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      database = { pool, directory, schema: 'public', close: async () => undefined }
      ready()
      await released
    })
    await Promise.race([initialized, lifetime])
  }, timeout)

  afterAll(async () => {
    release?.()
    await lifetime
  }, timeout)

  return async function withFixture(
    configure: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3,
    work: (fixture: Fixture) => Promise<void>,
    form: 'single' | 'sequential' | 'parallel' = 'sequential',
  ) {
    const fixture = await workflowSettlementFixture(database, configure, form)
    try {
      await work(fixture)
    } finally {
      await fixture.close()
    }
  }
}

export async function acceptedActivation(f: Fixture, activationId: string, result: ExecutionResult) {
  const admitted = await f.store.admitWorkActivation(activationId, (nodeId) => f.candidate(nodeId))
  await f.finish(admitted.execution.id, result)
  const accepted = await f.accept(admitted.execution.id)
  assert.equal(accepted.kind, 'accepted')
  return accepted.execution
}

export async function sourceAndRequest(f: Fixture) {
  const entry = await f.store.ensureWorkEntry()
  const source = await acceptedActivation(f, entry, finish())
  const request = await f.store.admitWorkRequest(source.id, f.version.definition.edges[0]!.id)
  assert.equal(request.kind, 'accepted')
  return { source, request: request.request }
}

export function runtime(f: Fixture, observe: (execution: HarnessExecution) => Promise<void>, saver = new MemorySaver()) {
  return () => executeRepeatRuntime({ runId: f.run.id, version: f.version, store: f.store,
    owner: { assertOwned() {} }, signal: new AbortController().signal, checkpointer: saver,
    driver: { candidate: (ref, attempt) => f.candidate(ref.nodeId, attempt), observe }, lifecycle: f.lifecycle })
}

export async function directionApi(f: Fixture, publication: RepeatStartPublication = repeatStartPublication) {
  const repository = new Wave25InteractionRepository(f.db.pool)
  const service = new InteractionService(repository, new PostgresApprovalBudgetRepository(f.db.pool),
    {} as never, async () => { throw new Error('Direction must not resume a native approval') })
  const locations = new WorkspaceLocationService(f.db.pool, f.commands)
  const start = vi.fn(async (principal: Parameters<typeof admitRepeatRun>[2], source: 'http' | 'mcp',
    input: Parameters<typeof admitRepeatRun>[4], options: Parameters<typeof admitRepeatRun>[6] = {}) => {
    const accepted = await admitRepeatRun(f.db.pool, locations, principal, source, input, publication, options)
    return { run: accepted.value }
  })
  service.useWorkDirectionActions({ start, wake: async () => undefined })
  const app = buildApp({
    readiness: {
      database: { ping: async () => { await f.db.pool.query('select 1') } },
      checkpoints: { ping: async () => undefined },
    },
    operator: { access: f.access, services: {
    commands: f.commands, interactions: new OperatorInteractionService(service),
    runGraph: new RunGraphReadService(f.db.pool, { qualifiedReads: true }),
  } as unknown as OperatorServices } })
  await app.ready()
  const call = async (name: string, args: unknown, token = f.writer.token) => {
    const result = await graphRpc(app, token, 'tools/call', { name, arguments: args })
    return result.result
  }
  return { app, call, service, repository, start }
}
