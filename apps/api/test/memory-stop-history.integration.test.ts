import { expect, it, vi } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { memoryCall, memoryWorkflow } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { memoryExecution } from '../src/modules/collaboration/memoryExecution.js'
import { lockSelections } from '../src/modules/memory-boards/batch.js'
import { workKey } from '../src/modules/memory-boards/identity.js'
import { deferred } from './helpers/deferred.js'

it.runIf(postgresEnabled)('stops without reserving unrelated historical interval work', async () => {
  const fixture = memoryWorkflow('single')
  delete fixture.version.definition.handoffs
  agentWorkflowNode(fixture.version.definition.nodes[0]).interval = { everySeconds: 10 }
  const runtime = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [] })
  const held = deferred(), release = deferred()
  let holding: Promise<unknown> | undefined, stopping: Promise<unknown> | undefined
  try {
    const prepared = await prepareCoordinationWorkflow(runtime)
    const started = await prepared.start()
    let tickId: string | undefined
    await vi.waitFor(async () => {
      const details = await runtime.runs.getDetails(prepared.scope.workspaceId, started.run.id)
      tickId = details?.executions.find(execution => execution.state === 'completed'
        && typeof execution.input === 'object' && execution.input !== null && !Array.isArray(execution.input)
        && execution.input.tick)?.id
      expect(tickId).toBeDefined()
    }, { timeout: 30000, interval: 100 })
    holding = withExclusiveGraphConnection(runtime.db.pool, connection => connection.transaction(async tx => {
      const saved = await memoryExecution(tx, tickId!)
      await lockSelections(tx, [], [workKey(saved.work)])
      held.resolve()
      await release.promise
    }))
    await held.promise
    stopping = memoryCall(runtime.client, 'run_stop', { workspaceId: prepared.scope.workspaceId, runId: started.run.id })
    await vi.waitFor(async () => expect((await runtime.runs.get(started.run.id))?.outcome).toBe('canceled'),
      { timeout: 5000, interval: 50 })
    await stopping
  } finally {
    release.resolve()
    await Promise.allSettled([holding, stopping])
    await runtime.close()
  }
}, 60000)
