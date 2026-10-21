import { createFixtureDatabase, dropFixtureDatabase } from './helpers/testResources.js'
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { canonicalGraphJson, type GraphExecutionIdentity, type RepeatOccurrenceV1 } from '@foreman-code/contracts/wave25'
import { migrations } from '../src/infrastructure/migrations.js'
import { repeatOccurrenceMigration } from '../src/infrastructure/repeatOccurrenceMigration.js'

export type Sql = Pick<pg.PoolClient, 'query'>
export type JsonObject = Record<string, unknown>
export const evidenceTables = [
  'run_repeat_occurrences', 'run_repeat_slots', 'run_repeat_executions', 'run_repeat_results',
  'run_repeat_bindings', 'run_repeat_resolutions', 'run_repeat_decisions', 'run_repeat_effects',
] as const
export const now = '2026-09-25T00:00:00.000Z'
export function text(value: unknown): string { return canonicalGraphJson(value, 4 * 1024 * 1024) }
export function digest(value: unknown): string { return `sha256:${createHash('sha256').update(text(value)).digest('hex')}` }

/** Create a fresh database from the integration runner's validated test URL.
 * The parent connection is used only for creation, deletion, and version inspection.
 */
export async function disposableDatabase<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const configured = process.env.TEST_DATABASE_URL
  assert.ok(configured, 'TEST_DATABASE_URL is required for PostgreSQL integration tests')
  const url = new URL(configured)
  const parentDatabase = decodeURIComponent(url.pathname.slice(1))
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && /(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(parentDatabase)
    && !url.search && !url.hash,
  'Use a loopback PostgreSQL database explicitly named for tests')
  const database = `eng04_test_migration_${randomBytes(12).toString('hex')}`
  assert.match(database, /^eng04_test_migration_[a-f0-9]{24}$/)
  const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 10_000 })
  let pool: pg.Pool | undefined
  let created = false
  try {
    await admin.connect()
    const version = await admin.query<{ server_version_num: string }>('show server_version_num')
    const number = Number(version.rows[0]?.server_version_num)
    assert.ok(number >= 170000 && number < 180000, 'Run this qualification on the pinned PostgreSQL 17 major')
    await createFixtureDatabase(admin, database, "template template0 encoding 'UTF8'")
    created = true
    url.pathname = `/${database}`
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 10_000 })
    const actual = await pool.query<{ name: string }>('select current_database() as name')
    assert.equal(actual.rows[0]?.name, database)
    return await work(pool)
  } finally {
    try {
      if (pool) await pool.end()
      // No FORCE: a leaked connection is a test failure, not permission to kill
      // sessions. The generated name is the only database this helper can drop.
      if (created) await dropFixtureDatabase(admin, database)
    } finally { await admin.end() }
  }
}

export async function transaction<T>(pool: pg.Pool, work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
}

/** Historical migration setup only; no retired execution records are seeded. */
export async function installPreRepeatRegistry(pool: pg.Pool): Promise<void> {
  await transaction(pool, async (sql) => {
    await sql.query('select pg_advisory_xact_lock($1)', [810_001])
    for (const migration of migrations) {
      if (migration.version === repeatOccurrenceMigration.version) break
      await sql.query(migration.sql)
      await sql.query('insert into application_migrations(version) values($1)', [migration.version])
    }
  })
}

export interface RunFixture {
  id: string
  workspaceId: string
  workflowId: string
  versionId: string
  semantics: 3
  version: JsonObject
  record: JsonObject
  cap: number
  agentIds: Record<string, string>
  configIds: Record<string, string>
}

/** SQL-level fixtures are intentionally not native/admission fixtures. They
 * include the exact columns/JSON pins the migration consumes; no launch, owner,
 * approval acknowledgement or native closure is simulated by these inserts.
 */
