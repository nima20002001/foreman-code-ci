import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionContextSchema, HarnessExecutionRequestSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { WorkActivationIdentitySchema, WorkActivationInputSchema, WorkReturnSchema } from '@foreman-code/contracts/wave25'
import type pg from 'pg'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { workParentRequestMigration } from '../src/infrastructure/workParentRequestMigration.js'
import { repeatExecutionIdentity, repeatId, workActivationSlotId } from '../src/modules/runs/repeatResolution.js'
import { workflowNativeReservation } from '../src/modules/runs/workflowNativeEntry.js'
import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'
import { currentInitialPrompt } from '../src/modules/runs/currentRouting.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { digest, text, transaction } from './eng04-migration-fixtures.js'

// Current readers need the whole current schema while historical inputs are staged, so only
// the continuation upgrade is deferred. Its older redefinitions of shared functions must not
// replace the current ones when it is finally applied.
async function databaseBeforeContinuationUpgrade() {
  return currentDatabase({ deferMigration: workParentRequestMigration.version })
}
async function upgradeContinuations(pool: pg.Pool) {
  const current = (await pool.query<{ definition: string }>(`select pg_get_functiondef(p.oid) as definition
    from pg_proc p where p.pronamespace=current_schema()::regnamespace and p.prokind='f'`)).rows
  await pool.query('drop function work_parent_request(text,text)')
  await applyApplicationMigrations(pool)
  for (const { definition } of current) await pool.query(definition)
}

function nativeReturnFromPrompt(prompt: string, includeRequestId: boolean) {
  const contextLine = /^TRUSTED WORKFLOW EXECUTION CONTEXT\n(.+)$/m.exec(prompt)?.[1]
  assert.ok(contextLine, 'The native continuation needs its saved caller in execution context')
  const context = HarnessExecutionContextSchema.parse(JSON.parse(contextLine))
  assert.ok(context.parentRequest)
  return {
    routing: { kind: 'return' as const, outcome: 'accepted' as const,
      ...(includeRequestId ? { requestId: context.parentRequest.requestId } : {}) },
    data: { latestDeliverable: { revision: 2 }, remainingFindings: [] },
  }
}

