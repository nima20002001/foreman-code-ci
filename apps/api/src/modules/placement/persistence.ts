import { DispatchIntentSchema, type AcceptedNodePlacement, type DispatchIntent, type NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { canonicalGraphJson, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { DomainError } from '../errors.js'
import type { PlacementCommitFence } from './admission.js'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { sourceMaterializationDigest } from '../sources/bindingHash.js'
import { readNativeExecutionBinding } from './executionBinding.js'
import { readPlacement } from './binding.js'

const conflict = (): never => { throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Immutable placement or dispatch evidence conflicts.', 409) }
/** Start calls this on the SAME transaction as Run, canonical receipt and command
 * receipt. It returns no native-entry capability and publishes no wakeup. */
export async function insertAcceptedPlacements(sql: GraphTransactionSql, runId: string,
  nodes: readonly { id: string; agentId: string }[], configurationIds: Readonly<Record<string, string>>,
  placements: readonly AcceptedNodePlacement[], fence: PlacementCommitFence): Promise<void> {
  assertGraphTransaction(sql)
  if (placements.length !== nodes.length || new Set(placements.map((p) => p.nodeId)).size !== nodes.length) conflict()
  const pins = placements.map(readPlacement)
  for (const pin of pins) {
    const node = nodes.find((node) => node.id === pin.nodeId)
    if (pin.runId !== runId || !node || pin.payload.kind !== 'agent' || pin.payload.agentId !== node.agentId
      || pin.payload.agentConfigurationVersionId !== configurationIds[node.agentId]) conflict()
  }
  const assertCurrent = async () => {
    if (fence.assertAllCurrent) return fence.assertAllCurrent(pins)
    for (const pin of pins) await fence.assertCurrent(pin)
  }
  await assertCurrent()
  if (pins.length) {
    await sql.query(`insert into run_node_placements(run_id,node_id,binding_hash,record)
      select $1,p.node_id,p.binding_hash,p.record::jsonb
      from unnest($2::text[],$3::text[],$4::text[]) with ordinality as p(node_id,binding_hash,record,ordinal)
      order by p.ordinal`,
    [runId, pins.map(pin => pin.nodeId), pins.map(pin => pin.bindingHash), pins.map(pin => canonicalGraphJson(pin))])
  }
  beforeGraphCommit(sql, async () => {
    await assertCurrent()
    const rows = await sql.query<{ record: unknown }>('select record from run_node_placements where run_id=$1 order by node_id', [runId])
    if (!sameWorkflowValue(rows.rows.map((r) => readPlacement(r.record)), [...pins].sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))) conflict()
  })
}
export async function readAcceptedPlacement(sql: Pick<GraphTransactionSql, 'query'>, runId: string, nodeId: string): Promise<AcceptedNodePlacement | undefined> {
  const rows = await sql.query<{ record: unknown }>('select record from run_node_placements where run_id=$1 and node_id=$2', [runId, nodeId])
  const row = rows.rows[0]
  if (!row) return undefined
  const pin = readPlacement(row.record)
  if (pin.runId !== runId || pin.nodeId !== nodeId || rows.rows.length !== 1) conflict()
  return pin
}

/** Read only the selected nodes; unrelated placements cannot affect this batch. */
export async function readAcceptedPlacements(sql: Pick<GraphTransactionSql, 'query'>,
  runId: string, nodeIds: readonly string[]): Promise<Map<string, AcceptedNodePlacement>> {
  const rows = await sql.query<{ node_id: string; binding_hash: string; record: unknown }>(
    'select node_id,binding_hash,record from run_node_placements where run_id=$1 and node_id=any($2::text[])',
    [runId, [...new Set(nodeIds)]])
  const result = new Map<string, AcceptedNodePlacement>()
  for (const row of rows.rows) {
    const pin = readPlacement(row.record)
    if (pin.runId !== runId || pin.nodeId !== row.node_id || pin.bindingHash !== row.binding_hash
      || result.has(row.node_id)) conflict()
    result.set(row.node_id, pin)
  }
  return result
}

export async function readRunAcceptedPlacements(sql: Pick<GraphTransactionSql, 'query'>,
  runId: string): Promise<AcceptedNodePlacement[]> {
  const rows = await sql.query<{ node_id: string; binding_hash: string; record: unknown }>(
    'select node_id,binding_hash,record from run_node_placements where run_id=$1 order by node_id', [runId])
  return rows.rows.map(row => {
    const pin = readPlacement(row.record)
    if (pin.runId !== runId || pin.nodeId !== row.node_id || pin.bindingHash !== row.binding_hash) conflict()
    return pin
  })
}
/** Called with execution admission on the existing Run owner transaction. Intent
 * membership is NOT the one-use native launch permission; existing launch guards
 * and live destination revalidation are still required before submission. */
export async function insertDispatchIntent(sql: GraphTransactionSql, owner: RunOwnership,
  raw: DispatchIntent, fence: PlacementCommitFence): Promise<DispatchIntent> {
  assertGraphTransaction(sql)
  owner.assertOwned()
  const intent = DispatchIntentSchema.parse(raw)
  if (owner.runId !== intent.runId) conflict()
  const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!placement || placement.bindingHash !== intent.bindingHash || placement.mainId !== intent.mainId) conflict()
  await fence.assertCurrent(placement!)
  const existing = await sql.query<{ record: unknown }>('select record from execution_dispatch_intents where operation_id=$1', [intent.operationId])
  if (existing.rows.length) {
    if (existing.rows.length !== 1 || !sameWorkflowValue(DispatchIntentSchema.parse(existing.rows[0]?.record), intent)) conflict()
    return intent
  }
  const scheduler = await owner.readOneShotFence(sql)
  await sql.query(`insert into execution_dispatch_intents(operation_id,execution_id,run_id,node_id,binding_hash,
    attempt_id,record,scheduler_owner_id,scheduler_owner_fence) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    on conflict(operation_id) do nothing`, [intent.operationId, intent.executionId, intent.runId, intent.nodeId,
    intent.bindingHash, intent.attemptId, canonicalGraphJson(intent), scheduler.ownerId, scheduler.fence])
  const verify = async () => {
    owner.assertOwned()
    await owner.readOneShotFence(sql)
    await fence.assertCurrent(placement!)
    const rows = await sql.query<{ record: unknown }>('select record from execution_dispatch_intents where operation_id=$1', [intent.operationId])
    if (rows.rows.length !== 1 || !sameWorkflowValue(DispatchIntentSchema.parse(rows.rows[0]?.record), intent)) conflict()
  }
  await verify()
  beforeGraphCommit(sql, verify)
  return intent
}

/** Immutable evidence read only. Callers still authorize the live owner/grant
 * before publishing artifacts or control; a receipt is not a delegation. */
export async function readDispatchIntent(sql: Pick<GraphTransactionSql, 'query'>, executionId: string): Promise<DispatchIntent | undefined> {
  const rows = await sql.query<{ operation_id: string; execution_id: string; run_id: string; node_id: string;
    binding_hash: string; attempt_id: string; record: unknown }>(`select operation_id,execution_id,run_id,node_id,
      binding_hash,attempt_id,record from execution_dispatch_intents where execution_id=$1`, [executionId])
  const row = rows.rows[0]
  if (!row) return undefined
  const intent = DispatchIntentSchema.parse(row.record)
  if (rows.rows.length !== 1 || intent.operationId !== row.operation_id || intent.executionId !== executionId
    || intent.executionId !== row.execution_id || intent.runId !== row.run_id || intent.nodeId !== row.node_id
    || intent.bindingHash !== row.binding_hash || intent.attemptId !== row.attempt_id) conflict()
  const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!placement || placement.bindingHash !== intent.bindingHash || placement.mainId !== intent.mainId) conflict()
  return intent
}