export async function seedRun(sql: Sql, id: string, semantics: 3 = 3,
  options: { cap?: number; versionPatch?: (version: JsonObject) => void } = {}): Promise<RunFixture> {
  const workspaceId = `${id}-workspace`, workflowId = `${id}-workflow`, versionId = `${id}-version`
  const agentIds = { body: `${id}-body-agent`, outside: `${id}-outside-agent`, other: `${id}-other-agent` }
  const configIds = Object.fromEntries(Object.entries(agentIds).map(([node, agent]) => [node, `${agent}-config`]))
  const pins = Object.fromEntries(Object.entries(agentIds).map(([node, agent]) => [agent, configIds[node]]))
  const cap = options.cap ?? 2
  const choice = { outcomes: [
    { outcome: 'pass', target: { kind: 'branch_end' } },
    { outcome: 'issues', target: { kind: 'branch_end' } },
  ] }
  const definition = {
    id: workflowId, workspaceId, version: 1, entryNodeId: 'body', executionSemanticsVersion: semantics,
    nodes: Object.entries(agentIds).map(([nodeId, agentId]) => ({ id: nodeId, agentId,
      ...(nodeId === 'outside' ? {} : { choice }) })),
    edges: [],
    ...(semantics === 3 ? { repeat: { contractVersion: 1, blocks: [
      { id: 'block', nodeIds: ['body'], entryNodeId: 'body', exitNodeId: 'body', maxOccurrences: cap,
        repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } },
      { id: 'other-block', nodeIds: ['other'], entryNodeId: 'other', exitNodeId: 'other', maxOccurrences: cap,
        repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } },
    ] } } : {}),
  }
  const version: JsonObject = { id: versionId, workspaceId, workflowId, version: 1, entryNodeId: 'body',
    definition, agentConfigurationVersionIds: pins, executionSemanticsVersion: semantics }
  options.versionPatch?.(version)
  const record: JsonObject = { id, workspaceId, workflowId, workflowVersionId: versionId,
    agentConfigurationVersionIds: pins, input: { prompt: 'migration fixture' },
    executionState: 'running', outcome: 'pending', executionSemanticsVersion: semantics }
  await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, text({ id: workspaceId })])
  await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)', [workflowId, workspaceId, text({ id: workflowId, workspaceId })])
  for (const [nodeId, agentId] of Object.entries(agentIds)) {
    await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)', [agentId, workspaceId, text({ id: agentId, workspaceId })])
    await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
      values($1,$2,$3,1,$4::jsonb)`, [configIds[nodeId], workspaceId, agentId, text({ id: configIds[nodeId], workspaceId, agentId })])
  }
  await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
    values($1,$2,$3,1,'body',$4,$5::jsonb)`, [versionId, workspaceId, workflowId, semantics, text(version)])
  await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
    values($1,$2,$3,$4,'running',$5::jsonb)`, [id, workspaceId, workflowId, versionId, text(record)])
  return { id, workspaceId, workflowId, versionId, semantics, version, record, cap, agentIds, configIds }
}

export interface OccurrenceFixture {
  id: string
  run: RunFixture
  blockId: string
  index: number
  record: RepeatOccurrenceV1
  input: JsonObject
}
export interface DecisionFixture {
  id: string
  record: JsonObject
  execution: ExecutionFixture
  accepted: JsonObject
}
export function occurrence(run: RunFixture, index = 1, previous?: DecisionFixture,
  blockId = 'block', id = `${run.id}-${blockId}-occ-${index}`): OccurrenceFixture {
  const input = { runInput: run.record.input, external: [], carry: previous ? {
    decisionId: previous.id, execution: previous.execution.identity,
    acceptedResultDigest: digest(previous.accepted), acceptedResult: previous.accepted,
  } : null }
  const record: RepeatOccurrenceV1 = { contractVersion: 1, identity: {
    scope: { workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: run.versionId,
      runId: run.id, executionSemanticsVersion: 3 }, blockId, occurrenceId: id, occurrenceIndex: index,
  }, input: { bindingId: `${id}-input`, inputDigest: digest(input), previous: previous ? {
    occurrenceId: previous.execution.occurrence!.id, occurrenceIndex: index - 1,
    decisionId: previous.id, acceptedResultDigest: digest(previous.accepted),
  } : null } }
  return { id, run, blockId, index, record, input }
}
export async function insertOccurrence(sql: Sql, value: OccurrenceFixture): Promise<void> {
  const prior = value.record.input.previous
  await sql.query(`insert into run_repeat_occurrences
    (occurrence_id,run_id,workspace_id,workflow_id,workflow_version_id,block_id,occurrence_index,binding_id,input_json,input_digest,
     previous_occurrence_id,previous_occurrence_index,previous_decision_id,previous_result_digest,record)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
  [value.id, value.run.id, value.record.identity.scope.workspaceId, value.record.identity.scope.workflowId,
    value.record.identity.scope.workflowVersionId, value.blockId, value.index, value.record.input.bindingId,
    text(value.input), value.record.input.inputDigest, prior?.occurrenceId ?? null, prior?.occurrenceIndex ?? null,
    prior?.decisionId ?? null, prior?.acceptedResultDigest ?? null, text(value.record)])
}

