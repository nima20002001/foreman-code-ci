import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { CiGetOutputSchema, CiRunRecordSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { databaseHotQueriesMigration } from '../src/infrastructure/databaseHotQueriesMigration.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { readNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'
import { bindRepeatNodeInput, repeatDigest, repeatExecutionIdentity, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { openRepeatCanonicalPublicationLocked, publishRepeatRunStateLocked } from '../src/modules/run-graph/repeatPublication.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import {
  changeRunState, graphFixture, graphHeaders, graphRpc, graphRpcValue, graphUrl, ownedGraph,
} from './eng04-graph-composition-fixture.js'

function databaseBeforeHotQueryUpgrade() {
  return currentDatabase({ deferMigration: databaseHotQueriesMigration.version })
}

it('publishes owned run updates through authenticated reads before and after the hot query upgrade', async () => {
  const db = await databaseBeforeHotQueryUpgrade()
  try {
    const fixture = await graphFixture(db, { form: 'single', qualifiedReads: true })
    try {
      const read = () => fixture.app.inject({
        method: 'GET', url: graphUrl(fixture, 'current'), headers: graphHeaders(fixture.writer.token),
      })
      await changeRunState(db, fixture, 'running')
      const before = await read()
      expect(before.statusCode, before.body).toBe(200)
      expect(before.json()).toMatchObject({ scope: fixture.scope, state: { run: { executionState: 'running' } } })

      await applyApplicationMigrations(db.pool)
      const upgraded = await read()
      expect(upgraded.statusCode, upgraded.body).toBe(200)
      expect(upgraded.json()).toEqual(before.json())

      await changeRunState(db, fixture, 'waiting')
      const after = await read()
      expect(after.statusCode, after.body).toBe(200)
      expect(after.json()).toMatchObject({ scope: fixture.scope, state: { run: { executionState: 'waiting' } } })
    } finally {
      await fixture.app.close()
    }
  } finally {
    await db.close()
  }
}, 120_000)

async function persistExecution(db: Awaited<ReturnType<typeof currentDatabase>>,
  fixture: Awaited<ReturnType<typeof graphFixture>>, executionId: string) {
  const node = agentWorkflowNode(fixture.version.definition.nodes[0])
  const candidate = HarnessExecutionSchema.parse({
    id: executionId, runId: fixture.run.id, workflowNodeId: node.id, agentId: node.agentId, attempt: 1,
    agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId],
    state: 'queued', input: {}, createdAt: fixture.run.createdAt,
  })
  const ref = { nodeId: node.id, occurrence: null }
  const bound = bindRepeatNodeInput({ version: fixture.version, runInput: fixture.run.input,
    recipient: candidate, ref, occurrence: null, entry: null, predecessors: [] })
  const queued = HarnessExecutionSchema.parse({ ...candidate, input: bound.input })
  const slot = repeatSlotId(fixture.run.id, ref)
  const effect = { kind: 'input.bind' as const, entityId: queued.id,
    digest: repeatDigest({ ref, queued, inputDigest: bound.digest, bindings: bound.bindings }) }
  await ownedGraph(db, fixture, owner => owner.oneShotConnection().transaction(async sql => {
    const publication = await openRunGraphPublication(sql, fixture.scope, readPublicProjectionLocked)
    await publishRepeatRunStateLocked(publication, owner)
    const canonical = await openRepeatCanonicalPublicationLocked(sql, fixture.scope, owner, publication)
    const fence = await owner.readOneShotFence(sql)
    await canonical.publishEffectLocked(effect, [{ type: 'repeat.execution.queued', ref,
      execution: repeatExecutionIdentity(queued), inputDigest: bound.digest }], async () => {
      await sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest)
        values($1,$2,null,$3,$4,$5)`, [slot, fixture.run.id, node.id, JSON.stringify(bound.input), bound.digest])
      await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values($1,$2,$3,$4,1,$5::jsonb)`, [queued.id, fixture.run.id, node.id, node.agentId, JSON.stringify(queued)])
      await sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,occurrence_id,
        technical_attempt,previous_execution_id,identity) values($1,$2,$3,null,1,null,$4::jsonb)`,
      [queued.id, fixture.run.id, slot, JSON.stringify(repeatExecutionIdentity(queued))])
      await sql.query(`insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence)
        values($1,$2,$3,$4,$5,$6)`, [fixture.run.id, effect.kind, effect.entityId,
        effect.digest, fence.ownerId, fence.fence])
    })
    await canonical.assertEffectReceiptLocked(effect)
  }))
}

it('upgrades hot query access while preserving native facts, CI revisions and authenticated reads', async () => {
  const db = await databaseBeforeHotQueryUpgrade()
  const fixture = await graphFixture(db, { form: 'single', qualifiedReads: true })
  const executionId = randomUUID()
  const computer: HostCiComputer = {
    key: 'fixture-main', hostRef: { kind: 'main', mainId: randomUUID() }, label: 'Fixture computer', priority: 0,
  }
  const ticket = CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: fixture.scope.workspaceId, groupId: randomUUID(), suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'example/project', commit: 'a'.repeat(40),
    state: 'running', computer: { hostRef: computer.hostRef, label: computer.label }, step: 'lint',
    exitCode: null, message: null, queuedAt: fixture.run.createdAt, startedAt: fixture.run.createdAt, finishedAt: null,
    providerMessage: null, messageHistory: [],
    initiator: { principalId: fixture.writer.principal.id, executionId: null },
  })
  let logTail = 'Saved log'
  const endpoint: HostCiEndpoint = {
    computers: async () => [computer],
    request: async (_computer, request) => {
      if (request.operation !== 'read') throw new Error('Only persisted CI refresh is expected')
      return { operation: 'read', text: logTail, nextOffset: logTail.length, run: {
        runId: ticket.id, state: 'running', step: ticket.step, exitCode: null,
        startedAt: ticket.startedAt!, finishedAt: null, logBytes: logTail.length, message: null,
      } }
    },
  }
  const ci = new HostCiService(db.pool, fixture.commands, new RunCiAuthority(db.pool), {} as never, endpoint)
  const runs = new RunManagementService(db.pool, fixture.commands, {} as never, {} as never, {} as never)
  const app = buildApp({
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: fixture.access, services: { commands: fixture.commands, ci, runs } as never },
  })
  try {
    await changeRunState(db, fixture, 'running')
    await persistExecution(db, fixture, executionId)
    const item = (session: string, generation: string, status: string) => ({
      threadId: session, runtimeGeneration: generation,
      item: { id: 'same-item', type: 'commandExecution', status, command: 'git status', output: 'private output' },
    })
    const events = [
      { type: 'item.started', payload: item('session-a', '1', 'running') },
      { type: 'item.completed', payload: item('session-a', '1', 'completed') },
      { type: 'item.started', payload: item('session-b', '1', 'running') },
      { type: 'item.started', payload: item('session-a', '2', 'running') },
      { type: 'claude.tool', payload: { toolUseId: 'claude-tool', nativeSessionId: 'claude-session',
        owner: { generation: '2' }, status: 'failed', name: 'Read' } },
      { type: 'claude.task', payload: { taskId: 'claude-task', status: 'running' } },
      { type: 'native.unlinked_notification', payload: { turnId: 'child-turn', method: 'turn/completed',
        params: { turn: { status: 'failed' } } } },
      { type: 'item.snapshot', payload: { item: { id: 'dynamic', type: 'dynamicToolCall', success: false } } },
      { type: 'item.started', payload: { threadId: 'session-a', runtimeGeneration: '1',
        item: { id: 'same-item', type: 'reasoning', text: 'private reasoning' } } },
      { type: 'item.completed', payload: item('session-a', '1', 'error') },
      { type: 'item.started', payload: { part: { id: 'part', type: 'fileChange', state: { status: 'running' } } } },
      { type: 'message.part.updated', payload: { part: { id: 'part', type: 'fileChange', state: { status: 'completed' } } } },
    ].map((event, sequence) => ({ ...event, sequence, executionId, occurredAt: fixture.run.createdAt }))
    await db.pool.query(`insert into harness_native_events(execution_id,sequence,record)
      select $1,(event->>'sequence')::integer,event from jsonb_array_elements($2::jsonb) event`,
    [executionId, JSON.stringify(events)])
    await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record,log_tail,test_results)
      values($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`, [ticket.id, ticket.workspaceId, ticket.groupId,
      ticket.state, computer.key, JSON.stringify(ticket), logTail, JSON.stringify({ retained: 'x'.repeat(100_000) })])
    const stored = async () => (await db.pool.query(`select record,log_tail,test_results,durations,
      activity_record_revision::text as revision,xmin::text as transaction_id from ci_runs where id=$1`, [ticket.id])).rows[0]
    const before = await stored()
    const nativeBefore = await readNativeActivityFacts(db.pool, fixture.run.id)
    await applyApplicationMigrations(db.pool)
    await applyApplicationMigrations(db.pool)
    expect(await stored()).toEqual(before)
    expect(await readNativeActivityFacts(db.pool, fixture.run.id)).toEqual(nativeBefore)
    expect(nativeBefore.map(row => row.sequence)).toEqual(['2', '3', '4', '5', '6', '7', '9', '11'])
    expect(nativeBefore.find(row => row.sequence === '9')).toMatchObject({
      native_session_id: 'session-a', generation: '1', status: 'error', command_name: 'git', item_error: false,
    })
    expect(nativeBefore.find(row => row.sequence === '4')).toMatchObject({
      item_id: 'claude-tool', item_type: 'tool', native_session_id: 'claude-session', generation: '2', tool_name: 'Read',
    })
    expect(nativeBefore.find(row => row.sequence === '7')).toMatchObject({ item_id: 'dynamic', item_error: true })
    expect(nativeBefore.find(row => row.sequence === '6')).toMatchObject({ item_type: 'subagent', status: 'failed' })

    const poll = (token: string, name: string, args: unknown) => graphRpc(app, token, 'tools/call', { name, arguments: args })
    const readCi = async () => {
      const result = await poll(fixture.writer.token, 'ci_get', {
        workspaceId: ticket.workspaceId, ticketId: ticket.id,
      })
      expect(result.result?.isError, JSON.stringify(result)).not.toBe(true)
      return CiGetOutputSchema.parse(graphRpcValue(result.result))
    }
    // Observations settle in the background of a dispatch pass; wait for them before reading the stored ticket.
    const refreshCi = async () => { await ci.dispatch(); await ci.drain() }
    const ciBefore = await readCi()
    vi.useFakeTimers({ toFake: ['Date'] })
    await refreshCi()
    const observation = { status: 'available', lastSuccessAt: new Date().toISOString(),
      lastError: null, consecutiveFailures: 0, nextAttemptAt: null }
    const observedTicket = { ...ticket, observation }
    expect(await readCi()).toEqual({ ...ciBefore, run: observedTicket })
    const observed = await stored()
    expect(observed).toMatchObject({ record: observedTicket, log_tail: before.log_tail,
      revision: String(BigInt(before.revision) + 1n), test_results: before.test_results })
    await refreshCi()
    expect(await stored()).toEqual(observed)
    logTail = 'Refreshed log'
    await refreshCi()
    expect(await stored()).toMatchObject({ record: observedTicket, log_tail: logTail,
      revision: String(BigInt(observed.revision) + 1n), test_results: before.test_results })
    const refreshed = await stored()
    const ciRefreshed = await readCi()
    expect(ciRefreshed).toMatchObject({ run: observedTicket, logTail })
    await refreshCi()
    expect(await readCi()).toEqual(ciRefreshed)
    expect(await stored()).toEqual(refreshed)
    await db.pool.query('update ci_runs set durations=$2::jsonb where id=$1', [ticket.id, '{"unit":5}'])
    await db.pool.query('update ci_runs set test_results=$2::jsonb where id=$1', [ticket.id, '{"retained":"changed"}'])
    const changed = await stored()
    expect(changed.revision).toBe(String(BigInt(refreshed.revision) + 2n))
    await db.pool.query('update ci_runs set record=record,activity_record_revision=9999 where id=$1', [ticket.id])
    expect((await stored()).revision).toBe(changed.revision)

    const result = await poll(fixture.writer.token, 'ci_get', { workspaceId: ticket.workspaceId, ticketId: ticket.id })
    expect(result.result?.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(graphRpcValue(result.result))).toMatchObject({ run: ticket, logTail })
    const native = await poll(fixture.writer.token, 'run_get', {
      workspaceId: fixture.scope.workspaceId, runId: fixture.run.id, detail: 'full',
    })
    expect(native.result?.isError, JSON.stringify(native)).not.toBe(true)
    const snapshot = SavedRunDetailsSchema.parse(graphRpcValue(native.result)).activitySnapshot!
    expect(snapshot.activities.filter(activity => activity.kind === 'tool' || activity.kind === 'subagent'))
      .toHaveLength(nativeBefore.length)
    expect(JSON.stringify(snapshot)).not.toContain('private output')
    const denied = await fixture.credential([{ actions: ['workflows:read'], scope: { workspaceIds: [ticket.workspaceId] } }])
    for (const [name, args] of [
      ['ci_get', { workspaceId: ticket.workspaceId, ticketId: ticket.id }],
      ['run_get', { workspaceId: ticket.workspaceId, runId: fixture.run.id, detail: 'full' }],
    ] as const) {
      const blocked = await poll(denied.token, name, args)
      expect(blocked.error || blocked.result?.isError).toBeTruthy()
    }
    await db.pool.query(`insert into harness_native_events(execution_id,sequence,record)
      select $1,n,jsonb_build_object('type','item.snapshot','payload',jsonb_build_object('item',jsonb_build_object(
        'id','bounded-'||n,'type','commandExecution','status',case when n<1200 then 'completed' else 'running' end)))
      from generate_series(100,2201) n`, [executionId])
    const bounded = await readNativeActivityFacts(db.pool, fixture.run.id)
    expect(bounded).toHaveLength(2001)
    expect(bounded.filter(row => row.status === 'running')).toHaveLength(1001)
    expect((await db.pool.query('select count(*)::int as count from harness_native_events where execution_id=$1',
      [executionId])).rows[0]!.count).toBe(events.length + 2102)
  } finally {
    vi.useRealTimers()
    await ci.close()
    await app.close()
    await fixture.app.close()
    await db.close()
  }
}, 120_000)
