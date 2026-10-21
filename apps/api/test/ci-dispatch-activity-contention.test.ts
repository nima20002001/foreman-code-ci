import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CiRunRecordSchema, type CiHostRequest } from '@foreman-code/contracts'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { claimCiDispatch } from '../src/modules/ci-host/dispatch.js'
import type { HostCiComputer } from '../src/modules/ci-host/serviceTypes.js'
import { RunActivitiesService } from '../src/modules/runs/activities.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { deferred, rejectableDeferred } from './helpers/deferred.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'

describe('CI dispatch activity concurrency', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  let graph: Awaited<ReturnType<typeof graphFixture>>
  let executionId: string
  let nativeSequence = 0

  beforeAll(async () => {
    db = await currentDatabase({ beforeMigration: 2026101609 })
    graph = await graphFixture(db, { form: 'single' })
    const node = agentWorkflowNode(graph.version.definition.nodes[0])
    executionId = randomUUID()
    await db.pool.query(`insert into harness_executions
      (id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
    [executionId, graph.run.id, node.id, node.agentId, JSON.stringify({
      id: executionId, runId: graph.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
      state: 'starting', attempt: 1, input: {}, createdAt: graph.run.createdAt,
    })])
    const retained = (await db.pool.query('select * from run_activity where run_id=$1 order by sequence',
      [graph.run.id])).rows
    await applyApplicationMigrations(db.pool)
    expect((await db.pool.query('select * from run_activity where run_id=$1 order by sequence',
      [graph.run.id])).rows).toEqual(retained)
  })

  afterAll(async () => {
    await graph?.app.close()
    await db?.close()
  })

  async function queuedTicket() {
    const ticket = CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId: graph.scope.workspaceId, groupId: randomUUID(), suite: 'lint',
      commit: 'a'.repeat(40), repository: 'example/project', partition: null,
      state: 'queued', computer: null, step: null, exitCode: null, message: null,
      queuedAt: graph.run.createdAt, startedAt: null, finishedAt: null,
      initiator: { principalId: graph.writer.principal.id, executionId },
    })
    await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
      values($1,$2,$3,$4,$5::jsonb)`,
    [ticket.id, ticket.workspaceId, ticket.groupId, ticket.state, JSON.stringify(ticket)])
    const computer: HostCiComputer = { key: `fixture:${ticket.id}`, priority: 0,
      hostRef: { kind: 'main', mainId: 'fixture-main' }, label: 'Build executor' }
    const request: Extract<CiHostRequest, { operation: 'start' }> = {
      operation: 'start', runId: ticket.id, repository: ticket.repository, commit: ticket.commit,
      defaultBranch: 'main', suite: ticket.suite,
    }
    return { ticket, computer, request }
  }

  function activities(cursor?: string) {
    return new RunActivitiesService(db.pool).read(graph.writer.principal, {
      workspaceId: graph.scope.workspaceId, runId: graph.run.id, limit: 100, ...(cursor ? { cursor } : {}),
    })
  }

  it.each(['no key update', 'update'] as const)(
    'commits dispatch while a native transaction holds the parent for %s and has unpublished activity',
    async lock => {
      const { ticket, computer, request } = await queuedTicket()
      const ready = rejectableDeferred<void>()
      const release = deferred()
      const sequences = [nativeSequence++, nativeSequence++]
      const holder = withTransaction(db.pool, async client => {
        await client.query(`select id from runs where id=$1 for ${lock}`, [graph.run.id])
        for (const sequence of sequences) {
          await client.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({
            executionId, connectionId: 'fixture-native', sequence, type: 'output',
            occurredAt: graph.run.createdAt, payload: { text: 'Native output' },
          })])
        }
        ready.resolve()
        await release.promise
      })
      const outcome = holder.catch((error: unknown) => { ready.reject(error); throw error })
      // Observe failures immediately, including if setup fails before the held transaction is ready.
      const settled = Promise.allSettled([outcome])
      try {
        await ready.promise
        const claimed = await withTransaction(db.pool, async client => {
          await client.query("select set_config('statement_timeout','500ms',true)")
          return claimCiDispatch(client, ticket, computer, request)
        })
        expect(claimed?.state).toBe('starting')
        const persisted = await db.pool.query<{ state: string }>('select state from ci_runs where id=$1', [ticket.id])
        expect(persisted.rows).toEqual([{ state: 'starting' }])
        const page = await activities()
        expect(page.items.filter(item => item.refs.ciTicketId === ticket.id).map(item => item.ci?.state))
          .toEqual(['queued', 'starting'])
        expect(page.items.some(item => sequences.includes(item.refs.nativeEventSequence!))).toBe(false)
        release.resolve()
        expect(await settled).toEqual([{ status: 'fulfilled', value: undefined }])
        const next = await activities(page.nextCursor)
        expect(next.items.map(item => item.refs.nativeEventSequence)).toEqual(sequences)
        expect(next.items.every(item => BigInt(item.sequence) > BigInt(page.highWater))).toBe(true)
        expect(await claimCiDispatch(db.pool, ticket, computer, request)).toBeNull()
      } finally {
        release.resolve()
        await outcome
      }
    },
  )

  it('rolls back a CI claim together with its activity and permits an unchanged retry', async () => {
    const { ticket, computer, request } = await queuedTicket()
    const failure = new Error('Abort the fixture transaction')
    await expect(withTransaction(db.pool, async client => {
      expect((await claimCiDispatch(client, ticket, computer, request))?.state).toBe('starting')
      throw failure
    })).rejects.toBe(failure)
    expect((await db.pool.query('select state from ci_runs where id=$1', [ticket.id])).rows)
      .toEqual([{ state: 'queued' }])
    expect((await activities()).items.filter(item => item.refs.ciTicketId === ticket.id).map(item => item.ci?.state))
      .toEqual(['queued'])
    expect((await claimCiDispatch(db.pool, ticket, computer, request))?.state).toBe('starting')
    expect((await activities()).items.filter(item => item.refs.ciTicketId === ticket.id).map(item => item.ci?.state))
      .toEqual(['queued', 'starting'])
  })

  it('discards native activity when its transaction rolls back', async () => {
    const sequence = nativeSequence++
    const failure = new Error('Abort native publication')
    await expect(withTransaction(db.pool, async client => {
      await client.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({
        executionId, connectionId: 'fixture-native', sequence, type: 'output',
        occurredAt: graph.run.createdAt, payload: { text: 'Discarded native output' },
      })])
      throw failure
    })).rejects.toBe(failure)
    expect((await activities()).items.some(item => item.refs.nativeEventSequence === sequence)).toBe(false)
    expect((await db.pool.query(`select sequence from harness_native_events
      where execution_id=$1 and connection_id=$2 and source_sequence=$3`,
    [executionId, 'fixture-native', sequence])).rows).toEqual([])
  })

  it('cascades activity deletion with its Run and rejects activity without a parent', async () => {
    // Use a Run without immutable graph/snapshot dependents, which intentionally prohibit deleting saved history.
    const runId = randomUUID()
    await db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record,
      runner_id,working_directory,location_revision)
      select $1,workspace_id,workflow_id,workflow_version_id,execution_state,
        jsonb_set(record,'{id}',to_jsonb($1::text)),runner_id,working_directory,location_revision
      from runs where id=$2`, [runId, graph.run.id])
    expect((await db.pool.query('select sequence from run_activity where run_id=$1', [runId])).rows.length)
      .toBeGreaterThan(0)
    await db.pool.query('delete from runs where id=$1', [runId])
    expect((await db.pool.query('select sequence from run_activity where run_id=$1', [runId])).rows)
      .toEqual([])
    await expect(db.pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
      values($1,'backend','run_state_changed',clock_timestamp(),'{}'::jsonb)`, [runId]))
      .rejects.toMatchObject({ code: '23503' })
  })
})
