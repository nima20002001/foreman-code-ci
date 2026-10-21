import { deferred } from './deferred.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import {
  CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema, SavedRunDetailsSchema,
  makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { RunManagementService } from '../../src/modules/runs/management.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { createCurrentNativeProductionFactory } from '../../src/modules/runs/workflowProduction.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import { placedContinuationValidator } from '../../src/modules/placement/continuation.js'
import { readDispatchIntent, readExecutionPlacement, readNativePlacement } from '../../src/modules/placement/persistence.js'
import { readLiveManagementPrincipal } from '../../src/modules/access/liveManagementPrincipal.js'
import { interactionConnection } from '../../src/modules/interactions/connection.js'
import { credentialAuthority } from '../../src/modules/interactions/wave25/credentialAuthority.js'
import * as continuation from '../../src/modules/runs/continuation.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { mixedComputerPlacement } from './mixedComputerPlacement.js'
import { readUntil } from './observableCondition.js'
import { prepareHandoffSource } from './handoffSourcePreparation.js'
import { handoffOutput } from './workHandoffSiblings.js'

/** Real placement, graph, lifecycle and MCP services; only the native provider
 * and physical source preparation are synthetic. No device or CI job is contacted. */
export async function handoffPlacementFixture(options: { checkOutcome?: 'qualified' | 'failed' } = {}) {
  const failedCheck = options.checkOutcome === 'failed'
  const completion = deferred<void>()
  const definition = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
  definition.version.definition.nodes = definition.version.definition.nodes.map(node => {
    const agent = { ...node }
    delete agent.join
    return agent
  })
  definition.version.definition.handoffs = { contractVersion: 1 }
  definition.version.definition.executionPolicy = { maxParallelism: 3, maxNodeExecutions: 4 }
  const coordinator = definition.version.definition.nodes[0]!
  const workers = definition.version.definition.nodes.slice(1)
  definition.version.definition.edges = workers.map(node => ({
    id: randomUUID(), kind: 'execution', source: coordinator.id, target: node.id,
  }))
  let placement: Awaited<ReturnType<typeof mixedComputerPlacement>> | undefined
  let runId: string | undefined
  let validatePlacement: ReturnType<typeof placedContinuationValidator>
  const continuationSpy = vi.spyOn(continuation, 'continuationValidator').mockImplementation(
    () => (executionId, signal) => validatePlacement(executionId, signal))
  let base: Awaited<ReturnType<typeof currentOperatorIntegration>>
  try {
    base = await currentOperatorIntegration({ fixture: definition, insertRun: false,
      approvalNodeIds: [], workerParallelism: 3, collaborationPorts: {},
      onRunTerminal: async () => { completion.resolve() },
      outputFor: handoffOutput,
      admitPlacementExecutionLocked: async (sql, owner, run, execution, ref, digest) => {
        if (!placement) throw new Error('Placement fixture is not ready.')
        await placement.producer.admitExecution(sql, owner, execution, ref, digest, run.authorizationPrincipalId)
      },
      preparePlacementExecution: async (owner, run, execution) => {
        if (!placement) throw new Error('Placement fixture is not ready.')
        if (failedCheck && execution.workflowNodeId === workers[1]!.id) {
          await readUntil(() => owner.oneShotConnection().transaction(async sql => (await sql.query(
            'select count(*)::integer as total from harness_executions where run_id=$1', [run.id])).rows[0]?.total),
          total => total === 4,
          { timeoutMs: 10_000, description: 'all handed-off node reservations' })
        }
        return prepareHandoffSource(owner, run, execution, placement)
      },
    })
  } finally {
    continuationSpy.mockRestore()
  }
  const directory = join(base.db.directory, 'handoff-placement')
  try {
    await mkdir(directory, { mode: 0o700 })
    placement = await mixedComputerPlacement(base, directory, { deviceCount: 2 })
    const producer = placement.producer
    validatePlacement = placedContinuationValidator(base.db.pool, base.locations, {
      async prepare(executionId) {
        const sql = interactionConnection.getStore() ?? base.db.pool
        const accepted = await readExecutionPlacement(sql, executionId)
        if (!accepted) return null
        const intent = await readDispatchIntent(sql, executionId)
        const executionPlacement = await readNativePlacement(sql, executionId)
        if (!intent || !executionPlacement) throw new Error('Placed native work requires its prepared source and dispatch.')
        return { placement: accepted, intent, executionPlacement }
      },
    }, {
      async assertCurrent(binding, signal) {
        const sql = interactionConnection.getStore() ?? base.db.pool
        const run = await base.runs.get(binding.intent.runId)
        if (!run) throw new Error('Placed native work requires its saved Run.')
        const current = await credentialAuthority(sql, binding.intent.executionId, 'workflow')
        await producer.assertPinsCurrent(sql, binding.placement,
          await readLiveManagementPrincipal(sql, run.authorizationPrincipalId), run.workspaceId,
          current.nativeSessionId ? { purpose: 'resident' } : undefined)
        signal?.throwIfAborted()
      },
    })
    base.services.workflows = new WorkflowManagementService(base.db.pool, base.commands, {
      worktrees: { readyRoot: async () => undefined, sources: placement.sources, roots: placement.policies },
    })
    const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
      reportDispatchFailure: (_id, _code, error) => base.dispatchErrors.push(error),
    })({ primaryPool: base.db.pool, commands: base.commands, runs: base.runs, workflows: base.workflows,
      locations: base.locations, engine: base.engine, nativeExecutions: base.native,
      interactions: base.service, checkpointer: base.checkpointer })
    base.services.runs = new RunManagementService(base.db.pool, base.commands, base.runs, base.engine,
      base.locations, { ...binding, startPublication: { ...binding.startPublication,
        placementAdmission: placement.producer,
        workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }) } })
    const input = await base.create()
    input.graph.nodes = input.graph.nodes.map((node, index) => ({ ...node,
      placement: index < 2 ? placement!.local : placement!.remotes[index - 2]!,
    }))
    const savedResult = await base.client.callTool({ name: 'workflow_save_v3', arguments: input })
    if (savedResult.isError) throw new Error(JSON.stringify(savedResult))
    const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResult)).value
    const startInput = { workspaceId: saved.version.workspaceId, workflowId: saved.version.workflowId,
      workflowVersionId: saved.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
      expectedWorkflowRevision: saved.revision,
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: placement.locationRevision, input: {} }
    let refreshed = false
    base.provider.beforeClose = async () => {
      if (refreshed) return
      refreshed = true
      const remote = placement!.remotes[0]!
      if (remote.hostRef.kind !== 'device') throw new Error('Expected a Worker placement.')
      const deviceId = remote.hostRef.deviceId
      const row = (await base.db.pool.query<{ record: unknown }>(
        'select record from harness_instance_profile_evidence where instance_id=$1', [remote.instanceId])).rows[0]!
      const proof = HostHarnessProfileEvidenceSchema.parse(row.record)
      const replacement = { ...proof, connectionGeneration: 'reconnected', qualified: !failedCheck,
        checkedAt: new Date().toISOString(),
        ...(failedCheck ? { failure: { code: 'NATIVE_CHECK_FAILED', message: 'The native profile check failed.' } } : {}) }
      await base.db.pool.query(`insert into harness_instance_profile_evidence(check_id,instance_id,instance_revision,record)
        values($1,$2,1,$3::jsonb)`, [randomUUID(), remote.instanceId, JSON.stringify(replacement)])
      placement!.installations.refresh(placement!.installations.list().map(installation => ({ ...installation,
        connectionGeneration: installation.hostRef.kind === 'device'
          && installation.hostRef.deviceId === deviceId ? 'reconnected' : installation.connectionGeneration,
      })))
    }
    return { base, saved, startInput, coordinator, workers, placement, finished: completion.promise,
      async start() {
        const result = await base.client.callTool({ name: 'run_start', arguments: startInput })
        if (result.isError) throw new Error(JSON.stringify(result))
        const accepted = RunStartV3ResultSchema.parse(decodeMcpToolResult(result))
        runId = accepted.run.id
        return accepted
      },
      async details() {
        if (!runId) throw new Error('Start the Run before reading it.')
        const result = await base.client.callTool({ name: 'run_get', arguments: {
          detail: 'full', workspaceId: startInput.workspaceId, runId,
        } })
        if (result.isError) throw new Error(JSON.stringify(result))
        return SavedRunDetailsSchema.parse(decodeMcpToolResult(result))
      },
      async close() {
        delete base.provider.beforeClose
        await base.close()
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    delete base.provider.beforeClose
    await base.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