/** Accepted root/source envelope for an exact admitted execution. Native
 * materialization is read separately and may not exist for an unstarted node. */
export async function readExecutionPlacement(sql: Pick<GraphTransactionSql, 'query'>, executionId: string): Promise<AcceptedNodePlacement | undefined> {
  const intent = await readDispatchIntent(sql, executionId)
  return intent ? readAcceptedPlacement(sql, intent.runId, intent.nodeId) : undefined
}

export async function readExecutionPlacements(sql: Pick<GraphTransactionSql, 'query'>,
  executionIds: readonly string[]): Promise<Map<string, AcceptedNodePlacement>> {
  const rows = await sql.query<{ operation_id: string; execution_id: string; run_id: string; node_id: string;
    binding_hash: string; attempt_id: string; record: unknown; placement: unknown }>(`
    select i.operation_id,i.execution_id,i.run_id,i.node_id,i.binding_hash,i.attempt_id,i.record,p.record as placement
    from execution_dispatch_intents i left join run_node_placements p on p.run_id=i.run_id and p.node_id=i.node_id
    where i.execution_id=any($1::text[]) order by i.execution_id`, [[...executionIds]])
  const result = new Map<string, AcceptedNodePlacement>()
  for (const row of rows.rows) {
    const intent = DispatchIntentSchema.parse(row.record)
    const placement = readPlacement(row.placement)
    if (result.has(row.execution_id) || intent.operationId !== row.operation_id || intent.executionId !== row.execution_id
      || intent.runId !== row.run_id || intent.nodeId !== row.node_id || intent.bindingHash !== row.binding_hash
      || intent.attemptId !== row.attempt_id || placement.runId !== intent.runId || placement.nodeId !== intent.nodeId
      || placement.bindingHash !== intent.bindingHash || placement.mainId !== intent.mainId) conflict()
    result.set(row.execution_id, placement)
  }
  return result
}