export interface ExecutionFixture {
  id: string
  run: RunFixture
  nodeId: string
  slotId: string
  occurrence: OccurrenceFixture | null
  identity: GraphExecutionIdentity & { occurrence?: RepeatOccurrenceV1['identity'] }
  input: JsonObject
  record: JsonObject
  previousExecutionId: string | null
}
export function execution(run: RunFixture, occ: OccurrenceFixture | null, options: {
  id?: string; nodeId?: string; attempt?: number; previous?: ExecutionFixture; input?: JsonObject
} = {}): ExecutionFixture {
  const nodeId = options.nodeId ?? (occ ? occ.blockId === 'other-block' ? 'other' : 'body' : 'outside')
  const attempt = options.attempt ?? 1, id = options.id ?? `${occ?.id ?? run.id}-${nodeId}-exec-${attempt}`
  const identity = { executionId: id, workflowNodeId: nodeId, agentId: run.agentIds[nodeId]!,
    agentConfigurationVersionId: run.configIds[nodeId]!, attempt, ...(occ ? { occurrence: occ.record.identity } : {}) }
  const input = options.input ?? { executionSemanticsVersion: 3, runInput: run.record.input,
    occurrence: occ?.record ?? null, entry: occ?.input ?? null, predecessors: [] }
  const record = { id, runId: run.id, workflowNodeId: nodeId, agentId: identity.agentId,
    agentConfigurationVersionId: identity.agentConfigurationVersionId, attempt, state: 'queued', input }
  return { id, run, nodeId, slotId: `${occ?.id ?? run.id}-${nodeId}-slot`, occurrence: occ, identity, input,
    record, previousExecutionId: options.previous?.id ?? null }
}
export async function insertExecution(sql: Sql, value: ExecutionFixture, newSlot = true): Promise<void> {
  assert(value.identity.kind !== 'job', 'harness execution fixture requires an Agent identity')
  if (newSlot) await sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest)
    values($1,$2,$3,$4,$5,$6)`, [value.slotId, value.run.id, value.occurrence?.id ?? null, value.nodeId, text(value.input), digest(value.input)])
  await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,record)
    values($1,$2,$3,$4,$5,$6,$7::jsonb)`, [value.id, value.run.id, value.nodeId, value.identity.agentId,
    value.identity.attempt, value.occurrence?.id ?? null, text(value.record)])
  await sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,occurrence_id,technical_attempt,previous_execution_id,identity)
    values($1,$2,$3,$4,$5,$6,$7::jsonb)`, [value.id, value.run.id, value.slotId, value.occurrence?.id ?? null,
    value.identity.attempt, value.previousExecutionId, text(value.identity)])
  const sources: Array<{ kind: string; source: JsonObject }> = (value.input.predecessors as JsonObject[])
    .map((source) => ({ kind: 'predecessor', source }))
  const entry = value.input.entry as JsonObject | null
  if (entry) {
    sources.push(...(entry.external as JsonObject[]).map((source) => ({ kind: 'external', source })))
    if (entry.carry) sources.push({ kind: 'carry', source: entry.carry as JsonObject })
  }
  const { occurrence: _occurrence, ...recipient } = value.identity
  void _occurrence
  for (const [ordinal, item] of sources.entries()) {
    const bindingId = `${value.id}-binding-${ordinal}`
    const binding = { bindingId, recipient, recipientOccurrence: value.occurrence?.record.identity ?? null,
      inputDigest: digest(value.input), source: item.source, kind: item.kind, ordinal }
    await sql.query(`insert into run_repeat_bindings(binding_id,run_id,recipient_execution_id,source_execution_id,
      source_result_digest,input_digest,slot_id,ordinal,record) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [bindingId, value.run.id, value.id, (item.source.execution as JsonObject).executionId,
      item.source.acceptedResultDigest, digest(value.input), value.slotId, ordinal, text(binding)])
  }
}

