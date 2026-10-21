import { createHash } from 'node:crypto'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { RunSubagentMessageSchema, RunSubagentSchema, RunSubagentToolSchema, subagentCapabilities,
  type RunSubagent, type SubagentSource } from '@foreman-code/contracts/subagents'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { sanitizeSubagentText, sanitizeSubagentValue } from './normalization.js'
import type { SubagentChange, SubagentProjectionContext, SubagentStoredItem } from './types.js'

export const subagentId = (...identity: unknown[]) => createHash('sha256').update(JSON.stringify(identity)).digest('hex')
const terminal = (status: string) => ['completed', 'failed', 'canceled'].includes(status)
export async function readChildren(sql: GraphSqlClient, runId: string, executionId?: string): Promise<RunSubagent[]> {
  const rows = (await sql.query<{ record: unknown }>('select record from run_subagents where run_id=$1 and ($2::text is null or parent_execution_id=$2) order by id limit 1001', [runId, executionId ?? null])).rows
  if (rows.length > 1000) throw new DomainError('SUBAGENT_REGISTRY_LIMIT', 'The bounded child projection is full.', 409)
  return rows.map(row => RunSubagentSchema.parse(row.record))
}
function source(event: HarnessNativeEvent): SubagentSource {
  const payload = event.payload
  return { executionId: event.executionId, sequence: event.sequence,
    ...(event.connectionId ? { connectionId: event.connectionId } : {}),
    ...(typeof payload.nativeEventId === 'string' ? { nativeEventId: payload.nativeEventId } : {}),
    ...(typeof payload.turnId === 'string' ? { nativeTurnId: payload.turnId } : {}),
    ...(typeof payload.runtimeGeneration === 'number' || typeof payload.runtimeGeneration === 'string' ? { generation: String(payload.runtimeGeneration) } : {}) }
}
async function writeChild(sql: GraphSqlClient, child: RunSubagent) {
  const parsed = RunSubagentSchema.parse(child)
  await sql.query(`update run_subagents set revision=$2,record=$3::jsonb where id=$1`, [child.id, child.revision, JSON.stringify(parsed)])
}
async function writeItem(sql: GraphSqlClient, kind: 'message' | 'tool', item: SubagentStoredItem) {
  await sql.query(`insert into run_subagent_items(subagent_id,kind,id,revision,record) values($1,$2,$3,$4,$5::jsonb)
    on conflict(subagent_id,kind,id) do update set revision=excluded.revision,record=excluded.record`,
  [item.subagentId, kind, item.id, item.revision, JSON.stringify(item)])
}
export async function applySubagentChanges(sql: GraphSqlClient, context: SubagentProjectionContext, event: HarnessNativeEvent,
  changes: readonly SubagentChange[]): Promise<void> {
  const digest = subagentId(event)
  for (const change of changes) {
    const children = await readChildren(sql, context.runId, context.parentExecutionId)
    let child = children.find(value => (value.native.childSessionId ?? value.native.agentId) === change.childId)
    if (change.kind === 'discover') {
      const parent = change.parentSessionId === context.parentSessionId ? undefined
        : children.find(value => (value.native.childSessionId ?? value.native.agentId) === change.parentSessionId)
      if (change.parentSessionId !== context.parentSessionId && !parent) continue
      if (child && (child.nativeMode !== change.nativeMode || child.native.parentSessionId !== change.parentSessionId)) {
        throw new DomainError('SUBAGENT_SOURCE_CONFLICT', 'Native child ancestry or mode conflicts with its accepted identity.', 409)
      }
      if (!child) {
        if (children.length >= 1000) throw new DomainError('SUBAGENT_REGISTRY_LIMIT', 'The bounded child projection is full.', 409)
        const id = subagentId(context.parentExecutionId, change.nativeMode, change.parentSessionId, change.childId)
        child = RunSubagentSchema.parse({ schemaVersion: 1, id, revision: '1',
          workspaceId: context.workspaceId, workflowId: context.workflowId, workflowVersionId: context.workflowVersionId, runId: context.runId,
          parentNodeId: context.parentNodeId, parentAgentId: context.parentAgentId, parentExecutionId: context.parentExecutionId,
          parentAttemptKey: context.parentAttemptKey, parentSubagentId: parent?.id ?? null,
          provider: context.provider, nativeMode: change.nativeMode,
          native: { parentSessionId: change.parentSessionId, ...(context.provider === 'claude' ? { agentId: change.childId } : { childSessionId: change.childId }),
            ...(change.spawnToolUseId ? { spawnToolUseId: change.spawnToolUseId } : {}), ...(change.taskId ? { taskId: change.taskId } : {}),
            ...(change.agentPath ? { agentPath: change.agentPath } : {}), ...(change.turnId ? { currentTurnId: change.turnId } : {}) },
          profile: context.profile, name: change.name ?? null, status: change.status, evidence: change.status === 'unknown' ? 'reconciling' : 'confirmed',
          firstObservedAt: event.occurredAt, startedAt: change.status === 'running' ? event.occurredAt : null,
          finishedAt: terminal(change.status) ? event.occurredAt : null, lastObservedAt: event.occurredAt,
          coverage: { transcript: 'unavailable', tools: 'unavailable', gaps: true }, capabilities: subagentCapabilities(change.nativeMode) })
        await sql.query(`insert into run_subagents(id,run_id,parent_execution_id,native_mode,parent_native_session_id,provider_child_id,parent_subagent_id,revision,record)
          values($1,$2,$3,$4,$5,$6,$7,1,$8::jsonb)`, [id, context.runId, context.parentExecutionId, change.nativeMode, change.parentSessionId, change.childId, parent?.id ?? null, JSON.stringify(child)])
      }
    }
    if (!child) continue
    const receipt = (await sql.query<{ digest: string }>('select digest from run_subagent_sources where subagent_id=$1 and execution_id=$2 and sequence=$3', [child.id, event.executionId, event.sequence])).rows[0]
    if (receipt) {
      if (receipt.digest !== digest) throw new DomainError('SUBAGENT_SOURCE_CONFLICT', 'The durable source identity changed.', 409)
      continue
    }
    const next = structuredClone(child)
    next.revision = String(BigInt(child.revision) + 1n)
    if (change.kind === 'discover') {
      for (const key of ['taskId', 'spawnToolUseId', 'agentPath'] as const) {
        const alias = change[key]
        if (!alias) continue
        if (event.occurredAt >= child.lastObservedAt) next.native[key] = alias
      }
      next.name ??= change.name ?? null
    }
    next.lastObservedAt = event.occurredAt > child.lastObservedAt ? event.occurredAt : child.lastObservedAt
    if (change.kind === 'discover' || change.kind === 'status') {
      const lifecycleAt = (await sql.query<{ lifecycle_at: Date | null }>('select lifecycle_at from run_subagents where id=$1', [child.id])).rows[0]?.lifecycle_at?.toISOString()
      const currentTask = change.kind === 'status' && change.taskId
      const newTask = change.kind === 'status' && change.activateTask && change.taskId !== child.native.taskId
      const staleTask = currentTask && child.native.taskId && currentTask !== child.native.taskId && !newTask
      if (currentTask && (!child.native.taskId || newTask)) next.native.taskId = currentTask
      // Older replay cannot reactivate terminal work. A new observed turn can; old turn facts remain append-only.
      const newTurn = (change.turnId && change.turnId !== child.native.currentTurnId || newTask) && (!lifecycleAt || event.occurredAt >= lifecycleAt)
      if (!staleTask && (!lifecycleAt || event.occurredAt >= lifecycleAt) && (!terminal(child.status) || terminal(change.status) || newTurn)) {
        next.status = change.status
        next.evidence = change.status === 'unknown' ? 'reconciling' : 'confirmed'
        if (change.turnId) next.native.currentTurnId = change.turnId
        if (change.status === 'running') { next.startedAt ??= event.occurredAt; if (newTurn) next.finishedAt = null }
        if (terminal(change.status)) next.finishedAt = newTurn || next.status !== child.status ? event.occurredAt : child.finishedAt ?? event.occurredAt
        if (change.status !== 'unknown') await sql.query('update run_subagents set lifecycle_at=$2 where id=$1', [child.id, event.occurredAt])
      }
      await sql.query('insert into run_subagent_lifecycle(subagent_id,execution_id,sequence,fact) values($1,$2,$3,$4::jsonb) on conflict do nothing',
        [child.id, event.executionId, event.sequence, JSON.stringify({ ...change, occurredAt: event.occurredAt, source: source(event) })])
    } else {
      const kind = change.kind
      const nativeId = change.kind === 'message' ? [change.nativeMessageId, change.blockId ?? null] : [change.nativeToolId]
      const id = subagentId(child.id, kind, ...nativeId)
      const prior = (await sql.query<{ record: SubagentStoredItem }>('select record from run_subagent_items where subagent_id=$1 and kind=$2 and id=$3', [child.id, kind, id])).rows[0]?.record
      const base = { id, subagentId: child.id, revision: String(BigInt(prior?.revision ?? '0') + 1n), sequence: prior?.sequence ?? event.sequence, source: source(event) }
      if (change.kind === 'message') {
        const sanitized = sanitizeSubagentText(change.text)
        if (change.nativeTruncation) sanitized.truncation = { truncated: sanitized.truncation.truncated || change.nativeTruncation.truncated,
          originalBytes: Math.max(sanitized.truncation.originalBytes, change.nativeTruncation.originalBytes) }
        const old = prior ? RunSubagentMessageSchema.parse(prior) : undefined
        if (old && old.role !== change.role) throw new DomainError('SUBAGENT_SOURCE_CONFLICT', 'The native message role changed.', 409)
        if (old?.final && (!change.final || event.sequence < old.source.sequence)) continue
        if (old?.final && old.text !== sanitized.text) throw new DomainError('SUBAGENT_SOURCE_CONFLICT', 'The final native message identity changed content.', 409)
        await writeItem(sql, kind, RunSubagentMessageSchema.parse({ ...base, nativeMessageId: change.nativeMessageId,
          ...(change.blockId ? { nativeBlockId: change.blockId } : {}), ...(change.parentToolUseId ? { parentToolUseId: change.parentToolUseId } : {}),
          role: change.role, ...sanitized, final: change.final, occurredAt: old?.occurredAt ?? event.occurredAt }))
        next.coverage.transcript = 'partial'
        if (sanitized.truncation.truncated) next.coverage.gaps = true
      } else {
        const old = prior ? RunSubagentToolSchema.parse(prior) : undefined
        if (old && terminal(old.status) && !terminal(change.status)) continue
        const values = Object.fromEntries((['input', 'output', 'error'] as const).filter(key => change[key] !== undefined)
          .map(key => [key, sanitizeSubagentValue(change[key])]))
        const truncation = { truncated: old?.truncation.truncated === true || Object.values(values).some(value => value.truncation.truncated),
          originalBytes: Object.values(values).reduce((total, value) => total + value.truncation.originalBytes, 0) }
        await writeItem(sql, kind, RunSubagentToolSchema.parse({ ...old, ...base, nativeToolId: change.nativeToolId,
          name: change.name ?? old?.name ?? 'Tool', status: change.status,
          ...(change.nativeMessageId ? { nativeMessageId: change.nativeMessageId } : {}), ...(change.parentToolUseId ? { parentToolUseId: change.parentToolUseId } : {}),
          ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.value])),
          startedAt: old?.startedAt ?? (change.status === 'running' ? event.occurredAt : null), finishedAt: terminal(change.status) ? event.occurredAt : old?.finishedAt ?? null,
          ...(change.durationMs !== undefined ? { durationMs: change.durationMs } : {}), truncation }))
        next.coverage.tools = 'partial'
        if (truncation.truncated) next.coverage.gaps = true
      }
    }
    await writeChild(sql, next)
    await sql.query('insert into run_subagent_sources(subagent_id,execution_id,sequence,digest) values($1,$2,$3,$4)', [child.id, event.executionId, event.sequence, digest])
  }
}
