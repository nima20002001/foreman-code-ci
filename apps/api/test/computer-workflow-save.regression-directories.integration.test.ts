import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('saves a completed computer workflow using each accepted native directory and rejects changed execution directories', async () => {
  // Directory validation needs two native executions, but only one identical harness profile.
  const fixture = await remoteReviewProduction({
    workflow: 'sequential', parallelProfileChecks: true, reuseMatchingProfiles: true, parallelSetup: true,
    includeNodeRuntimePayload: false,
  })
  try {
    const started = await fixture.start()
    const details = await waitForRemoteReview(async () => {
      const current = await fixture.details(started.run.id)
      if (current.run.executionState === 'completed' && !current.cleanupPending) return current
      // Active Runs can yield after bounded settlement retries and need another engine pass.
      await fixture.reconcile()
      return fixture.details(started.run.id)
    }, value => value.run.executionState === 'completed' && !value.cleanupPending, 'completed remote workflow cleanup')
    expect(details.run.outcome).toBe('succeeded')
    expect(details.executions).toHaveLength(2)
    expect(details.executions.every(execution => execution.nativeSessionId
      && execution.workingDirectory !== details.run.executionLocation?.rootPath)).toBe(true)
    const scope = { workspaceId: details.run.workspaceId, workflowId: details.run.workflowId }
    const before = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
    const graph = structuredClone(before.version.definition)
    agentWorkflowNode(graph.nodes[0]).initialPrompt = 'Use the updated instructions on the next Run.'
    const input = { ...scope, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: before.revision, expectedWorkflowVersionId: before.version.id,
      expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds, graph }
    const reader = await fixture.access.issue({ name: 'Workflow read only', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['workflows:read', 'graph:read'], scope: {} }] })
    const denied = await fixture.call(CURRENT_WORKFLOW_TOOLS.save, input, reader.token)
      .then(result => ({ result }), (error: unknown) => ({ error }))
    if ('error' in denied) expect(denied.error).toMatchObject({ code: -32602 })
    else expect(denied.result.isError).toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.save, input)).value
    expect(saved.version.id).not.toBe(details.run.workflowVersionId)
    const [persisted, retainedRun] = await Promise.all([
      fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope),
      fixture.details(started.run.id),
    ])
    expect(CurrentWorkflowReadResultSchema.parse(persisted).version).toEqual(saved.version)
    expect(retainedRun.run).toEqual(details.run)

    const execution = details.executions[0]!
    const originalDirectory = execution.workingDirectory!
    await fixture.db.pool.query("update harness_executions set record=jsonb_set(record,'{workingDirectory}',to_jsonb($2::text)) where id=$1",
      [execution.id, '/different-execution-directory'])
    try {
      const changedGraph = structuredClone(saved.version.definition)
      agentWorkflowNode(changedGraph.nodes[0]).initialPrompt += ' Another edit.'
      await expect(fixture.value(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID(),
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.version.id, graph: changedGraph }))
        .rejects.toThrow('WORKFLOW_RUNS_UNSETTLED')
    } finally {
      await fixture.db.pool.query("update harness_executions set record=jsonb_set(record,'{workingDirectory}',to_jsonb($2::text)) where id=$1",
        [execution.id, originalDirectory])
    }
  } catch (error) {
    console.error('Computer workflow failure codes', fixture.failures())
    console.error('Computer workflow executions', (await fixture.db.pool.query(`select id,record->>'state' as state,
      record->'error' as error,record->>'startedAt' as started_at,record->>'finishedAt' as finished_at
      from harness_executions order by id`)).rows)
    console.error('Computer workflow cleanup', (await fixture.db.pool.query(`select r.id,r.execution_state,
      r.record->>'outcome' as outcome,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
      from runs r`)).rows)
    console.error('Computer workflow remote receipts', (await fixture.db.pool.query(`select
      receipt->'intent'->>'executionId' as execution_id,receipt->>'phase' as phase,
      receipt->'terminal' as terminal from remote_execution_receipts`)).rows)
    try {
      console.error('Computer workflow Worker startup', await fixture.workerWorkflowStartup())
    } catch (diagnosticError) {
      console.error('Computer workflow Worker startup diagnostics unavailable', diagnosticError)
    }
    try {
      console.error('Computer workflow recent provider activity', (await fixture.provider.startupActivity()).slice(-40))
    } catch (diagnosticError) {
      console.error('Computer workflow provider startup diagnostics unavailable', diagnosticError)
    }
    throw error
  } finally { await fixture.close() }
}, 240_000)