export function acceptedResult(outcome: 'issues' | 'pass' = 'issues', carrier: 'object' | 'string' | 'text' = 'object'): JsonObject {
  const envelope = { routing: { outcome }, data: { latestDeliverable: { revision: 1, text: 'retained exact output' }, remainingFindings: [{ id: 'f1' }] } }
  return { outcome: 'succeeded', output: carrier === 'object' ? envelope : carrier === 'string' ? text(envelope) : { text: text(envelope) } }
}
export async function acceptResult(sql: Sql, value: ExecutionFixture, accepted: JsonObject): Promise<void> {
  await sql.query('update harness_executions set record=$2::jsonb where id=$1',
    [value.id, text({ ...value.record, state: 'completed', result: accepted, finishedAt: now })])
  // Deliberately reproduce the actual repository ordering. Deferred verification
  // must not reject the insertion merely because accepted is set one query later.
  await sql.query(`insert into run_repeat_results(execution_id,run_id,occurrence_id,result_json,result_digest,accepted_at)
    values($1,$2,$3,$4,$5,$6)`, [value.id, value.run.id, value.occurrence?.id ?? null, text(accepted), digest(accepted), now])
  await sql.query('update harness_executions set accepted=true where id=$1', [value.id])
}
export function decision(value: ExecutionFixture, accepted: JsonObject, outcome: 'issues' | 'pass'): DecisionFixture {
  assert.ok(value.occurrence)
  const id = `${value.id}-decision`, reason = outcome === 'pass' ? 'early_exit' : value.occurrence.index === value.run.cap ? 'limit_exit' : 'repeat'
  const target = reason === 'repeat' ? { kind: 'next_occurrence', entryNodeId: value.nodeId, occurrenceIndex: value.occurrence.index + 1 } : { kind: 'branch_end' }
  let envelope = accepted.output as JsonObject | string
  if (typeof envelope === 'string') envelope = JSON.parse(envelope) as JsonObject
  else if (typeof envelope.text === 'string') envelope = JSON.parse(envelope.text) as JsonObject
  return { id, execution: value, accepted, record: { contractVersion: 1, decisionId: id, occurrence: value.occurrence.record,
    exitExecution: value.identity, acceptedResultDigest: digest(accepted), outcome, reason, target, decidedAt: now, resultData: envelope.data } }
}
export async function insertResolution(sql: Sql, value: ExecutionFixture, accepted: JsonObject, exported = false,
  outcome: 'issues' | 'pass' = 'issues'): Promise<void> {
  const { occurrence: _occurrence, ...identity } = value.identity
  void _occurrence
  const record = { ref: { nodeId: value.nodeId, occurrence: value.occurrence?.record.identity ?? null },
    value: { workflowNodeId: value.nodeId, resolution: 'succeeded', execution: identity,
      acceptedResultDigest: digest(accepted), selectedRelationshipIds: [], unselectedRelationshipIds: [],
      branchEnded: true, outcome, resolvedAt: now }, deferredRelationshipIds: [] }
  await sql.query(`insert into run_repeat_resolutions(run_id,occurrence_key,workflow_node_id,source_occurrence_id,execution_id,record)
    values($1,$2,$3,$4,$5,$6::jsonb)`, [value.run.id, exported ? '' : value.occurrence?.id ?? '', value.nodeId,
    value.occurrence?.id ?? null, value.id, text(record)])
}
export async function insertDecision(sql: Sql, value: DecisionFixture): Promise<void> {
  await sql.query(`insert into run_repeat_decisions(decision_id,occurrence_id,exit_execution_id,result_digest,record)
    values($1,$2,$3,$4,$5::jsonb)`, [value.id, value.execution.occurrence!.id, value.execution.id, digest(value.accepted), text(value.record)])
}
export async function finishOccurrence(sql: Sql, value: ExecutionFixture, outcome: 'issues' | 'pass' = 'issues',
  carrier: 'object' | 'string' | 'text' = 'object'): Promise<{ decision: DecisionFixture; successor: OccurrenceFixture | null }> {
  const accepted = acceptedResult(outcome, carrier), route = decision(value, accepted, outcome)
  await acceptResult(sql, value, accepted)
  await insertResolution(sql, value, accepted, false, outcome)
  await insertDecision(sql, route)
  let successor: OccurrenceFixture | null = null
  if (route.record.reason === 'repeat') {
    successor = occurrence(value.run, value.occurrence!.index + 1, route, value.occurrence!.blockId)
    await insertOccurrence(sql, successor)
  } else await insertResolution(sql, value, accepted, true, outcome)
  await sql.query(`insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence)
    values($1,'terminal.accept',$2,$3,'sql-fixture-owner','1')`, [value.run.id, value.id, digest(route.record)])
  return { decision: route, successor }
}
