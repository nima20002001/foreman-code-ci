import { HarnessNativeEventSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { normalizeSubagentEvent, isChildCandidate } from './normalization.js'
import { applySubagentChanges, readChildren } from './repository.js'
import type { SubagentProjectionContext } from './types.js'

interface ContextRow { workspace_id: string; workflow_id: string; workflow_version_id: string; run_id: string;
  id: string; workflow_node_id: string; agent_id: string; attempt: number; reference: unknown;
  placement: { hostRef?: { deviceId?: string; mainId?: string }; payload?: { instanceId?: string } } | null;
  configuration_id: string; main_id: string }
export async function readProjectionContext(sql: GraphSqlClient, executionId: string): Promise<SubagentProjectionContext | undefined> {
  const row = (await sql.query<ContextRow>(`select r.workspace_id,r.workflow_id,r.workflow_version_id,e.run_id,e.id,e.workflow_node_id,e.agent_id,e.attempt,
    s.reference,p.record as placement,e.record->>'agentConfigurationVersionId' as configuration_id,m.id as main_id
    from harness_executions e join runs r on r.id=e.run_id join execution_native_sessions s on s.execution_id=e.id
    left join run_node_placements p on p.run_id=r.id and p.node_id=e.workflow_node_id
    cross join application_installation m where e.id=$1 and r.record->>'executionSemanticsVersion'='3'`, [executionId])).rows[0]
  if (!row || !row.configuration_id) return undefined
  const session = NativeSessionReferenceSchema.safeParse(row.reference)
  if (!session.success) return undefined
  // Original Main-local allocations pin the immutable configuration ID as their instance. Remote allocations use only their accepted placement.
  return { workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowVersionId: row.workflow_version_id, runId: row.run_id,
    parentExecutionId: row.id, parentNodeId: row.workflow_node_id, parentAgentId: row.agent_id, parentAttemptKey: `${row.id}:${row.attempt}`,
    provider: session.data.harness, parentSessionId: session.data.nativeSessionId,
    profile: { deviceId: row.placement?.hostRef?.deviceId ?? row.placement?.hostRef?.mainId ?? row.main_id,
      harnessInstanceId: row.placement?.payload?.instanceId ?? row.configuration_id, providerVersion: session.data.providerVersion } }
}
export async function projectSubagentEvent(sql: GraphSqlClient, context: SubagentProjectionContext, input: unknown, pending = false) {
  const event = HarnessNativeEventSchema.parse(input)
  if (context.provider === 'opencode') return
  const payload = event.payload
  const children = await readChildren(sql, context.runId, context.parentExecutionId)
  const aliases = new Map<string, string>()
  if (context.provider === 'claude') {
    const spawn = payload.parentToolUseId ?? (event.type === 'claude.task' ? payload.toolUseId : undefined)
    const task = event.type === 'claude.task' ? payload.taskId : undefined
    if (typeof spawn === 'string' || typeof task === 'string') {
      const rows = (await sql.query<{ subagent_id: string; task_id: string | null; spawn_id: string | null }>(`select distinct subagent_id,fact->>'taskId' as task_id,fact->>'spawnToolUseId' as spawn_id
        from run_subagent_lifecycle where execution_id=$1 and (fact->>'taskId'=$2 or fact->>'spawnToolUseId'=$3)`, [context.parentExecutionId, task ?? null, spawn ?? null])).rows
      for (const row of rows) for (const [kind, id] of [['task', row.task_id], ['spawn', row.spawn_id]] as const) {
        if (!id) continue
        const key = `${kind}:${id}`
        if (aliases.has(key) && aliases.get(key) !== row.subagent_id) throw new Error('Conflicting verified native child alias.')
        aliases.set(key, row.subagent_id)
      }
    }
  }
  const changes = event.type === 'transport.disconnected' || event.type === 'claude.diagnostic' && ['CLAUDE_EOF_WITHOUT_RESULT', 'CLAUDE_STREAM_ERROR_WITHOUT_RESULT'].includes(String(payload.code))
    ? children.filter(child => !['completed', 'failed', 'canceled'].includes(child.status)).map(child => ({ kind: 'status' as const, childId: (child.native.childSessionId ?? child.native.agentId)!, status: 'unknown' as const }))
    : normalizeSubagentEvent(context, event, children, aliases)
  await applySubagentChanges(sql, context, HarnessNativeEventSchema.parse(input), changes)
  if (!changes.length && isChildCandidate(context, event, children)) {
    await sql.query('insert into run_subagent_pending_events(execution_id,sequence) values($1,$2) on conflict do nothing', [event.executionId, event.sequence])
  } else if (changes.length || pending) {
    await sql.query('delete from run_subagent_pending_events where execution_id=$1 and sequence=$2', [event.executionId, event.sequence])
  }
}
/** Caller holds the Run projection lock. Rows and the watermark commit together; raw append queues work in its own transaction. */
export async function reconcileRunSubagents(sql: GraphSqlClient, runId: string): Promise<'caught-up' | 'catching-up'> {
  const queue = (await sql.query<{ execution_id: string; projected_sequence: number; latest_sequence: number }>(`select q.* from run_subagent_projection_queue q
    join harness_executions e on e.id=q.execution_id where e.run_id=$1 and q.projected_sequence<q.latest_sequence order by q.execution_id limit 32`, [runId])).rows
  let budget = 500
  for (const entry of queue) {
    if (!budget) break
    const context = await readProjectionContext(sql, entry.execution_id)
    if (!context) continue // No accepted session/profile linkage: raw evidence stays queued.
    const events = (await sql.query<{ sequence: number; record: unknown }>('select sequence,record from harness_native_events where execution_id=$1 and sequence>$2 order by sequence limit $3',
      [entry.execution_id, entry.projected_sequence, budget])).rows
    for (const row of events) await projectSubagentEvent(sql, context, { ...row.record as Record<string, unknown>, sequence: row.sequence })
    if (events.length) await sql.query('update run_subagent_projection_queue set projected_sequence=greatest(projected_sequence,$2) where execution_id=$1', [entry.execution_id, events.at(-1)!.sequence])
    budget -= events.length
  }
  // One bounded retry pass permits out-of-order roles and ancestry to join without ever authorizing arbitrary native IDs.
  const pending = (await sql.query<{ execution_id: string; sequence: number; record: unknown }>(`select p.execution_id,p.sequence,n.record
    from run_subagent_pending_events p join harness_native_events n using(execution_id,sequence)
    join harness_executions e on e.id=p.execution_id where e.run_id=$1 order by p.sequence limit 500`, [runId])).rows
  const contexts = new Map<string, Promise<SubagentProjectionContext | undefined>>()
  for (const row of pending) {
    if (!contexts.has(row.execution_id)) contexts.set(row.execution_id, readProjectionContext(sql, row.execution_id))
    const context = await contexts.get(row.execution_id)
    if (context) await projectSubagentEvent(sql, context, { ...row.record as Record<string, unknown>, sequence: row.sequence }, true)
  }
  const remaining = (await sql.query<{ pending: boolean }>(`select exists(select 1 from run_subagent_projection_queue q join harness_executions e on e.id=q.execution_id
    where e.run_id=$1 and q.projected_sequence<q.latest_sequence) as pending`, [runId])).rows[0]!.pending
  return remaining ? 'catching-up' : 'caught-up'
}
export async function markSubagentCoverage(sql: GraphSqlClient, child: RunSubagent, coverage: RunSubagent['coverage']) {
  const truncated = (await sql.query<{ truncated: boolean }>(`select exists(select 1 from run_subagent_items where subagent_id=$1
    and record#>>'{truncation,truncated}'='true') as truncated`, [child.id])).rows[0]!.truncated
  const next = { ...child, revision: String(BigInt(child.revision) + 1n), coverage: truncated
    ? { transcript: coverage.transcript === 'complete' ? 'partial' : coverage.transcript, tools: coverage.tools === 'complete' ? 'partial' : coverage.tools, gaps: true } : coverage }
  await sql.query('update run_subagents set revision=$2,record=$3::jsonb where id=$1', [child.id, next.revision, JSON.stringify(next)])
}
