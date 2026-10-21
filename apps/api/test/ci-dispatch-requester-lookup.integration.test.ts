import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CiRunRecordSchema, type CiHostRequest } from '@foreman-code/contracts'
import { createDatabase } from '../src/infrastructure/database.js'
import { withCiDatabasePriority } from '../src/infrastructure/ciDatabasePriority.js'
import { claimCiSlot } from '../src/modules/ci-host/cloudSlots.js'
import type { HostCiComputer } from '../src/modules/ci-host/serviceTypes.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
let graph: Awaited<ReturnType<typeof graphFixture>>
let dispatch: ReturnType<typeof createDatabase>
let executionIds: string[]

beforeAll(async () => {
  db = await currentDatabase()
  graph = await graphFixture(db, { form: 'single' })
  const node = agentWorkflowNode(graph.version.definition.nodes[0])
  const executions = await db.pool.query<{ id: string }>(`insert into harness_executions
    (id,run_id,workflow_node_id,agent_id,attempt,record)
    select fixture.id,$1,$2,$3,fixture.attempt,jsonb_build_object(
      'id',fixture.id,'runId',$1::text,'workflowNodeId',$2::text,'agentId',$3::text,
      'agentConfigurationVersionId',$4::text,'state','starting','attempt',fixture.attempt,
      'input','{}'::jsonb,'createdAt',$5::text)
    from (select gen_random_uuid()::text as id,n as attempt from generate_series(1,2700) n) fixture
    returning id`, [graph.run.id, node.id, node.agentId,
    graph.version.agentConfigurationVersionIds[node.agentId], graph.run.createdAt])
  executionIds = executions.rows.map(row => row.id)
  await db.pool.query('analyze harness_executions')
  await db.pool.query('analyze runs')
  const url = new URL(process.env.TEST_DATABASE_URL!)
  // Long-lived dispatch sessions can select this plan after their first few claims.
  url.searchParams.set('options', `-c search_path=${db.schema} -c plan_cache_mode=force_generic_plan`)
  dispatch = createDatabase({ connectionString: url.toString(), maxConnections: 4,
    connectionTimeoutMs: 1000, queryTimeoutMs: 1000 })
}, 60_000)

afterAll(async () => {
  await dispatch?.close()
  await graph?.app.close()
  await db?.close()
}, 60_000)

it.each(['operator', 'agent'] as const)(
  'claims a large %s ticket within the dispatch SQL deadline despite unrelated execution history', async caller => {
    const files = Array.from({ length: 901 }, (_, index) =>
      `apps/api/test/feature-${index}-${randomUUID()}.integration.test.ts`)
    const ticket = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: graph.scope.workspaceId,
      groupId: randomUUID(), suite: 'integration', scope: 'affected', files,
      commit: 'a'.repeat(40), repository: 'example/project', ciMirror: 'example/project-ci', partition: null,
      state: 'queued', computer: null, step: null, exitCode: null, message: null,
      queuedAt: graph.run.createdAt, startedAt: null, finishedAt: null,
      initiator: { principalId: graph.writer.principal.id,
        executionId: caller === 'agent' ? executionIds[0] : null },
    })
    await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
      values($1,$2,$3,$4,$5::jsonb)`,
    [ticket.id, ticket.workspaceId, ticket.groupId, ticket.state, JSON.stringify(ticket)])
    if (caller === 'agent') {
      for (const [index, executionId] of [executionIds[0]!, executionIds[1]!, executionIds[1]!].entries()) {
        await db.pool.query(`insert into ci_group_requesters(group_id,workspace_id,principal_id,execution_id,initiator)
          values($1,$2,$3,$4,false)`, [ticket.groupId, ticket.workspaceId, `requester-${index}`, executionId])
      }
    }
    const computer: HostCiComputer = { key: `cloud:${caller}`, priority: 0, label: 'Cloud executor',
      hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'github', slot: caller === 'agent' ? 1 : 0 } }
    const request: Extract<CiHostRequest, { operation: 'start' }> = {
      operation: 'start', runId: ticket.id, repository: ticket.repository, ciMirror: ticket.ciMirror,
      commit: ticket.commit, suite: ticket.suite, scope: ticket.scope, files,
      durations: Object.fromEntries(files.map(file => [file, 30_000])),
    }
    const claimed = await withCiDatabasePriority(() => claimCiSlot(dispatch.pool, ticket, computer, request))
    expect(claimed).toMatchObject({ id: ticket.id, state: 'starting', files,
      computer: { hostRef: computer.hostRef }, dispatchRequest: { runId: ticket.id } })
    const persisted = await db.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [ticket.id])
    expect(persisted.rows[0]!.record).toEqual(claimed)
    const activity = await db.pool.query<{ harness_execution_id: string }>(`select harness_execution_id
      from run_activity where payload->>'ticketId'=$1 and payload#>>'{ci,state}'='starting'
      order by harness_execution_id`, [ticket.id])
    expect(activity.rows.map(row => row.harness_execution_id))
      .toEqual(caller === 'agent' ? executionIds.slice(0, 2).sort() : [])
  },
)
