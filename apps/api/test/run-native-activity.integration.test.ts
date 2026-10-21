import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { OperatorRunCompactSchema } from '@foreman-code/contracts/operator-mcp'
import { HarnessExecutionSchema, type AgentConfigurationVersion, type NativeHarnessEvent } from '@foreman-code/contracts'
import { RunActivitiesPageSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { readNativeActivityFacts, projectNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'
import { openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { openRepeatCanonicalPublicationLocked, publishRepeatRunStateLocked } from '../src/modules/run-graph/repeatPublication.js'
import { bindRepeatNodeInput, repeatDigest, repeatExecutionIdentity, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { claudeNativeEvent } from '../src/modules/harnesses/claudeSdk/nativeEvents.js'
import type { ClaudeDecodedChange } from '../src/modules/harnesses/claudeSdk/normalization.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue, ownedGraph } from './eng04-graph-composition-fixture.js'

const occurredAt = '2026-10-04T10:00:00.000Z'
const executionId = 'native-activity-execution'

async function captureExecution(db: Awaited<ReturnType<typeof currentDatabase>>,
  fixture: Awaited<ReturnType<typeof graphFixture>>) {
  const node = agentWorkflowNode(fixture.version.definition.nodes[0])
  const candidate = HarnessExecutionSchema.parse({
    id: executionId, runId: fixture.run.id, workflowNodeId: node.id, agentId: node.agentId, attempt: 1,
    state: 'queued', input: {}, createdAt: occurredAt, nativeSessionId: 'native-session',
    agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId],
  })
  const ref = { nodeId: node.id, occurrence: null }
  const bound = bindRepeatNodeInput({ version: fixture.version, runInput: fixture.run.input,
    recipient: candidate, ref, occurrence: null, entry: null, predecessors: [] })
  const queued = HarnessExecutionSchema.parse({ ...candidate, input: bound.input })
  const slot = repeatSlotId(fixture.run.id, ref)
  const effect = { kind: 'input.bind' as const, entityId: queued.id,
    digest: repeatDigest({ ref, queued, inputDigest: bound.digest, bindings: bound.bindings }) }
  await ownedGraph(db, fixture, (owner) => owner.oneShotConnection().transaction(async (sql) => {
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

async function activityFixture(work: (pool: pg.Pool, fixture: Awaited<ReturnType<typeof graphFixture>>,
  app: ReturnType<typeof buildApp>) => Promise<void>, options: { harness?: AgentConfigurationVersion['harness'] } = {}) {
  await nim2691TaskDatabase(async (pool, directory) => {
    await applyApplicationMigrations(pool)
    const db = { pool, directory, schema: 'public', close: async () => {} } as Awaited<ReturnType<typeof currentDatabase>>
    const fixture = await graphFixture(db, { form: 'single', qualifiedReads: true, ...options })
    const runs = new RunManagementService(pool, fixture.commands, {} as never, {} as never, {} as never)
    const app = buildApp({
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: fixture.access, services: { commands: fixture.commands, workflows: fixture.workflows, runs } as never },
    })
    try {
      await captureExecution(db, fixture)
      await work(pool, fixture, app)
    } finally {
      await app.close()
      await fixture.app.close()
    }
  })
}

async function persistEvent(pool: pg.Pool, event: NativeHarnessEvent) {
  await pool.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({ ...event, executionId })])
}

async function readBoth(app: ReturnType<typeof buildApp>, fixture: Awaited<ReturnType<typeof graphFixture>>) {
  const args = { workspaceId: fixture.scope.workspaceId, runId: fixture.run.id, limit: 100 }
  const url = `/api/management/workspaces/${args.workspaceId}/runs/${args.runId}/activities?limit=100`
  const http = await app.inject({ method: 'GET', url, headers: graphHeaders(fixture.writer.token) })
  expect(http.statusCode, http.body).toBe(200)
  const page = RunActivitiesPageSchema.parse(http.json())
  const mcp = await graphRpc(app, fixture.writer.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
  expect(mcp.result?.isError).not.toBe(true)
  expect(RunActivitiesPageSchema.parse(graphRpcValue(mcp.result))).toEqual(page)
  const denied = await fixture.credential([{ actions: ['workflows:read'], scope: { workspaceIds: [args.workspaceId] } }])
  expect((await app.inject({ method: 'GET', url, headers: graphHeaders(denied.token) })).statusCode).toBe(403)
  const deniedMcp = await graphRpc(app, denied.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
  expect(deniedMcp.error || deniedMcp.result?.isError).toBeTruthy()
  return page
}

async function readSnapshot(app: ReturnType<typeof buildApp>, fixture: Awaited<ReturnType<typeof graphFixture>>) {
  const args = { workspaceId: fixture.scope.workspaceId, runId: fixture.run.id }
  const url = `/api/management/workspaces/${args.workspaceId}/runs/${args.runId}`
  const http = await app.inject({ method: 'GET', url, headers: graphHeaders(fixture.writer.token) })
  expect(http.statusCode, http.body).toBe(200)
  const details = SavedRunDetailsSchema.parse(http.json())
  const mcp = await graphRpc(app, fixture.writer.token, 'tools/call', { name: 'run_get', arguments: { ...args, detail: 'full' } })
  expect(mcp.result?.isError).not.toBe(true)
  expect(SavedRunDetailsSchema.parse(graphRpcValue(mcp.result))).toEqual(details)
  const denied = await fixture.credential([{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
  const blocked = await graphRpc(app, denied.token, 'tools/call', { name: 'run_get', arguments: { ...args, detail: 'full' } })
  expect(blocked.error || blocked.result?.isError).toBeTruthy()
  expect(details.activitySnapshot).toBeDefined()
  return details.activitySnapshot!
}

describe('persisted native Run activity', () => {
  it('reads persisted work results through HTTP and MCP with the same Run grants and redaction', async () => {
    await activityFixture(async (pool, fixture, app) => {
      const token = `opm_${'a'.repeat(43)}`
      const result = { outcome: 'succeeded', output: {
        routing: { kind: 'finish', outcome: 'done' },
        data: { latestDeliverable: `Implemented the requested change ${token}`,
          remainingFindings: [{ message: `Review needs a decision ${token}` }] },
      } }
      await pool.query(`update harness_executions set record=jsonb_set(record,'{result}',$2::jsonb)
        where id=$1 and run_id=$3`, [executionId, JSON.stringify(result), fixture.run.id])
      for (const kind of ['work_result_accepted', 'work_needs_direction']) {
        await pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
          values($1,'backend',$2,$3,$4,'{}'::jsonb)`, [fixture.run.id, kind, executionId, occurredAt])
      }
      const page = await readBoth(app, fixture)
      const results = page.items.filter((item) => item.workResult)
      expect(results.map((item) => item.kind)).toEqual(['agent_work', 'needs_direction'])
      for (const item of results) expect(item.workResult).toEqual({ outcome: 'done',
        latestDeliverable: 'Implemented the requested change [REDACTED]',
        remainingFindings: [{ message: 'Review needs a decision [REDACTED]' }] })
      expect(JSON.stringify(page)).not.toContain(token)
      const readback = await readBoth(app, fixture)
      expect(readback.items).toEqual(page.items)
      const stored = await pool.query<{ result: unknown }>(
        "select record->'result' as result from harness_executions where id=$1", [executionId])
      expect(stored.rows[0]?.result).toEqual(result)
    })
  }, 120000)

  it('reads Codex messages, streams, edits and tools through HTTP and MCP with safe details', async () => {
    await activityFixture(async (pool, fixture, app) => {
      const events: Array<Pick<NativeHarnessEvent, 'type' | 'payload'>> = [
        { type: 'native.notification', payload: {
          nativeMethod: 'item/agentMessage/delta', delta: 'private message',
        } },
        { type: 'native.notification', payload: {
          nativeMethod: 'item/commandExecution/outputDelta', delta: 'private output',
        } },
        { type: 'item.started', payload: { item: { id: 'thinking', type: 'reasoning' } } },
        { type: 'item.completed', payload: { item: { id: 'thinking', type: 'reasoning', summary: ['private reasoning'] } } },
        { type: 'item.completed', payload: { item: {
          id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'private progress',
        } } },
        { type: 'item.completed', payload: { item: {
          id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'private answer',
        } } },
        { type: 'item.completed', payload: { item: {
          id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'private input' }],
        } } },
        { type: 'item.completed', payload: { item: {
          id: 'edit', type: 'fileChange', status: 'completed',
          changes: [{ path: '/private/file', kind: { type: 'update' }, diff: 'private diff' }],
        } } },
        { type: 'item.completed', payload: { item: {
          id: 'command', type: 'commandExecution', status: 'completed',
          command: 'git show private-argument', aggregatedOutput: 'private output', exitCode: 0,
        } } },
        { type: 'item.completed', payload: { item: {
          id: 'mcp', type: 'mcpToolCall', tool: 'workspace_list', status: 'completed',
          arguments: { token: 'private credential' }, result: { text: 'private tool output' }, error: null,
        } } },
        { type: 'item.completed', payload: { item: {
          id: 'dynamic', type: 'dynamicToolCall', tool: 'lookup', status: 'completed', success: false,
          arguments: { secret: 'private credential' },
        } } },
        { type: 'item.completed', payload: { item: {
          id: 'search', type: 'webSearch', query: 'private search',
        } } },
        { type: 'native.notification', payload: { nativeMethod: 'thread/tokenUsage/updated',
          tokenUsage: { private: 'private token details' } } },
        { type: 'native.unlinked_notification', payload: { method: 'item/completed', params: { threadId: 'child-thread', item: {
          id: 'child-command', type: 'commandExecution', status: 'completed', command: 'ls private-argument', exitCode: 0,
        } } } },
      ]
      for (const [index, event] of events.entries()) {
        await persistEvent(pool, { ...event, sequence: index + 1, occurredAt,
          payload: { ...event.payload, threadId: 'native-session' } })
      }
      const page = await readBoth(app, fixture)
      expect(page.items.map(item => item.summary)).toEqual([
        'Run queued', 'Agent work queued',
        'Agent reasoning started', 'Agent reasoning completed',
        'Agent message completed', 'Agent message completed', 'User message completed', 'File change completed',
        'Command: git completed', 'Tool: workspace_list completed', 'Tool: lookup failed', 'Web search completed',
        'Subagent: Command: ls completed',
      ])
      expect(page.items.map(item => item.detail)).toEqual([
        undefined, undefined,
        undefined, undefined,
        'Progress update.', 'Final answer.', undefined, 'Changes cover 1 file.', 'Exit code: 0.',
        undefined, undefined, undefined, 'Exit code: 0.',
      ])
      expect(JSON.stringify(page)).not.toContain('private')
      const snapshot = await readSnapshot(app, fixture)
      const diagnostics = snapshot.activities.filter(item => item.kind === 'diagnostic')
      expect(diagnostics.map(item => item.message).join()).not.toMatch(/updated|Received/)
      expect(diagnostics.map(item => item.message)).toContain('File change completed: Changes cover 1 file.')
      expect(diagnostics.map(item => item.message)).toContain('Agent message completed: Final answer.')
      expect(snapshot.activities.filter(item => item.kind === 'tool').map(item => [item.title, item.status])).toEqual([
        ['File change', 'completed'], ['Command: git', 'completed'], ['Tool: workspace_list', 'completed'],
        ['Tool: lookup', 'failed'], ['Web search', 'completed'],
      ])
      expect(snapshot.active.filter(item => item.ref.kind === 'tool')).toEqual([])
      expect(JSON.stringify(snapshot)).not.toContain('private')
      expect((await pool.query('select count(*)::integer as count from harness_native_events where execution_id=$1',
        [executionId])).rows[0]?.count).toBe(events.length)
    })
  }, 120000)

  it('keeps active tools beyond completed history and only reports unfinished overflow', async () => {
    await activityFixture(async (pool, fixture, app) => {
      const insertItems = (start: number, end: number, status: string) => pool.query(`
        insert into harness_native_events(execution_id,sequence,record)
        select $1,n,jsonb_build_object('sequence',n,'occurredAt',$4::text,'type','item.snapshot',
          'payload',jsonb_build_object('threadId','native-session','item',jsonb_build_object(
            'id','command-'||n,'type','commandExecution','status',$5::text)))
        from generate_series($2::integer,$3::integer) n`, [executionId, start, end, occurredAt, status])
      await insertItems(1, 1001, 'completed')
      const completed = await readSnapshot(app, fixture)
      expect(completed.active.filter(item => item.ref.kind === 'tool')).toEqual([])
      expect(completed.hasMoreActiveWork).not.toBe(true)
      expect(completed.activities.filter(item => item.kind === 'tool')).toHaveLength(1000)
      await insertItems(1002, 1002, 'running')
      const running = await readSnapshot(app, fixture)
      expect(running.active.filter(item => item.ref.kind === 'tool'))
        .toMatchObject([{ native: { itemId: 'command-1002' }, evidence: 'confirmed' }])
      expect(running.hasMoreActiveWork).not.toBe(true)
      await insertItems(1003, 2002, 'running')
      const facts = await readNativeActivityFacts(pool, fixture.run.id)
      expect(facts).toHaveLength(2001)
      const bounded = projectNativeActivityFacts(facts, () => ({
        owner: { kind: 'run', ...fixture.scope }, harness: 'codex', sessionId: 'native-session', terminal: false,
      }))
      expect(bounded.active).toHaveLength(1000)
      expect(bounded.hasMore).toBe(true)
      expect((await pool.query('select count(*)::integer as count from harness_native_events where execution_id=$1',
        [executionId])).rows[0]?.count).toBe(2002)
    })
  }, 120000)

  it('bounds default MCP detail and names tools and command programs without arguments or credentials', async () => {
    await activityFixture(async (pool, fixture, app) => {
      for (let index = 0; index < 31; index++) {
        await persistEvent(pool, { sequence: index + 1, occurredAt,
          type: 'item.completed', payload: { threadId: 'native-session', item: {
            id: `command-${index}`, type: 'commandExecution', status: 'completed',
            command: '/usr/bin/git --token private-command-secret status',
          } },
        })
      }
      await persistEvent(pool, { sequence: 32, occurredAt,
        type: 'item.completed', payload: { threadId: 'native-session', item: {
          id: 'mcp-call', type: 'mcpToolCall', tool: 'workspace_list', status: 'completed',
          arguments: { token: 'private-tool-secret' },
        } },
      })
      await persistEvent(pool, { sequence: 33, occurredAt,
        type: 'item.completed', payload: { threadId: 'native-session', item: {
          id: 'opaque-command', type: 'commandExecution', command: 'privateExecutableSecret --password private-secret',
          status: 'completed',
        } },
      })
      const forbidden = await fixture.credential([{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
      const denied = await graphRpc(app, forbidden.token, 'tools/call', { name: 'run_get',
        arguments: { workspaceId: fixture.scope.workspaceId, runId: fixture.run.id } })
      expect(denied.error || denied.result?.isError).toBeTruthy()
      const result = await graphRpc(app, fixture.writer.token, 'tools/call', { name: 'run_get',
        arguments: { workspaceId: fixture.scope.workspaceId, runId: fixture.run.id } })
      expect(result.result?.isError).not.toBe(true)
      const compact = OperatorRunCompactSchema.parse(graphRpcValue(result.result))
      expect(compact.run.id).toBe(fixture.run.id)
      expect(compact.activities).toHaveLength(25)
      expect(compact.activitiesOmitted).toBeGreaterThan(0)
      expect(compact.activities.some(item => item.title === 'Command: git')).toBe(true)
      expect(compact.activities.some(item => item.title === 'Tool: workspace_list')).toBe(true)
      expect(compact.run).not.toHaveProperty('input')
      expect(JSON.stringify(compact)).not.toMatch(/private-command-secret|private-tool-secret|privateExecutableSecret|private-secret|--token|--password/)
      expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(16 * 1024)
      const full = await readSnapshot(app, fixture)
      expect(full.activities.filter(item => item.kind === 'tool')).toHaveLength(33)
      const page = await readBoth(app, fixture)
      expect(page.items.some(item => item.summary === 'Tool: workspace_list completed')).toBe(true)
    })
  }, 120000)

  it('distinguishes absent and JSON-null errors from real error objects in PostgreSQL', async () => {
    await activityFixture(async (pool, fixture, app) => {
      const errors = [{}, { error: null }, { error: { message: 'private failure body' } }]
      for (const [index, error] of errors.entries()) {
        await persistEvent(pool, { sequence: index + 1, occurredAt, type: 'item.completed', payload: {
          threadId: 'native-session', item: { id: `command-${index}`, type: 'commandExecution', status: 'completed', ...error },
        } })
      }
      const page = await readBoth(app, fixture)
      const tools = page.items.filter((item) => item.kind === 'tool_action')
      expect(tools.map((item) => item.status)).toEqual(['completed', 'completed', 'failed'])
      expect(tools.map((item) => item.summary)).toEqual([
        'Command action completed', 'Command action completed', 'Command action failed',
      ])
      expect(JSON.stringify(page)).not.toContain('private failure body')
      const snapshot = await readSnapshot(app, fixture)
      expect(snapshot.activities.filter((item) => item.kind === 'tool').map((item) => item.status))
        .toEqual(['completed', 'completed', 'failed'])
      expect(snapshot.active.filter((item) => item.ref.kind === 'tool')).toEqual([])
      expect((await pool.query('select count(*)::integer as count from harness_native_events where execution_id=$1',
        [executionId])).rows[0]?.count).toBe(3)
    })
  }, 120000)

  it('keeps every native cancellation spelling canceled with and without completion envelopes', async () => {
    await activityFixture(async (pool, fixture, app) => {
      let sequence = 1
      for (const status of ['canceled', 'cancelled', 'interrupted']) {
        for (const type of ['item.started', 'item.completed', 'message.part.updated']) {
          const itemId = `cancellation-${sequence}`
          const payload = type === 'message.part.updated'
            ? { part: { id: itemId, type: 'tool', tool: 'bash', sessionID: 'native-session', state: { status } } }
            : { threadId: 'native-session', item: { id: itemId, type: 'commandExecution', status, error: null } }
          await persistEvent(pool, { sequence: sequence++, occurredAt, type, payload })
        }
      }
      const page = await readBoth(app, fixture)
      const tools = page.items.filter((item) => item.kind === 'tool_action')
      expect(tools).toHaveLength(9)
      expect(tools.every((item) => item.status === 'canceled' && item.summary === 'Command action canceled')).toBe(true)
      const native = projectNativeActivityFacts(await readNativeActivityFacts(pool, fixture.run.id), () => ({
        owner: { kind: 'run', ...fixture.scope }, harness: 'codex', sessionId: 'native-session', terminal: false,
      }))
      expect(native.activities).toHaveLength(9)
      expect(native.activities.every((item) => 'status' in item && item.status === 'canceled')).toBe(true)
      expect(native.active).toEqual([])
      const snapshot = await readSnapshot(app, fixture)
      expect(snapshot.activities.filter((item) => item.kind === 'tool').map((item) => item.status))
        .toEqual(Array(9).fill('canceled'))
      expect(snapshot.active.filter((item) => item.ref.kind === 'tool')).toEqual([])
    })
  }, 120000)

  it('projects persisted Claude normalized tool and task facts through HTTP, MCP and snapshots', async () => {
    const harness: AgentConfigurationVersion['harness'] = {
      harness: 'claude', model: 'activity-fixture', authMode: 'subscription', configDirectory: '/fixture/profile',
      permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read', 'Bash', 'Agent'],
      permissionRules: [], instructions: '', mcpServers: {},
    }
    await activityFixture(async (pool, fixture, app) => {
      const changes: ClaudeDecodedChange[] = [
        { kind: 'tool', itemId: 'claude:tool:read', name: 'Read', status: 'running', provisional: true,
          input: { path: '/private/tool-path' } },
        { kind: 'tool', itemId: 'claude:tool:read', name: 'Read', status: 'completed', provisional: false,
          output: 'private tool output' },
        { kind: 'tool', itemId: 'claude:tool:bash', name: 'Bash', status: 'failed', provisional: false },
        { kind: 'tool', itemId: 'claude:tool:mcp', name: 'mcp__graphql__context_get', status: 'completed', provisional: false },
        { kind: 'task', taskId: 'child', status: 'running', description: 'private child description' },
        { kind: 'task', taskId: 'child', status: 'canceled', summary: 'private child answer' },
        { kind: 'task', taskId: 'unresolved-child', status: 'unknown' },
        { kind: 'text', itemId: 'child-answer', operation: 'replace', text: 'private child text', final: true },
      ]
      for (const [index, change] of changes.entries()) {
        const event = claudeNativeEvent({ change, evidence: {
          owner: { ownerId: executionId, attemptId: '1', generation: 7 }, observedAt: occurredAt,
          eventId: `sdk-event-${index}`, nativeSessionId: 'native-session', promptUuids: ['private-prompt-uuid'],
          ...(change.kind === 'tool' ? { toolUseId: change.itemId.slice('claude:tool:'.length) } : {}),
          ...(change.kind === 'text' ? { parentToolUseId: 'read' } : {}),
        } }, index + 1)
        await persistEvent(pool, event)
      }
      const page = await readBoth(app, fixture)
      expect(page.items.filter((item) => item.kind === 'tool_action').map((item) => [item.summary, item.status])).toEqual([
        ['Read file started', 'running'], ['Read file completed', 'completed'], ['Run command failed', 'failed'],
        ['MCP tool action completed', 'completed'], ['Subagent activity started', 'running'],
        ['Subagent activity canceled', 'canceled'], ['Subagent activity unknown', 'unknown'],
      ])
      const snapshot = await readSnapshot(app, fixture)
      const native = snapshot.activities.filter((item) => item.source.system === 'harness_native_events')
      expect(native.map((item) => item.kind === 'tool' || item.kind === 'subagent'
        ? [item.native?.itemId, item.title, item.status] : null)).toEqual([
        ['read', 'Read file', 'completed'], ['bash', 'Run command', 'failed'],
        ['mcp', 'MCP tool action', 'completed'], ['child', 'Subagent activity', 'canceled'],
        ['unresolved-child', 'Subagent activity', 'unknown'],
      ])
      expect(native.every((item) => item.native?.harness === 'claude'
        && item.native.sessionId === 'native-session' && item.native.generation === '7')).toBe(true)
      expect(native.every((item) => item.native?.turnId === undefined)).toBe(true)
      expect(snapshot.active.filter((item) => item.ref.kind === 'tool' || item.ref.kind === 'subagent'))
        .toMatchObject([{ evidence: 'unknown', native: { itemId: 'unresolved-child' } }])
      expect(JSON.stringify({ page, snapshot })).not.toMatch(/private (tool|child)|private-prompt|\/private\/tool-path/)
      expect((await pool.query('select count(*)::integer as count from harness_native_events where execution_id=$1',
        [executionId])).rows[0]?.count).toBe(changes.length)
    }, { harness })
  }, 120000)
})