describe.skipIf(!postgresEnabled)('saved continuation inputs across an upgrade', () => {
  it.each([false, true])('reuses a populated pre-parent-request continuation and returns to its original caller (explicit request: %s)', async includeRequestId => {
    const db = await databaseBeforeContinuationUpgrade()
    const t = await workHandoffFixture(db.pool, 'continuation-upgrade', (version) => ({ ...version,
      definition: { ...version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 20 },
        nodes: version.definition.nodes.map((node) => {
          const configured = { ...node }
          delete configured.join
          return configured
        }),
        edges: [
          { id: 'a-b', kind: 'execution', source: version.definition.nodes[0]!.id, target: version.definition.nodes[1]!.id },
          { id: 'b-c', kind: 'execution', source: version.definition.nodes[1]!.id, target: version.definition.nodes[2]!.id },
        ],
      } }))
    try {
      const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
      const ab = await t.store.admitWorkRequest(a.id, 'a-b')
      assert.equal(ab.kind, 'accepted')
      const b = await t.accept(ab.request.destinationActivationId, finished(1))
      const bc = await t.store.admitWorkRequest(b.id, 'b-c')
      assert.equal(bc.kind, 'accepted')
      const c = await t.accept(bc.request.destinationActivationId, {
        routing: { kind: 'return', requestId: bc.request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
      })
      const original = WorkActivationInputSchema.parse(b.input)
      const returnId = repeatId('work-return', c.id)
      const activationId = repeatId('work-activation', returnId)
      const returned = WorkReturnSchema.parse({ scope: original.work.activation.scope, returnId,
        requestId: bc.request.requestId, sourceActivationId: bc.request.destinationActivationId,
        sourceExecutionId: c.id, requesterActivationId: bc.request.requesterActivationId,
        continuationActivationId: activationId, acceptedResultDigest: digest(c.result), outcome: 'needs_changes',
        latestDeliverable: { revision: 1 }, remainingFindings: ['revise'], returnedAt: c.finishedAt })
      const activation = WorkActivationIdentitySchema.parse({ scope: original.work.activation.scope,
        activationId, workflowNodeId: b.workflowNodeId, lineageId: original.work.activation.lineageId,
        cause: { kind: 'work_return', returnId } })
      const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: t.run.input,
        occurrence: null, entry: null, predecessors: [],
        work: { kind: 'work_return', activation, returned, acceptedSourceResult: c.result } })
      const candidate = { ...b, id: repeatId('fixture-execution', activationId), input, state: 'queued' as const }
      delete candidate.result
      delete candidate.finishedAt
      const execution = HarnessExecutionSchema.parse(candidate)
      const slotId = workActivationSlotId(t.run.id, activationId)
      const inputDigest = digest(input)
      // Write the historical input shape under the historical schema, with all
      // its constraints active. No frozen input is rewritten during the upgrade.
      await transaction(db.pool, async (sql) => {
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
          cause_kind,cause_id,state,record) values($1,$2,$3,$4,'work_return',$5,'queued',$6::jsonb)`,
        [activationId, t.run.id, t.version.id, b.workflowNodeId, returnId, text(activation)])
        await sql.query(`insert into run_work_returns(return_id,run_id,request_id,source_activation_id,source_execution_id,
          requester_continuation_activation_id,result_digest,outcome,record)
          values($1,$2,$3,$4,$5,$6,$7,'needs_changes',$8::jsonb)`,
        [returnId, t.run.id, bc.request.requestId, bc.request.destinationActivationId, c.id,
          activationId, digest(c.result), text(returned)])
        await sql.query(`insert into run_repeat_slots(slot_id,run_id,work_activation_id,workflow_node_id,input_json,input_digest)
          values($1,$2,$3,$4,$5,$6)`, [slotId, t.run.id, activationId, b.workflowNodeId, text(input), inputDigest])
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,work_activation_id,record)
          values($1,$2,$3,$4,1,$5,$6::jsonb)`,
        [execution.id, t.run.id, b.workflowNodeId, b.agentId, activationId, text(execution)])
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,work_activation_id,technical_attempt,identity)
          values($1,$2,$3,$4,1,$5::jsonb)`,
        [execution.id, t.run.id, slotId, activationId, text(repeatExecutionIdentity(execution))])
        const reservation = workflowNativeReservation(activation.scope,
          { nodeId: b.workflowNodeId, occurrence: null }, execution, inputDigest)
        const reservationJson = text(reservation)
        await sql.query(`insert into workflow_native_entries(execution_id,run_id,reservation,reservation_json,reservation_digest,phase)
          values($1,$2,$3::jsonb,$4::text,$5,'reserved')`,
        [execution.id, t.run.id, reservationJson, reservationJson, digest(reservation)])
        await sql.query(`insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence)
          values($1,'input.bind',$2,$3,'historical-fixture','1')`,
        [t.run.id, execution.id, digest({ execution, inputDigest })])
      })
      await upgradeContinuations(db.pool)
      await t.restart()
      const replay = await t.queue(activationId)
      expect(replay.reused).toBe(true)
      expect(replay.execution).toEqual(execution)
      expect(replay.execution.input).toEqual(input)
      expect((await db.pool.query('select input_digest from run_repeat_slots where slot_id=$1', [slotId])).rows)
        .toEqual([{ input_digest: inputDigest }])
      const executionContext = await t.store.readWorkExecutionContext(replay.execution.id)
      expect(executionContext.parentRequest).toEqual({ requestId: ab.request.requestId, requesterNodeId: a.workflowNodeId })
      await t.restart()
      expect(await t.store.readWorkExecutionContext(replay.execution.id)).toEqual(executionContext)
      const restartedReplay = await t.queue(activationId)
      expect(restartedReplay).toEqual(replay)
      const configuration = (await db.pool.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id=$1', [execution.agentConfigurationVersionId])).rows[0]
      assert.ok(configuration)
      const node = t.version.definition.nodes.find(item => item.id === execution.workflowNodeId)
      assert.ok(node && node.kind !== 'job')
      const request = HarnessExecutionRequestSchema.parse({ executionId: replay.execution.id, runId: t.run.id,
        workspaceId: t.run.workspaceId, workflowNodeId: replay.execution.workflowNodeId,
        workingDirectory: db.directory, runtimeDirectory: db.directory, configuration: configuration.record,
        input: replay.execution.input, executionContext,
        initialPrompt: currentInitialPrompt(node, false, true) })
      const nativeResult = nativeReturnFromPrompt(buildHarnessPrompt(request), includeRequestId)
      expect(request.input).toEqual(input)
      expect(request.input).not.toHaveProperty('parentRequest')
      const final = await t.accept(activationId, nativeResult)
      await t.restart()
      expect((await t.store.returnWork(final.id)).value.requestId).toBe(ab.request.requestId)
      expect((await db.pool.query('select input_json,input_digest from run_repeat_slots where slot_id=$1', [slotId])).rows)
        .toEqual([{ input_json: text(input), input_digest: inputDigest }])
    } finally { await t.close(); await db.close() }
  }, 120000)
})
