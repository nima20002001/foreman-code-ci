import assert from 'node:assert/strict'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { workHandoffMigration } from '../src/infrastructure/workHandoffMigration.js'
import { RunActivitySchema } from '@foreman-code/contracts'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  CurrentWorkflowReadResultSchema, WorkActivationInputSchema, WorkNoticeSchema,
  makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { readRepeatGraphExecutionsLocked } from '../src/modules/run-graph/repeatProjectionRows.js'
import { readCurrentActivityContext } from '../src/modules/run-graph/currentActivity.js'
import { readPublicNodeProjection } from '../src/modules/run-graph/publicProjection.js'
import { canonicalRepeatEffect } from '../src/modules/run-graph/repeatPublication.js'
import { RepeatRepositoryFactory } from '../src/modules/runs/repeatRepositoryHost.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { markWorkNoticeUnknownLocked, trustedWorkNoticePrompt } from '../src/modules/runs/workHandoffNotice.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { writerFixture } from './eng04-writer-fixtures.js'
import { graphFixture, graphHeaders, graphRpcValue, graphUrl } from './eng04-graph-composition-fixture.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nim2691TaskDatabase as taskDatabase } from './helpers/nim2691Database.js'
import { digest, seedRun, text, transaction, type JsonObject } from './eng04-migration-fixtures.js'

const enabled = process.env.NIM2691_POSTGRES === '1'
const postgresDescribe = describe.skipIf(!enabled)

function handoffVersion(version: JsonObject) {
  const definition = version.definition as JsonObject
  delete definition.repeat
  definition.handoffs = { contractVersion: 1 }
  definition.edges = [
    { id: 'body-outside', kind: 'execution', source: 'body', target: 'outside', maxWorkHandoffsPerRun: 3 },
    { id: 'body-other', kind: 'execution', source: 'body', target: 'other', maxWorkHandoffsPerRun: 2 },
  ]
}