export async function readNativePlacement(sql: Pick<GraphTransactionSql, 'query'>, executionId: string) {
  const row = (await sql.query<{ record: unknown }>('select record from execution_native_placements where execution_id=$1', [executionId])).rows[0]
  if (!row) return undefined
  const intent = await readDispatchIntent(sql, executionId)
  const parent = intent && await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!intent || !parent) conflict()
  const binding = readNativeExecutionBinding(parent!, intent!, row.record)
  // Read the actual adopted source fact; never invent adoption from a digest.
  const sourceRow = (await sql.query<{ record: unknown; state: string }>('select record,state from source_execution_materializations where materialization_id=$1', [binding.materialization.receipt.materializationId])).rows[0]
  if (!sourceRow) conflict()
  const storedSource = SourceMaterializationRecordSchema.parse(sourceRow!.record)
  const source = SourceMaterializationRecordSchema.parse({ ...storedSource, state: sourceRow!.state })
  if (source.finalDispatchBindingHash !== binding.bindingHash || sourceMaterializationDigest(source) !== sourceMaterializationDigest(binding.materialization)) conflict()
  return { ...binding, materialization: source }
}
export async function insertNativePlacement(sql: GraphTransactionSql, owner: RunOwnership, binding: NativeExecutionPlacement): Promise<void> {
  assertGraphTransaction(sql); owner.assertOwned()
  const intent = await readDispatchIntent(sql, binding.executionId)
  const parent = intent && await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!intent || !parent || owner.runId !== intent.runId) conflict()
  const current = readNativeExecutionBinding(parent!, intent!, binding)
  await owner.readOneShotFence(sql)
  await sql.query(`insert into execution_native_placements(execution_id,operation_id,accepted_binding_hash,binding_hash,record)
    values($1,$2,$3,$4,$5::jsonb)`, [current.executionId, current.operationId, current.acceptedBindingHash, current.bindingHash, canonicalGraphJson(current)])
  beforeGraphCommit(sql, async () => { owner.assertOwned(); await owner.readOneShotFence(sql)
    const persisted = await readNativePlacement(sql, current.executionId)
    if (!persisted || persisted.bindingHash !== current.bindingHash) conflict() })
}
