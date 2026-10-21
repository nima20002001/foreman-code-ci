import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { RunActivitiesService } from '../src/modules/runs/activities.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { deferred, rejectableDeferred } from './helpers/deferred.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'

it('commits CI independently of held Run publication and delivers both activities in commit order', async () => {
  const db = await currentDatabase()
  const graph = await graphFixture(db, { form: 'single' })
  const locked = rejectableDeferred<void>()
  const publish = deferred()
  const node = agentWorkflowNode(graph.version.definition.nodes[0])
  const executionId = randomUUID()
  let execution: Promise<void> | undefined
  try {
    await db.pool.query(`insert into harness_executions
      (id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
    [executionId, graph.run.id, node.id, node.agentId, JSON.stringify({
      id: executionId, runId: graph.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
      state: 'starting', attempt: 1, input: {}, createdAt: graph.run.createdAt,
    })])
    const activities = new RunActivitiesService(db.pool)
    const read = (cursor?: string) => activities.read(graph.writer.principal, {
      workspaceId: graph.scope.workspaceId, runId: graph.run.id, limit: 100, ...(cursor ? { cursor } : {}),
    })
    const initial = await read()
    const ticket = CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId: graph.scope.workspaceId, groupId: randomUUID(), suite: 'lint',
      commit: 'a'.repeat(40), repository: 'example/project', partition: null,
      state: 'queued', computer: null, step: null, exitCode: null, message: null,
      queuedAt: graph.run.createdAt, startedAt: null, finishedAt: null,
      initiator: { principalId: graph.writer.principal.id, executionId },
    })
    execution = withTransaction(db.pool, async client => {
      await client.query('select id from runs where id=$1 for update', [graph.run.id])
      await client.query(`update harness_executions set record=jsonb_set(record,'{state}','"running"'::jsonb)
        where id=$1`, [executionId])
      locked.resolve()
      await publish.promise
    }).catch((error: unknown) => { locked.reject(error); throw error })
    const result = Promise.allSettled([execution])
    await locked.promise
    await withTransaction(db.pool, async client => {
      await client.query("select set_config('statement_timeout','500ms',true)")
      await client.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
        values($1,$2,$3,$4,$5::jsonb)`,
      [ticket.id, ticket.workspaceId, ticket.groupId, ticket.state, JSON.stringify(ticket)])
    })
    const during = await read(initial.nextCursor)
    expect(during.items).toMatchObject([{ kind: 'job_work', status: 'queued',
      refs: { executionId, ciTicketId: ticket.id }, ci: { state: 'queued' } }])
    expect((await read(during.nextCursor)).items).toEqual([])
    publish.resolve()
    expect(await result).toEqual([{ status: 'fulfilled', value: undefined }])
    const after = await read(during.nextCursor)
    expect(after.items).toMatchObject([{ kind: 'agent_work', status: 'running', refs: { executionId } }])
    const delivered = [...during.items, ...after.items]
    expect(new Set(delivered.map(item => item.id)).size).toBe(2)
    expect(BigInt(after.items[0]!.sequence)).toBeGreaterThan(BigInt(during.highWater))
    expect((await read(after.nextCursor)).items).toEqual([])
    const activity = (await db.pool.query<{ kind: string; sequence: string }>(
      'select kind,sequence::text from run_activity where harness_execution_id=$1 and sequence>$2 order by sequence',
      [executionId, initial.highWater])).rows
    expect(activity.map(row => row.kind)).toEqual(['ci_state_changed', 'node_state_changed'])
    expect(activity.map(row => row.sequence)).toEqual(delivered.map(item => item.sequence))
  } finally {
    publish.resolve()
    try { await execution } finally {
      await graph.app.close()
      await db.close()
    }
  }
}, 60_000)