postgresDescribe('NIM-2691 durable handoff migration', () => {
  it('queues an entry through the production owner, native slot and canonical graph publication', async () => {
    await taskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await graphFixture(db, { form: 'sequential', handoffs: true, qualifiedReads: true })
      const owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
      assert.ok(owner)
      let recoveredOwner: RunOwnership | undefined
      try {
        const locations = new WorkspaceLocationService(pool, t.commands, directory, 'runner-local')
        const factory = new RepeatRepositoryFactory(locations, directory,
          createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify).services)
        const store = factory.forOwner(owner, t.version)
        const entry = await store.ensureWorkEntry()
        expect(await store.ensureWorkEntry()).toBe(entry)
        const activityRows = (await pool.query<{ sequence: string; source: string; kind: string;
          harness_execution_id: string | null; occurred_at: Date; payload: Record<string, unknown> }>(
          'select sequence::text,source,kind,harness_execution_id,occurred_at,payload from run_activity where run_id=$1 order by sequence',
          [t.run.id])).rows
        for (const row of activityRows) {
          const parsed = RunActivitySchema.safeParse({ id: `activity-${t.run.id}-${row.sequence}`,
            runId: t.run.id, sequence: Number(row.sequence), source: row.source, kind: row.kind,
            ...(row.harness_execution_id ? { harnessExecutionId: row.harness_execution_id } : {}),
            occurredAt: row.occurred_at.toISOString(), payload: row.payload })
          expect(parsed.success, JSON.stringify({ kind: row.kind, issues: parsed.error?.issues })).toBe(true)
        }
        expect(activityRows.some((row) => row.kind === 'work_activation_queued')).toBe(true)
        const node = agentWorkflowNode(t.version.definition.nodes[0])
        const admitted = await store.admitWorkActivation(entry, () => ({
          id: `nim2691-entry-execution-${randomUUID()}`, runId: t.run.id,
          workflowNodeId: node.id, agentId: node.agentId,
          agentConfigurationVersionId: t.version.agentConfigurationVersionIds[node.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: new Date().toISOString(),
        }))
        expect(admitted.reused).toBe(false)
        expect((await store.admitWorkActivation(entry, () => { throw new Error('replay allocated') })).reused).toBe(true)
        const projected = await owner.oneShotConnection().transaction((sql) =>
          readRepeatGraphExecutionsLocked(sql, t.scope, { executionIds: [admitted.execution.id] }), true)
        expect(projected[0]?.workActivationId).toBe(entry)
        const privateEffect = (await pool.query<{ payload_digest: string }>(`select payload_digest
          from run_repeat_effects where run_id=$1 and effect_kind='input.bind' and entity_id=$2`,
        [t.run.id, admitted.execution.id])).rows[0]
        assert.ok(privateEffect)
        const publicId = canonicalRepeatEffect(t.scope, { kind: 'input.bind', entityId: admitted.execution.id,
          digest: privateEffect.payload_digest }).identity.entityId
        expect((await pool.query(`select effect_kind from run_graph_effects
          where run_id=$1 and entity_id=$2 and effect_kind='input.bind'`, [t.run.id, publicId])).rowCount).toBe(1)
        const http = await t.app.inject({ method: 'GET', url: graphUrl(t, 'current'),
          headers: graphHeaders(t.writer.token) })
        expect(http.statusCode, http.body).toBe(200)
        expect(http.json().state.executions).toEqual(expect.arrayContaining([
          expect.objectContaining({ workActivationId: entry }),
        ]))
        const paths = { workingDirectory: t.run.executionLocation.rootPath,
          runtimeDirectory: repeatRuntimeDirectory(directory, t.scope, admitted.execution) }
        const claim = await store.claimLaunch(admitted.execution.id, paths)
        expect(claim?.state).toBe('starting')
        expect(store.consumeLaunchPermit(admitted.execution.id)).toBe(true)
        expect(store.consumeLaunchPermit(admitted.execution.id)).toBe(false)
        await owner.release()
        recoveredOwner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
        assert.ok(recoveredOwner)
        const recovered = factory.forOwner(recoveredOwner, t.version)
        expect(recovered.consumeLaunchPermit(admitted.execution.id)).toBe(false)
        expect(await recovered.claimLaunch(admitted.execution.id, paths)).toBeUndefined()
        expect((await recovered.recoverSession(admitted.execution.id)).state).toBe('starting')
        const forged = { ...claim!, state: 'completed', finishedAt: new Date().toISOString(),
          result: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
            data: { latestDeliverable: { id: 'forged-without-native-receipt' }, remainingFindings: [] } } } }
        await pool.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1',
          [admitted.execution.id, text(forged)])
        // The production G1 read rejects the unreceipted native state before
        // the work-specific accepted-result receipt is even considered.
        await expect(recovered.admitWorkRequest(admitted.execution.id, t.version.definition.edges[0]!.id))
          .rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
        expect((await pool.query('select 1 from run_work_requests where run_id=$1', [t.run.id])).rowCount).toBe(0)
        expect((await pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'",
          [t.run.id])).rowCount).toBe(1)
      } finally { await recoveredOwner?.release(); await owner.release(); await t.app.close() }
    })
  }, 120000)

  it('saves a marked line limit through authenticated HTTP and reads it through Operator MCP', async () => {
    await taskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await writerFixture(db)
      try {
        const input = CurrentWorkflowSaveInputSchema.parse({ ...t.input, graph: {
          ...t.input.graph, handoffs: { contractVersion: 1 },
          edges: t.input.graph.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
        } })
        const response = await t.app.inject({ method: 'PUT', url: t.url,
          headers: graphHeaders(t.writer.token), payload: input })
        expect(response.statusCode, response.body).toBe(200)
        const saved = CurrentWorkflowSaveResultSchema.parse(response.json())
        expect(saved.value.version.definition.handoffs).toEqual({ contractVersion: 1 })
        expect(saved.value.version.definition.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
        const read = await t.call(CURRENT_WORKFLOW_TOOLS.saved,
          { workspaceId: input.workspaceId, workflowId: input.workflowId })
        expect(read.result?.isError).not.toBe(true)
        const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue(read.result))
        expect(persisted.version.id).toBe(saved.value.version.id)
        expect(persisted.version.definition.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
        const reader = await t.credential([{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [input.workspaceId] } }])
        const denied = await t.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID() }, reader.token)
        expect(denied.result?.isError).toBe(true)
        expect((await pool.query('select count(*)::integer as n from workflow_versions where workflow_id=$1',
          [input.workflowId])).rows[0]?.n).toBe(1)
      } finally { await t.app.close() }
    })
  }, 120000)

  it('applies once and keeps old repeat Runs and their attempt indexes intact', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      await applyApplicationMigrations(pool)
      expect((await pool.query('select version from application_migrations where version=$1', [workHandoffMigration.version])).rowCount).toBe(1)
      expect((await pool.query(`select indexname from pg_indexes where tablename='harness_executions'
        and indexname in ('harness_executions_legacy_attempt','harness_executions_repeat_attempt','harness_executions_work_attempt')`)).rows).toHaveLength(3)
      const old = await transaction(pool, (sql) => seedRun(sql, 'nim2691-old'))
      expect((await pool.query('select workflow_version_id from runs where id=$1', [old.id])).rows[0]?.workflow_version_id).toBe(old.versionId)
    })
  }, 120000)

  it('keeps one Run-wide counter per connection and rejects a raw fourth reservation', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const run = await transaction(pool, (sql) => seedRun(sql, 'nim2691-count', 3, { versionPatch: handoffVersion }))
      const scope = { runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
        workflowVersionId: run.versionId, executionSemanticsVersion: 3 }
      await transaction(pool, async (sql) => {
        const entry = { scope, activationId: 'entry-body', workflowNodeId: 'body', lineageId: run.id,
          cause: { kind: 'entry' } }
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,cause_kind,cause_id,state,record)
          values($1,$2,$3,'body','entry',$2,'running',$4::jsonb)`, ['entry-body', run.id, run.versionId, text(entry)])
        for (const [relationshipId, maximum] of [['body-outside', 3], ['body-other', 2]] as const) {
          await sql.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,maximum)
            values($1,$2,$3,$4)`, [run.id, run.versionId, relationshipId, maximum])
        }
      })
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        await transaction(pool, async (sql) => {
          const requestId = `request-${ordinal}`, destinationActivationId = `outside-${ordinal}`
          const requesterActivationId = ordinal === 1 ? 'entry-body' : `body-${ordinal}`
          const requesterExecutionId = `fixture-source-execution-${ordinal}`
          if (ordinal > 1) {
            const requesterActivation = { scope, activationId: requesterActivationId, workflowNodeId: 'body', lineageId: run.id,
              cause: { kind: 'dependency', resolutionId: `fixture-resolution-${ordinal}` } }
            await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
              cause_kind,cause_id,state,record) values($1,$2,$3,'body','dependency',$4,'completed',$5::jsonb)`,
            [requesterActivationId, run.id, run.versionId, `fixture-resolution-${ordinal}`, text(requesterActivation)])
          }
          const sourceResult = { outcome: 'succeeded', output: { revision: ordinal } }
          const source = { id: requesterExecutionId, runId: run.id, workflowNodeId: 'body',
            agentId: run.agentIds.body, agentConfigurationVersionId: run.configIds.body,
            attempt: 1, input: {}, state: 'completed', result: sourceResult }
          await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
            values($1,$2,'body',$3,1,true,$4::jsonb,$5)`,
          [source.id, run.id, run.agentIds.body, text(source), requesterActivationId])
          await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,clock_timestamp())`,
          [source.id, run.id, requesterActivationId, text(sourceResult), digest(sourceResult)])
          const activation = { scope, activationId: destinationActivationId, workflowNodeId: 'outside', lineageId: run.id,
            cause: { kind: 'work_request', requestId } }
          await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,cause_kind,cause_id,state,record)
            values($1,$2,$3,'outside','work_request',$4,'queued',$5::jsonb)`, [destinationActivationId, run.id, run.versionId, requestId, text(activation)])
          const updated = await sql.query<{ used: number }>(`update run_work_connection_usage set used=used+1
            where run_id=$1 and workflow_version_id=$2 and relationship_id='body-outside' and used<maximum returning used`,
          [run.id, run.versionId])
          expect(updated.rows[0]?.used).toBe(ordinal)
          const request = { scope, requestId, relationshipId: 'body-outside', ordinal,
            requesterActivationId, requesterExecutionId, destinationActivationId,
            requesterNodeId: 'body', destinationNodeId: 'outside', payloadDigest: digest(sourceResult),
            acceptedAt: '2026-09-27T00:00:00.000Z' }
          await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
            requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,payload_digest,record)
            values($1,$2,$3,'body-outside',$4,$5,$6,$7,'body','outside',$8,$9::jsonb)`,
          [requestId, run.id, run.versionId, ordinal, requesterActivationId, requesterExecutionId,
            destinationActivationId, request.payloadDigest, text(request)])
        })
      }
      const count = await pool.query<{ used: number }>(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='body-outside'`, [run.id])
      expect(count.rows[0]?.used).toBe(3)
      expect((await pool.query(`update run_work_connection_usage set used=used+1
        where run_id=$1 and relationship_id='body-outside' and used<maximum returning used`, [run.id])).rowCount).toBe(0)
      expect((await pool.query(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='body-other'`, [run.id])).rows[0]?.used).toBe(0)
      await transaction(pool, async (sql) => {
        const activation = { scope, activationId: 'other-1', workflowNodeId: 'other', lineageId: run.id,
          cause: { kind: 'work_request', requestId: 'other-request-1' } }
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
          cause_kind,cause_id,state,record) values('other-1',$1,$2,'other','work_request','other-request-1','queued',$3::jsonb)`,
        [run.id, run.versionId, text(activation)])
        await sql.query(`update run_work_connection_usage set used=used+1
          where run_id=$1 and relationship_id='body-other'`, [run.id])
        const sourceResult = { outcome: 'succeeded', output: { revision: 1 } }
        const request = { scope, requestId: 'other-request-1', relationshipId: 'body-other', ordinal: 1,
          requesterActivationId: 'entry-body', requesterExecutionId: 'fixture-source-execution-1',
          destinationActivationId: 'other-1', requesterNodeId: 'body', destinationNodeId: 'other',
          payloadDigest: digest(sourceResult), acceptedAt: '2026-09-27T00:00:00.000Z' }
        await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
          requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,
          payload_digest,record) values('other-request-1',$1,$2,'body-other',1,'entry-body','fixture-source-execution-1',
            'other-1','body','other',$3,$4::jsonb)`, [run.id, run.versionId, request.payloadDigest, text(request)])
      })
      expect((await pool.query(`select used from run_work_connection_usage
        where run_id=$1 and relationship_id='body-other'`, [run.id])).rows[0]?.used).toBe(1)
      await expect(transaction(pool, (sql) => sql.query(`update run_work_connection_usage set used=4
        where run_id=$1 and relationship_id='body-outside'`, [run.id]))).rejects.toThrow()
      await expect(pool.query(`update run_work_connection_usage set used=2
        where run_id=$1 and relationship_id='body-outside'`, [run.id])).rejects.toThrow()
      await expect(pool.query('delete from run_work_requests where run_id=$1', [run.id])).rejects.toThrow()
      await expect(pool.query(`update run_work_results set result_json='{}' where run_id=$1`, [run.id])).rejects.toThrow()
      expect((await pool.query('delete from runs where id=$1', [run.id])).rowCount).toBe(1)
      expect((await pool.query('select 1 from run_work_requests where run_id=$1', [run.id])).rowCount).toBe(0)
    })
  }, 120000)

  it.each([false, true])('admits one racer and fences notice delivery at Stop (before delivery: %s)', async (stopBeforeDelivery) => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-owner')
      const base = fixture.version
      const [requester, destination] = base.definition.nodes
      const savedEdge = base.definition.edges[0]!
      const version = WorkflowVersionV3Schema.parse({ ...base, definition: {
        ...base.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
        nodes: [{ ...requester!, choice: { outcomes: [
          { outcome: 'review', target: { kind: 'edge', relationshipId: savedEdge.id } },
        ] } }, destination],
        edges: [{ ...savedEdge, maxWorkHandoffsPerRun: 3 }],
      } })
      const run = { ...fixture.run, executionState: 'running' as const }
      await transaction(pool, async (sql) => {
        await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)', [run.workspaceId, text({ id: run.workspaceId })])
        await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
          [run.workflowId, run.workspaceId, text({ id: run.workflowId, workspaceId: run.workspaceId })])
        for (const config of fixture.configurations) {
          await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
            [config.agentId, run.workspaceId, text({ id: config.agentId, workspaceId: run.workspaceId })])
          await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`, [config.id, run.workspaceId, config.agentId, text(config)])
        }
        await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
          values($1,$2,$3,1,$4,3,$5::jsonb)`, [version.id, run.workspaceId, run.workflowId, version.entryNodeId, text(version)])
        await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
          values($1,$2,$3,$4,'running',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
        for (let i = 1; i <= 5; i++) {
          const activationId = `activation-requester-${i}`
          const activation = { scope: fixture.scope, activationId, workflowNodeId: requester!.id, lineageId: run.id,
            cause: i === 1 ? { kind: 'entry' } : { kind: 'dependency', resolutionId: `fixture-resolution-${i}` } }
          await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
            cause_kind,cause_id,state,record) values($1,$2,$3,$4,$5,$6,'completed',$7::jsonb)`,
          [activationId, run.id, version.id, requester!.id, activation.cause.kind,
            i === 1 ? run.id : `fixture-resolution-${i}`, text(activation)])
          const execution = { id: `source-execution-${i}`, runId: run.id, workflowNodeId: requester!.id,
            agentId: requester!.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[requester!.agentId],
            attempt: 1, input: {}, state: 'completed',
            result: { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
              data: { latestDeliverable: { revision: i }, remainingFindings: [] } } },
            createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
          await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
            values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
          [execution.id, run.id, requester!.id, requester!.agentId, text(execution), activationId])
          if (i !== 1) await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,clock_timestamp())`,
          [execution.id, run.id, activationId, text(execution.result), digest(execution.result)])
        }
      })
      const owner = await RunOwnership.acquire(pool, run.id, () => undefined)
      assert.ok(owner)
      try {
        const host: RepeatRepositoryHost = { openLocked: async () => ({
          run,
          // These hooks isolate the PostgreSQL quota test. Native, grants and
          // publication are qualified separately through production services.
          assertAuthorityLocked: async () => undefined,
          assertAdmissionLocked: async () => undefined,
          assertSettlementLocked: async () => undefined,
          allowTechnicalRetryLocked: async () => false,
          publishLocked: async (_sql, _effect, _facts, mutate) => { await mutate() },
          assertPublicationReceiptLocked: async (sql, effect) => {
            const receipt = (await sql.query<{ payload_digest: string }>(
              `select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3`,
              [run.id, effect.kind, effect.entityId])).rows[0]
            assert.equal(receipt?.payload_digest, effect.digest)
          },
          completeRunLocked: async () => { throw new Error('Unexpected completion') },
        }) }
        const store = new RepeatRunRepository(owner, host, version)
        await expect(store.admitWorkRequest('source-execution-1')).rejects.toMatchObject({ code: 'WORK_RESULT_RECEIPT_MISSING' })
        expect((await pool.query('select used from run_work_connection_usage where run_id=$1', [run.id])).rowCount).toBe(0)
        const firstResult = { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: [] } } }
        await pool.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
          values('source-execution-1',$1,'activation-requester-1',$2,$3,clock_timestamp())`,
        [run.id, text(firstResult), digest(firstResult)])
        const first = await store.admitWorkRequest('source-execution-1')
        expect(first.kind).toBe('accepted')
        assert.equal(first.kind, 'accepted')
        const queued = await store.admitWorkActivation(first.request.destinationActivationId, () => ({
          id: 'review-execution-1', runId: run.id, workflowNodeId: destination!.id,
          agentId: destination!.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[destination!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        expect(queued.reused).toBe(false)
        expect((queued.execution.input as { work: { request: { requestId: string } } }).work.request.requestId).toBe(first.request.requestId)
        expect((await store.admitWorkActivation(first.request.destinationActivationId, () => { throw new Error('replay allocated') })).reused).toBe(true)
        expect((await store.readExecution(queued.execution.id)).workActivationId).toBe(first.request.destinationActivationId)
        const projected = await owner.oneShotConnection().transaction((sql) =>
          readRepeatGraphExecutionsLocked(sql, fixture.scope, { executionIds: [queued.execution.id] }), true)
        expect(projected[0]?.identity.executionId).toBe(queued.execution.id)
        expect(projected[0]?.workActivationId).toBe(first.request.destinationActivationId)
        const review = { ...queued.execution, state: 'completed', result: { outcome: 'succeeded', output: {
            routing: { kind: 'return', requestId: first.request.requestId, outcome: 'needs_changes' },
            data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'finding-1' }] },
          } }, finishedAt: fixture.createdAt }
        await pool.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1', [review.id, text(review)])
        await pool.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
          values($1,$2,$3,$4,$5,clock_timestamp())`,
        [review.id, run.id, first.request.destinationActivationId, text(review.result), digest(review.result)])
        const returned = await store.returnWork(review.id)
        expect(returned.value.outcome).toBe('needs_changes')
        expect(returned.value.requestId).toBe(first.request.requestId)
        expect(returned.value.continuationActivationId).toBeTruthy()
        expect((await store.returnWork(review.id)).replayed).toBe(true)
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1', [run.id])).rows[0]?.used).toBe(1)
        const beforeNext = await owner.oneShotConnection().transaction((sql) =>
          readCurrentActivityContext(sql, fixture.scope, destination!.id), true)
        expect(beforeNext.workflowClosed).toBe(true)
        const secondRequest = await store.admitWorkRequest('source-execution-2')
        assert.equal(secondRequest.kind, 'accepted')
        await store.admitWorkActivation(secondRequest.request.destinationActivationId, () => ({
          id: 'review-execution-2', runId: run.id, workflowNodeId: destination!.id,
          agentId: destination!.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[destination!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const afterNext = await owner.oneShotConnection().transaction((sql) =>
          readCurrentActivityContext(sql, fixture.scope, destination!.id), true)
        expect(afterNext.workflowClosed).toBe(false)
        const current = await owner.oneShotConnection().transaction((sql) =>
          readPublicNodeProjection(sql, fixture.scope, [destination!.id]), true)
        expect(current[0]?.state.lifecycle).toBe('queued')
        expect(current[0]?.state.execution?.executionId).toBe('review-execution-2')
        const last = await Promise.all([store.admitWorkRequest('source-execution-3'), store.admitWorkRequest('source-execution-4')])
        expect(last.map((item) => item.kind).sort()).toEqual(['accepted', 'limit_reached'])
        const accepted = last.find((item) => item.kind === 'accepted')!
        const denied = last.find((item) => item.kind === 'limit_reached')!
        expect(accepted.kind === 'accepted' && accepted.request.ordinal).toBe(3)
        expect(denied.kind === 'limit_reached' && denied.denial.used).toBe(3)
        assert.equal(denied.kind, 'limit_reached')
        expect(denied.notice.cause).toEqual({ kind: 'limit_denial', denialId: denied.denial.denialId })
        expect(denied.notice.message).toContain('(3 of 3 for this Run)')
        expect(denied.notice.delivery).toBe('queued')
        const savedNotice = (await pool.query<{ record: unknown; delivery_state: string }>(
          'select record,delivery_state from run_work_notices where run_id=$1', [run.id])).rows[0]
        expect(savedNotice?.delivery_state).toBe('queued')
        expect(WorkNoticeSchema.parse(savedNotice?.record).noticeId).toBe(denied.notice.noticeId)
        expect((await pool.query<{ kind: string }>(`select kind from run_activity where run_id=$1
          and kind in ('work_handoff_denied','work_limit_notice_queued','work_requester_reactivated')
          and sequence >= (select min(sequence) from run_activity
            where run_id=$1 and kind='work_handoff_denied')
          order by sequence`, [run.id])).rows.map((row) => row.kind)).toEqual([
          'work_handoff_denied', 'work_limit_notice_queued', 'work_requester_reactivated',
        ])
        await expect(pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
          values($1,'backend','work_requester_reactivated',clock_timestamp(),$2::jsonb)`,
        [run.id, JSON.stringify({ activationId: denied.notice.continuationActivationId })]))
          .rejects.toMatchObject({ code: '23505' })
        expect((await pool.query(`select 1 from run_work_activations
          where run_id=$1 and cause_kind='limit_denial' and cause_id=$2`,
          [run.id, denied.denial.denialId])).rowCount).toBe(1)
        expect((await store.admitWorkRequest('source-execution-3')).replayed).toBe(true)
        const deniedReplays = await Promise.all([
          store.admitWorkRequest('source-execution-4'), store.admitWorkRequest('source-execution-4'),
        ])
        expect(deniedReplays.every((item) => item.replayed && item.kind === 'limit_reached'
          && item.notice.noticeId === denied.notice.noticeId)).toBe(true)
        if (stopBeforeDelivery) {
          await pool.query('update runs set stop_requested_at=clock_timestamp() where id=$1', [run.id])
          await owner.release()
          const restartedOwner = await RunOwnership.acquire(pool, run.id, () => undefined)
          assert.ok(restartedOwner)
          try {
            const restarted = new RepeatRunRepository(restartedOwner, host, version)
            await expect(restarted.admitWorkActivation(denied.notice.continuationActivationId,
              () => { throw new Error('Stop must fence B before native admission.') }))
              .rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
          } finally { await restartedOwner.release() }
          expect((await pool.query<{ delivery_state: string }>(
            'select delivery_state from run_work_notices where notice_id=$1',
            [denied.notice.noticeId])).rows[0]?.delivery_state).toBe('queued')
          expect((await pool.query(`select 1 from harness_executions
            where run_id=$1 and work_activation_id=$2`,
          [run.id, denied.notice.continuationActivationId])).rowCount).toBe(0)
          return
        }
        const denialTurn = await store.admitWorkActivation(denied.notice.continuationActivationId, () => ({
          id: 'denial-continuation-execution', runId: run.id,
          workflowNodeId: requester!.id, agentId: requester!.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[requester!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const deniedInput = WorkActivationInputSchema.parse(denialTurn.execution.input)
        expect(deniedInput.work.kind).toBe('limit_denial')
        expect(trustedWorkNoticePrompt(deniedInput)).toContain(denied.notice.message)
        expect((await pool.query<{ delivery_state: string }>(
          'select delivery_state from run_work_notices where notice_id=$1',
          [denied.notice.noticeId])).rows[0]?.delivery_state).toBe('pending')
        assert.equal(accepted.kind, 'accepted')
        const thirdReview = await store.admitWorkActivation(accepted.request.destinationActivationId, () => ({
          id: 'review-execution-3', runId: run.id, workflowNodeId: destination!.id,
          agentId: destination!.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[destination!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const thirdResult = { outcome: 'succeeded', output: {
          routing: { kind: 'return', requestId: accepted.request.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { revision: 3 }, remainingFindings: [{ id: 'finding-3' }] },
        } }
        await pool.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1',
          [thirdReview.execution.id, text({ ...thirdReview.execution, state: 'completed',
            result: thirdResult, finishedAt: fixture.createdAt })])
        await pool.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
          values($1,$2,$3,$4,$5,clock_timestamp())`,
        [thirdReview.execution.id, run.id, accepted.request.destinationActivationId, text(thirdResult), digest(thirdResult)])
        const lastReturn = await store.returnWork(thirdReview.execution.id)
        expect(lastReturn.value.outcome).toBe('needs_changes')
        const lastNotice = (await pool.query<{ record: unknown }>(
          `select record from run_work_notices where run_id=$1 and cause_kind='last_return'`, [run.id])).rows
        expect(lastNotice).toHaveLength(1)
        const notice = WorkNoticeSchema.parse(lastNotice[0]!.record)
        expect(notice.cause).toEqual({ kind: 'last_return', returnId: lastReturn.value.returnId })
        expect(notice.continuationActivationId).toBe(lastReturn.value.continuationActivationId)
        expect(notice.message).toContain('(3 of 3 for this Run)')
        expect((await pool.query(`select 1 from run_work_activations
          where run_id=$1 and cause_kind='work_return' and cause_id=$2`,
          [run.id, lastReturn.value.returnId])).rowCount).toBe(1)
        await expect(store.admitWorkActivation(notice.continuationActivationId,
          () => { throw new Error('The earlier requester continuation must settle first.') }))
          .rejects.toMatchObject({ code: 'WORK_ACTIVATION_NOT_QUEUED' })
        assert.ok(returned.value.continuationActivationId)
        const firstTurn = await store.admitWorkActivation(returned.value.continuationActivationId, () => ({
          id: 'first-return-continuation-execution', runId: run.id,
          workflowNodeId: requester!.id, agentId: requester!.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[requester!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const firstTurnResult = { outcome: 'succeeded', output: { routing: { kind: 'finish' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'finding-1' }] } } }
        await transaction(pool, async sql => {
          await sql.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1',
            [firstTurn.execution.id, text({ ...firstTurn.execution, state: 'completed',
              result: firstTurnResult, finishedAt: fixture.createdAt })])
          await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,clock_timestamp())`, [firstTurn.execution.id, run.id,
            returned.value.continuationActivationId, text(firstTurnResult), digest(firstTurnResult)])
          await sql.query("update run_work_activations set state='completed' where run_id=$1 and activation_id=$2",
            [run.id, returned.value.continuationActivationId])
        })
        expect(await store.resolveWaitingWorkJoins(returned.value.continuationActivationId))
          .toContain(notice.continuationActivationId)
        const returnTurn = await store.admitWorkActivation(notice.continuationActivationId, () => ({
          id: 'last-return-continuation-execution', runId: run.id,
          workflowNodeId: requester!.id, agentId: requester!.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[requester!.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const returnInput = WorkActivationInputSchema.parse(returnTurn.execution.input)
        expect(returnInput.work.kind).toBe('work_return')
        expect(trustedWorkNoticePrompt(returnInput)).toContain(notice.message)
        expect((await pool.query<{ delivery_state: string }>(
          'select delivery_state from run_work_notices where notice_id=$1',
          [notice.noticeId])).rows[0]?.delivery_state).toBe('pending')
        await owner.release()
        const pendingOwner = await RunOwnership.acquire(pool, run.id, () => undefined)
        assert.ok(pendingOwner)
        try {
          const pending = new RepeatRunRepository(pendingOwner, host, version)
          expect((await pending.admitWorkActivation(notice.continuationActivationId,
            () => { throw new Error('A pending notice must reuse its exact native input.') })).reused).toBe(true)
          await pendingOwner.oneShotConnection().transaction((sql) => markWorkNoticeUnknownLocked({
            sql, scope: fixture.scope, version, now: new Date().toISOString(),
          }, notice.continuationActivationId, returnTurn.execution.id))
        } finally { await pendingOwner.release() }
        expect((await pool.query<{ delivery_state: string }>(
          'select delivery_state from run_work_notices where notice_id=$1',
          [notice.noticeId])).rows[0]?.delivery_state).toBe('unknown')
        const recoveredOwner = await RunOwnership.acquire(pool, run.id, () => undefined)
        assert.ok(recoveredOwner)
        try {
          const recovered = new RepeatRunRepository(recoveredOwner, host, version)
          expect((await recovered.returnWork(thirdReview.execution.id)).replayed).toBe(true)
          expect((await recovered.admitWorkActivation(notice.continuationActivationId,
            () => { throw new Error('An uncertain notice must not allocate another native turn.') })).reused).toBe(true)
          expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1', [run.id])).rows[0]?.used).toBe(3)
          expect((await pool.query('select request_id from run_work_requests where run_id=$1', [run.id])).rowCount).toBe(3)
          expect((await pool.query('select denial_id from run_work_denials where run_id=$1', [run.id])).rowCount).toBe(1)
          const repeatedExhausted = await recovered.admitWorkRequest('source-execution-5')
          expect(repeatedExhausted.kind).toBe('needs_direction')
          expect((await recovered.admitWorkRequest('source-execution-5')).replayed).toBe(true)
          expect((await pool.query('select unresolved_id from run_work_unresolved where run_id=$1',
            [run.id])).rowCount).toBe(1)
          expect((await pool.query('select denial_id from run_work_denials where run_id=$1', [run.id])).rowCount).toBe(1)
          expect((await pool.query(`select 1 from run_work_activations where run_id=$1 and cause_kind='limit_denial'`,
            [run.id])).rowCount).toBe(1)
          await pool.query('update runs set stop_requested_at=clock_timestamp() where id=$1', [run.id])
          await expect(recovered.claimLaunch(returnTurn.execution.id, {
            workingDirectory: '/tmp/nim2691-stopped', runtimeDirectory: '/tmp/nim2691-stopped/runtime',
          })).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
          await expect(recovered.admitWorkRequest('source-execution-5')).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
          expect((await recovered.admitWorkRequest('source-execution-3')).replayed).toBe(true)
          expect((await recovered.admitWorkRequest('source-execution-4')).replayed).toBe(true)
          expect(recovered.consumeLaunchPermit('review-execution-2')).toBe(false)
          expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
            [run.id])).rows[0]?.used).toBe(3)
        } finally { await recoveredOwner.release() }
      } finally { await owner.release() }
    })
  }, 120000)

  it('admits more than three uncapped exchanges, enforces Run budget, and resets on a fresh Run', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-unbounded')
      const source = fixture.version.definition.nodes[0]!, edge = fixture.version.definition.edges[0]!
      const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
        ...fixture.version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 11 },
        nodes: [{ ...source, choice: { outcomes: [
          { outcome: 'review', target: { kind: 'edge', relationshipId: edge.id } },
        ] } }, fixture.version.definition.nodes[1]],
      } })
      await transaction(pool, async (sql) => {
        await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)',
          [version.workspaceId, text({ id: version.workspaceId })])
        await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
          [version.workflowId, version.workspaceId, text({ id: version.workflowId, workspaceId: version.workspaceId })])
        for (const config of fixture.configurations) {
          await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
            [config.agentId, version.workspaceId, text({ id: config.agentId, workspaceId: version.workspaceId })])
          await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`, [config.id, version.workspaceId, config.agentId, text(config)])
        }
        await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
          values($1,$2,$3,1,$4,3,$5::jsonb)`,
        [version.id, version.workspaceId, version.workflowId, version.entryNodeId, text(version)])
      })
      const host = (run: typeof fixture.run): RepeatRepositoryHost => ({ openLocked: async () => ({
        run,
        assertAuthorityLocked: async () => undefined,
        assertAdmissionLocked: async () => undefined,
        assertSettlementLocked: async () => undefined,
        allowTechnicalRetryLocked: async () => false,
        publishLocked: async () => { throw new Error('Unexpected native publication') },
        assertPublicationReceiptLocked: async () => { throw new Error('Unexpected native receipt') },
        completeRunLocked: async () => { throw new Error('Unexpected completion') },
      }) })
      const seed = async (runId: string, count: number) => {
        const run = { ...fixture.run, id: runId, executionState: 'running' as const }
        const scope = { ...fixture.scope, runId }
        await transaction(pool, async (sql) => {
          await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
            values($1,$2,$3,$4,'running',$5::jsonb)`,
          [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
          for (let index = 1; index <= count; index++) {
            const activationId = `${run.id}-source-${index}`, executionId = `${run.id}-execution-${index}`
            const cause = index === 1 ? { kind: 'entry' } : { kind: 'dependency', resolutionId: `${run.id}-resolution-${index}` }
            const activation = { scope, activationId, workflowNodeId: source.id, lineageId: run.id, cause }
            await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
              cause_kind,cause_id,state,record) values($1,$2,$3,$4,$5,$6,'completed',$7::jsonb)`,
            [activationId, run.id, version.id, source.id, cause.kind,
              index === 1 ? run.id : `${run.id}-resolution-${index}`, text(activation)])
            const result = { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
              data: { latestDeliverable: { revision: index }, remainingFindings: [] } } }
            const execution = { id: executionId, runId: run.id, workflowNodeId: source.id, agentId: source.agentId,
              agentConfigurationVersionId: version.agentConfigurationVersionIds[source.agentId],
              attempt: 1, input: {}, state: 'completed', result,
              createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
            await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
              values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
            [executionId, run.id, source.id, source.agentId, text(execution), activationId])
            await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
              values($1,$2,$3,$4,$5,clock_timestamp())`,
            [executionId, run.id, activationId, text(result), digest(result)])
          }
        })
        return run
      }
      const firstRun = await seed('nim2691-uncapped-run', 6)
      const firstOwner = await RunOwnership.acquire(pool, firstRun.id, () => undefined)
      assert.ok(firstOwner)
      try {
        const store = new RepeatRunRepository(firstOwner, host(firstRun), version)
        for (let index = 1; index <= 5; index++) {
          const admitted = await store.admitWorkRequest(`${firstRun.id}-execution-${index}`)
          assert.equal(admitted.kind, 'accepted')
          expect(admitted.request.ordinal).toBe(index)
        }
        expect((await pool.query<{ used: number; maximum: number | null }>(
          'select used,maximum from run_work_connection_usage where run_id=$1', [firstRun.id])).rows[0])
          .toEqual({ used: 5, maximum: null })
        await expect(store.admitWorkRequest(`${firstRun.id}-execution-6`))
          .rejects.toMatchObject({ code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' })
      } finally { await firstOwner.release() }
      const freshRun = await seed('nim2691-fresh-run', 1)
      const freshOwner = await RunOwnership.acquire(pool, freshRun.id, () => undefined)
      assert.ok(freshOwner)
      try {
        const admitted = await new RepeatRunRepository(freshOwner, host(freshRun), version)
          .admitWorkRequest(`${freshRun.id}-execution-1`)
        assert.equal(admitted.kind, 'accepted')
        expect(admitted.request.ordinal).toBe(1)
      } finally { await freshOwner.release() }
    })
  }, 120000)

  it('holds an all-required join until both exact branch requests arrive', async () => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-join', 'parallel')
      const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
        ...fixture.version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
        edges: fixture.version.definition.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
      } })
      const run = { ...fixture.run, executionState: 'running' as const }
      const b = agentWorkflowNode(version.definition.nodes[1])
      const c = agentWorkflowNode(version.definition.nodes[2])
      const d = agentWorkflowNode(version.definition.nodes[3])
      const incoming = version.definition.edges.filter((edge) => edge.target === d.id)
      expect(incoming).toHaveLength(2)
      await transaction(pool, async (sql) => {
        await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)', [run.workspaceId, text({ id: run.workspaceId })])
        await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
          [run.workflowId, run.workspaceId, text({ id: run.workflowId, workspaceId: run.workspaceId })])
        for (const config of fixture.configurations) {
          await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
            [config.agentId, run.workspaceId, text({ id: config.agentId, workspaceId: run.workspaceId })])
          await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`, [config.id, run.workspaceId, config.agentId, text(config)])
        }
        await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
          values($1,$2,$3,1,$4,3,$5::jsonb)`, [version.id, run.workspaceId, run.workflowId, version.entryNodeId, text(version)])
        await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
          values($1,$2,$3,$4,'running',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
        for (const [index, node] of [b, c].entries()) {
          const activationId = `branch-activation-${index}`, executionId = `branch-execution-${index}`
          const activation = { scope: fixture.scope, activationId, workflowNodeId: node.id,
            lineageId: run.id, cause: { kind: 'dependency', resolutionId: `branch-resolution-${index}` } }
          await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
            cause_kind,cause_id,state,record) values($1,$2,$3,$4,'dependency',$5,'completed',$6::jsonb)`,
          [activationId, run.id, version.id, node.id, `branch-resolution-${index}`, text(activation)])
          const result = { outcome: 'succeeded', output: { routing: { kind: 'finish' },
            data: { latestDeliverable: { branch: index }, remainingFindings: [] } } }
          const execution = { id: executionId, runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
            agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
            attempt: 1, input: {}, state: 'completed', result,
            createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
          await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
            values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
          [executionId, run.id, node.id, node.agentId, text(execution), activationId])
          await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,clock_timestamp())`,
          [executionId, run.id, activationId, text(result), digest(result)])
        }
      })
      const owner = await RunOwnership.acquire(pool, run.id, () => undefined)
      assert.ok(owner)
      try {
        const host: RepeatRepositoryHost = { openLocked: async () => ({ run,
          assertAuthorityLocked: async () => undefined,
          assertAdmissionLocked: async () => undefined,
          assertSettlementLocked: async () => undefined,
          allowTechnicalRetryLocked: async () => false,
          publishLocked: async (_sql, _effect, _facts, mutate) => { await mutate() },
          assertPublicationReceiptLocked: async (sql, effect) => {
            const row = (await sql.query<{ payload_digest: string }>(
              'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',
              [run.id, effect.kind, effect.entityId])).rows[0]
            assert.equal(row?.payload_digest, effect.digest)
          },
          completeRunLocked: async () => { throw new Error('Unexpected completion') },
        }) }
        const store = new RepeatRunRepository(owner, host, version)
        const entryId = await store.ensureWorkEntry()
        expect(await store.ensureWorkEntry()).toBe(entryId)
        const first = await store.admitWorkRequest('branch-execution-0', incoming[0]!.id)
        assert.equal(first.kind, 'accepted')
        expect(first.destinationReady).toBe(false)
        await expect(store.completeWorkRun()).rejects.toMatchObject({ code: 'WORK_ACTIVATIONS_UNRESOLVED' })
        await expect(store.admitWorkActivation(first.request.destinationActivationId,
          () => { throw new Error('incomplete join allocated') })).rejects.toMatchObject({ code: 'WORK_JOIN_INCOMPLETE' })
        const second = await store.admitWorkRequest('branch-execution-1', incoming[1]!.id)
        assert.equal(second.kind, 'accepted')
        expect(second.destinationReady).toBe(true)
        expect(second.request.destinationActivationId).toBe(first.request.destinationActivationId)
        const queued = await store.admitWorkActivation(first.request.destinationActivationId, () => ({
          id: 'joined-execution', runId: run.id, workflowNodeId: d.id, agentId: d.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[d.agentId]!,
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const input = queued.execution.input as { work: { kind: string; sources: Array<{ request: { relationshipId: string } }> } }
        expect(input.work.kind).toBe('join')
        expect(input.work.sources.map((source) => source.request.relationshipId).sort())
          .toEqual(incoming.map((edge) => edge.id).sort())
        expect((await store.admitWorkActivation(first.request.destinationActivationId,
          () => { throw new Error('join replay allocated') })).reused).toBe(true)
        expect((await pool.query('select count(*)::integer as n from run_work_activations where run_id=$1 and workflow_node_id=$2',
          [run.id, d.id])).rows[0]?.n).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)
})
